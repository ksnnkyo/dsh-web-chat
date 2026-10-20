import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Host half of the DeepSeek web session bundle.
 *
 * The client lives in the embedded browser. This half exists for one thing: read the
 * conversation list of the DSH web-login account without opening the page first, and
 * expose it to the client through a same-origin route. The token never leaves the
 * machine and is never logged.
 */

const API_PREFIX = '/dsh-deepseek-webdesk/api';
const DEEPSEEK_ORIGIN = 'https://chat.deepseek.com';
const SESSION_LIST_PATH = '/api/v0/chat_session/fetch_page';
const CACHE_TTL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_SESSIONS = 60;

export const name = 'dsh-deepseek-webdesk';
export const inject = ['webServer'];

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function webLoginDir() {
  return join(dshHome(), 'web-login');
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function listAccounts() {
  const dir = join(webLoginDir(), 'accounts');
  if (!existsSync(dir)) return [];
  const rows = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const row = readJsonFile(join(dir, file));
    if (row && typeof row.id === 'string' && typeof row.token === 'string' && row.token !== '') rows.push(row);
  }
  return rows;
}

/** The account the DSH web-login plugin currently uses; falls back to the first usable token. */
function activeAccount() {
  const rows = listAccounts();
  if (rows.length === 0) return null;
  const meta = readJsonFile(join(webLoginDir(), 'accounts.json')) ?? {};
  const activeId = typeof meta.activeId === 'string' ? meta.activeId : '';
  return rows.find((row) => row.id === activeId) ?? rows[0];
}

function requestHeaders(account) {
  const headers = { accept: 'application/json' };
  if (typeof account.userAgent === 'string' && account.userAgent !== '') headers['user-agent'] = account.userAgent;
  headers.authorization = 'Bearer ' + account.token;
  if (typeof account.cookie === 'string' && account.cookie !== '') headers.cookie = account.cookie;
  if (typeof account.hifLeim === 'string' && account.hifLeim !== '') headers['x-hif-leim'] = account.hifLeim;
  if (typeof account.hifDliq === 'string' && account.hifDliq !== '') headers['x-hif-dliq'] = account.hifDliq;
  const extra = account.extraHeaders;
  if (extra !== null && typeof extra === 'object') {
    for (const [key, value] of Object.entries(extra)) {
      if (typeof key === 'string' && key !== '' && typeof value === 'string' && value !== '') headers[key.toLowerCase()] = value;
    }
  }
  return headers;
}

/** Normalize one `fetch_page` payload; exported for tests. */
export function normalizeSessions(payload) {
  const biz =
    payload !== null && typeof payload === 'object' && payload.data !== null && typeof payload.data === 'object'
      ? payload.data.biz_data
      : undefined;
  if (biz === null || typeof biz !== 'object' || !Array.isArray(biz.chat_sessions)) {
    throw new Error('unexpected DeepSeek session response');
  }
  const sessions = [];
  for (const raw of biz.chat_sessions) {
    if (raw === null || typeof raw !== 'object') continue;
    if (typeof raw.id !== 'string' || raw.id === '') continue;
    const title = typeof raw.title === 'string' && raw.title.trim() !== '' ? raw.title.trim().slice(0, 160) : '未命名会话';
    const updated = Number(raw.updated_at);
    sessions.push({
      id: raw.id.slice(0, 64),
      title,
      pinned: raw.pinned === true,
      updatedAt: Number.isFinite(updated) ? updated : 0,
    });
    if (sessions.length >= MAX_SESSIONS) break;
  }
  return { sessions, hasMore: biz.has_more === true };
}

let cache = { at: 0, value: null };
let inflight = null;

/**
 * Read the signed-in web account's conversation list. Returns a plain object even on
 * failure so the client can render a useful empty state.
 */
