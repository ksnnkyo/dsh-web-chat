import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { normalizeSessions } from '../index.js';
const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
function api(fetch) {
  const context = vm.createContext({ fetch, normalizeSessions, AbortSignal,
    DEEPSEEK_ORIGIN: 'https://chat.deepseek.com', SESSION_LIST_PATH: '/api/v0/chat_session/fetch_page', CACHE_TTL_MS: 5000, REQUEST_TIMEOUT_MS: 12000, MAX_SESSIONS: 60,
    cache: { at: 0, value: null }, inflight: new Map(),
    requestHeaders: account => ({ authorization: account.token }), credentialCandidates: () => [{ token: 'old' }, { token: 'fresh' }],
  });
  for (const name of ['isTokenRejection', 'callSessionApi', 'callSessionApiWithCandidates', 'listWebSessions']) {
    const match = source.match(new RegExp('(?:export )?(?:async )?function ' + name + '\\([^]*?\\n}'));
    vm.runInContext(match[0].replace(/^export /, ''), context);
  }
  return context;
}
const response = payload => ({ ok: true, status: 200, json: async () => payload });
const page = count => response({ code: 0, data: { biz_data: { has_more: true, chat_sessions: Array.from({ length: count }, (_, i) => ({ id: 's' + i, title: '会话' + i })) } } });

test('HTTP 200 token rejection is a failed mutation and retries with the next credential', async () => {
  const tokens = [];
  const context = api(async (_url, options) => { tokens.push(options.headers.authorization); return response(tokens.length === 1 ? { code: 40003, msg: 'INVALID_TOKEN', data: null } : { code: 0, data: { biz_code: 0 } }); });
  const result = await context.callSessionApiWithCandidates('/delete', {});
  assert.equal(result.ok, true);
  assert.deepEqual(tokens, ['old', 'fresh']);
});
test('non-token application errors and malformed successes are not accepted as successful mutations', async () => {
  for (const payload of [{ code: 50001, msg: 'denied' }, {}, null]) {
    const result = await api(async () => response(payload)).callSessionApi({ token: 'fixture' }, '/pin', {});
    assert.equal(result.ok, false);
  }
});
test('cached pages do not satisfy larger pagination requests', async () => {
  const counts = [];
  const context = api(async url => { const count = Number(new URL(url).searchParams.get('count')); counts.push(count); return page(count); });
  const lengths = [];
  for (const count of [20, 40, 60]) lengths.push((await context.listWebSessions(count)).sessions.length);
  assert.deepEqual(lengths, [20, 40, 60]);
  assert.deepEqual(counts, [20, 40, 60]);
});
test('an in-flight small page cannot serve a larger request or overwrite its result', async () => {
  const pending = [];
  const context = api(url => new Promise(resolve => pending.push({ count: Number(new URL(url).searchParams.get('count')), resolve })));
  const small = context.listWebSessions(20);
  const large = context.listWebSessions(60);
  assert.deepEqual(pending.map(item => item.count), [20, 60]);
  pending[1].resolve(page(60)); pending[0].resolve(page(20));
  assert.equal((await large).sessions.length, 60);
  assert.equal((await small).sessions.length, 20);
});

test('identical pagination requests share one fetch and reuse their matching cache', async () => {
  let resolve;
  let requests = 0;
  const context = api(() => { requests += 1; return new Promise(done => { resolve = done; }); });
  const first = context.listWebSessions(40);
  const second = context.listWebSessions(40);
  assert.equal(requests, 1);
  resolve(page(40));
  assert.equal((await first).sessions.length, 40);
  assert.equal((await second).sessions.length, 40);
  assert.equal((await context.listWebSessions(40)).sessions.length, 40);
  assert.equal(requests, 1);
});