export async function listWebSessions(count) {
  const now = Date.now();
  if (cache.value !== null && now - cache.at < CACHE_TTL_MS) return cache.value;
  if (inflight !== null) return inflight;
  const account = activeAccount();
  if (account === null) {
    return { ok: false, error: 'not-signed-in', sessions: [], hasMore: false };
  }
  const limitSource = Number(count);
  const limit = Number.isFinite(limitSource) ? Math.max(1, Math.min(MAX_SESSIONS, Math.floor(limitSource))) : 30;
  inflight = (async () => {
    try {
      const response = await fetch(DEEPSEEK_ORIGIN + SESSION_LIST_PATH + '?count=' + limit, {
        headers: requestHeaders(account),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload === null || payload.code !== 0) {
        return {
          ok: false,
          error:
            payload !== null && typeof payload.msg === 'string' && payload.msg !== ''
              ? payload.msg
              : 'http-' + response.status,
          sessions: [],
          hasMore: false,
        };
      }
      const normalized = normalizeSessions(payload);
      const value = {
        ok: true,
        sessions: normalized.sessions,
        hasMore: normalized.hasMore,
        account: account.id,
        at: new Date().toISOString(),
      };
      cache = { at: Date.now(), value };
      return value;
    } catch (error) {
      return {
        ok: false,
        error:
          error !== null && typeof error === 'object' && typeof error.message === 'string'
            ? error.message.slice(0, 200)
            : 'request-failed',
        sessions: [],
        hasMore: false,
      };
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        chunks.length = 0;
        resolve(undefined);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', () => resolve(undefined));
  });
}

async function callSessionApi(account, path, body) {
  const response = await fetch(DEEPSEEK_ORIGIN + path, {
    method: 'POST',
    headers: { ...requestHeaders(account), 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload === null) return { ok: false, error: 'http-' + response.status };
  const bizCode = payload.data !== null && typeof payload.data === 'object' ? payload.data.biz_code : undefined;
  if (bizCode !== undefined && bizCode !== 0) return { ok: false, error: 'biz-' + bizCode };
  return { ok: true };
}

function sendJson(res, status, body) {
  try {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(body));
  } catch {
    /* the response may already be gone */
  }
}

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
          const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1');
          const route = url.pathname.slice(API_PREFIX.length) || '/';
          try {
            if (req.method === 'GET' && (route === '/sessions' || route === '/sessions/')) {
              const count = Number(url.searchParams.get('count'));
              sendJson(res, 200, await listWebSessions(count));
              return;
            }
            if (req.method === 'POST' && (route === '/sessions/delete' || route === '/sessions/delete/')) {
              const account = activeAccount();
              if (account === null) {
                sendJson(res, 200, { ok: false, error: 'not-signed-in' });
                return;
              }
              const body = await readJsonBody(req);
              const id = body !== null && typeof body === 'object' && typeof body.id === 'string' ? body.id : '';
              if (id === '') {
                sendJson(res, 400, { ok: false, error: 'invalid-id' });
                return;
              }
              const result = await callSessionApi(account, '/api/v0/chat_session/delete', { chat_session_ids: [id] });
              cache = { at: 0, value: null };
              sendJson(res, result.ok ? 200 : 502, result);
              return;
            }
            if (req.method === 'POST' && (route === '/sessions/pin' || route === '/sessions/pin/')) {
              const account = activeAccount();
              if (account === null) {
                sendJson(res, 200, { ok: false, error: 'not-signed-in' });
                return;
              }
              const body = await readJsonBody(req);
              const id = body !== null && typeof body === 'object' && typeof body.id === 'string' ? body.id : '';
              const pinned = body !== null && typeof body === 'object' && body.pinned === true;
              if (id === '') {
                sendJson(res, 400, { ok: false, error: 'invalid-id' });
                return;
              }
              const result = await callSessionApi(account, '/api/v0/chat_session/batch_update_pinned', {
                chat_session_ids: [id],
                pinned,
              });
              cache = { at: 0, value: null };
              sendJson(res, result.ok ? 200 : 502, result);
              return;
            }
            sendJson(res, 404, { ok: false, error: 'unknown route' });
          } catch (error) {
            sendJson(res, 500, {
              ok: false,
              error:
                error !== null && typeof error === 'object' && typeof error.message === 'string'
                  ? error.message
                  : String(error),
            });
          }
        },
      }),
    'dsh-deepseek-webdesk: api',
  );
}
