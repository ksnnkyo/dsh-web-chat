import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Host half of the DeepSeek web session bundle.
 *
 * The client lives in the embedded browser. This half exists for one thing: read the
 * conversation list of the DSH web-login account without opening the page first, and
 * expose it to the client through a same-origin route. The token never leaves the
 * machine and is never logged.
 */

const API_PREFIX = '/dsh-web-chat/api';
const DEEPSEEK_ORIGIN = 'https://chat.deepseek.com';
const SESSION_LIST_PATH = '/api/v0/chat_session/fetch_page';
const CACHE_TTL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_SESSIONS = 60;
const DESK_DIR_NAME = 'dsh-web-chat';
const SESSION_FILE_NAME = 'session.json';
const SESSION_VALUE_LIMIT = 200_000;
const SESSION_ENTRY_LIMIT = 120;
const HOTKEY_FILE_NAME = 'hotkey.json';
const HELPER_DIR_NAME = 'helper';
const USAGE_CACHE_DIR = 'dsh-web-chat';
const USAGE_CACHE_FILE = 'usage-cache.json';
const USAGE_CACHE_VERSION = 2;
const BUCKET_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'];
const HOTKEY_KEYS = /^([A-Z]|[0-9]|Space|F([1-9]|1[0-2]))$/;
const HOTKEY_MODIFIERS = ['control', 'alt', 'shift', 'meta'];
const MAC_KEYCODES = {
  A: 0, S: 1, D: 2, F: 3, H: 4, G: 5, Z: 6, X: 7, C: 8, V: 9, B: 11, Q: 12, W: 13, E: 14, R: 15,
  Y: 16, T: 17, '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23, '9': 25, '7': 26, '8': 28,
  '0': 29, O: 31, U: 32, I: 34, P: 35, L: 37, J: 38, K: 40, N: 45, M: 46, Space: 49,
  F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111,
};
const MAC_MODS = { control: 4096, alt: 2048, shift: 512, meta: 256 };
const WIN_MODS = { alt: 1, control: 2, shift: 4, meta: 8 };
const WIN_KEYS = { Space: 0x20, F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75, F7: 0x76, F8: 0x77, F9: 0x78, F10: 0x79, F11: 0x7a, F12: 0x7b };

export const name = 'dsh-web-chat';
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

function deskDir() {
  return join(dshHome(), DESK_DIR_NAME);
}

function sessionFilePath() {
  return join(deskDir(), SESSION_FILE_NAME);
}

function clampString(value, limit = SESSION_VALUE_LIMIT) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

/** Normalize a client-captured guest session snapshot; exported for tests. */
export function normalizeSessionSnapshot(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const storage = {};
  let count = 0;
  const sourceStorage = raw.storage;
  if (sourceStorage !== null && typeof sourceStorage === 'object') {
    for (const key of Object.keys(sourceStorage)) {
      if (count >= SESSION_ENTRY_LIMIT) break;
      const value = sourceStorage[key];
      if (typeof key !== 'string' || key === '' || typeof value !== 'string') continue;
      storage[key] = clampString(value);
      count += 1;
    }
  }
  const cookies = [];
  if (Array.isArray(raw.cookies)) {
    for (const cookie of raw.cookies) {
      if (cookies.length >= SESSION_ENTRY_LIMIT) break;
      if (typeof cookie !== 'string') continue;
      const item = cookie.trim();
      if (item === '' || item.indexOf('=') <= 0) continue;
      cookies.push(clampString(item, 4096));
    }
  }
  const userAgent = clampString(raw.userAgent, 500);
  const writes = [];
  if (Array.isArray(raw.writes)) {
    for (const entry of raw.writes) {
      if (writes.length >= SESSION_ENTRY_LIMIT) break;
      if (entry === null || typeof entry !== 'object') continue;
      if (typeof entry.key !== 'string' || entry.key === '' || typeof entry.value !== 'string') continue;
      writes.push({ key: entry.key, value: clampString(entry.value) });
    }
  }
  if (Object.keys(storage).length === 0 && cookies.length === 0 && writes.length === 0) return null;
  return { storage, cookies, writes, userAgent, at: typeof raw.at === 'string' ? raw.at : new Date().toISOString() };
}

function readOwnSession() {
  try {
    const file = sessionFilePath();
    if (!existsSync(file)) return null;
    return normalizeSessionSnapshot(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

function writeOwnSession(raw) {
  const snapshot = normalizeSessionSnapshot(raw);
  if (snapshot === null) return null;
  const file = sessionFilePath();
  mkdirSync(deskDir(), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...snapshot, at: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  cache = { at: 0, value: null };
  return snapshot;
}

/** Copy validated legacy data once. Never modify the old plugin or overwrite new data. */
export function migrateLegacyData(home = dshHome()) {
  const migrated = { session: false, hotkey: false };
  const previous = join(home, 'deepseek-webdesk');
  const destination = join(home, DESK_DIR_NAME);
  const entries = [
    { file: SESSION_FILE_NAME, key: 'session', normalize: normalizeSessionSnapshot },
    { file: HOTKEY_FILE_NAME, key: 'hotkey', normalize: normalizeHotkeyConfig },
  ];
  for (const entry of entries) {
    const target = join(destination, entry.file);
    if (existsSync(target)) continue;
    try {
      const raw = readJsonFile(join(previous, entry.file));
      const value = entry.normalize(raw);
      if (value === null) continue;
      mkdirSync(destination, { recursive: true, mode: 0o700 });
      writeFileSync(target, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      migrated[entry.key] = true;
    } catch (error) {
      // Invalid/missing legacy files do not prevent a fresh login or overwrite current data.
    }
  }
  return migrated;
}

function clearOwnSession() {
  try {
    unlinkSync(sessionFilePath());
  } catch {
    /* already gone */
  }
  cache = { at: 0, value: null };
}

/**
 * Read one captured `localStorage` value. The app wraps some entries as
 * `{"value": "…", "__version": "0"}` — a signed-out entry is `{"value": null}` and
 * must not be mistaken for a token.
 */
function unwrapStorageValue(raw) {
  if (typeof raw !== 'string' || raw === '') return '';
  const text = raw.trim();
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object' && 'value' in parsed) {
        return typeof parsed.value === 'string' ? parsed.value.trim() : '';
      }
    } catch {
      /* a bare token is valid too */
    }
  }
  return text;
}

/** Read the `userToken` value out of a captured guest snapshot. */
export function sessionToken(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') return '';
  for (const entry of Array.isArray(snapshot.writes) ? snapshot.writes : []) {
    if (entry !== null && typeof entry === 'object' && entry.key === 'userToken') {
      const token = unwrapStorageValue(entry.value);
      if (token !== '') return token;
    }
  }
  const storage = snapshot.storage !== null && typeof snapshot.storage === 'object' ? snapshot.storage : null;
  return storage === null ? '' : unwrapStorageValue(storage.userToken);
}

const WEB_CLIENT_HEADERS = {
  accept: '*/*',
  'x-client-locale': 'zh_CN',
  'x-client-platform': 'web',
  'x-client-version': '2.5.0',
  'x-client-bundle-id': 'com.deepseek.chat',
};

/**
 * Account-shaped credentials built from the snapshot the embedded page saved.
 * That snapshot is fresher than `~/.dsh/web-login/accounts/*.json`: the site rotates
 * `userToken`, so the web-login file can hold a token the server already rejects.
 */
function ownCredentials() {
  const own = readOwnSession();
  if (own === null) return null;
  const token = sessionToken(own);
  if (token === '') return null;
  const storage = own.storage !== null && typeof own.storage === 'object' ? own.storage : {};
  return {
    id: 'local',
    token,
    userAgent: typeof own.userAgent === 'string' ? own.userAgent : '',
    cookie: Array.isArray(own.cookies) ? own.cookies.join('; ') : '',
    hifLeim: unwrapStorageValue(storage.hif_leim_cached),
    hifDliq: unwrapStorageValue(storage.hif_dliq_cached),
    extraHeaders: {
      ...WEB_CLIENT_HEADERS,
      'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
    },
    source: 'local',
  };
}

/** Credential candidates, freshest first: the page capture, then the web-login account. */
function credentialCandidates() {
  const list = [];
  const local = ownCredentials();
  if (local !== null) list.push(local);
  const account = activeAccount();
  if (account !== null && !list.some((row) => row.token === account.token)) {
    list.push({ ...account, source: 'web-login' });
  }
  return list;
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
const inflight = new Map();

/** A stored token the site no longer accepts (as opposed to a network or WAF failure). */
function isTokenRejection(payload) {
  if (payload === null || typeof payload !== 'object') return false;
  if (payload.code === 40003) return true;
  const msg = typeof payload.msg === 'string' ? payload.msg : '';
  return msg.includes('INVALID_TOKEN');
}

/**
 * Read the signed-in web account's conversation list. Returns a plain object even on
 * failure so the client can render a useful empty state.
 */
export async function listWebSessions(count) {
  const limitSource = Number(count);
  const limit = Number.isFinite(limitSource) ? Math.max(1, Math.min(MAX_SESSIONS, Math.floor(limitSource))) : 30;
  const now = Date.now();
  if (cache.value !== null && cache.limit === limit && now - cache.at < CACHE_TTL_MS) return cache.value;
  if (inflight.has(limit)) return inflight.get(limit);
  const candidates = credentialCandidates();
  if (candidates.length === 0) {
    return { ok: false, error: 'not-signed-in', sessions: [], hasMore: false };
  }
  const request = (async () => {
    try {
      let lastError = 'request-failed';
      for (const account of candidates) {
        try {
          const response = await fetch(DEEPSEEK_ORIGIN + SESSION_LIST_PATH + '?count=' + limit, {
            headers: requestHeaders(account),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          const payload = await response.json().catch(() => null);
          const appCode = payload !== null && typeof payload === 'object' && typeof payload.code === 'number' ? payload.code : null;
          if (!response.ok || payload === null || appCode !== 0) {
            lastError = isTokenRejection(payload)
              ? 'token-expired'
              : payload !== null && typeof payload === 'object' && typeof payload.msg === 'string' && payload.msg !== ''
                ? payload.msg
                : 'http-' + response.status;
            // A token the site no longer accepts is worth retrying with the next
            // credential; a network or WAF failure will not improve on a retry.
            if (appCode !== null && appCode !== 0) continue;
            return { ok: false, error: lastError, sessions: [], hasMore: false };
          }
          const normalized = normalizeSessions(payload);
          const value = {
            ok: true,
            sessions: normalized.sessions,
            hasMore: normalized.hasMore,
            account: account.id,
            source: account.source,
            at: new Date().toISOString(),
          };
          cache = { at: Date.now(), value, limit };
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
        }
      }
      return { ok: false, error: lastError, sessions: [], hasMore: false };
    } finally {
      inflight.delete(limit);
    }
  })();
  inflight.set(limit, request);
  return request;
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
  if (isTokenRejection(payload) || response.status === 401 || response.status === 403) return { ok: false, error: 'token-expired' };
  if (!response.ok || payload === null) return { ok: false, error: 'http-' + response.status };
  if (payload.code !== 0) return { ok: false, error: 'api-' + (payload.code ?? 'invalid-response') };
  const bizCode = payload.data !== null && typeof payload.data === 'object' ? payload.data.biz_code : undefined;
  if (bizCode !== undefined && bizCode !== 0) return { ok: false, error: 'biz-' + bizCode };
  return { ok: true };
}

/** POST one chat-session mutation, falling back to the next credential on a token rejection. */
async function callSessionApiWithCandidates(path, body) {
  const candidates = credentialCandidates();
  if (candidates.length === 0) return { ok: false, error: 'not-signed-in' };
  let last = { ok: false, error: 'request-failed' };
  for (const account of candidates) {
    try {
      const result = await callSessionApi(account, path, body);
      if (result.ok) return result;
      last = result;
      if (!/^(token-expired$|biz-|http-40[13]$)/.test(result.error)) return last;
    } catch (error) {
      return {
        ok: false,
        error:
          error !== null && typeof error === 'object' && typeof error.message === 'string'
            ? error.message.slice(0, 200)
            : 'request-failed',
      };
    }
  }
  return last;
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

function helperDir() {
  return join(deskDir(), HELPER_DIR_NAME);
}

function hotkeyFile() {
  return join(deskDir(), HOTKEY_FILE_NAME);
}

function defaultHotkey() {
  return { enabled: true, key: 'Space', modifiers: ['alt'] };
}

/** Validate a hotkey config from the client; exported for tests. */
export function normalizeHotkeyConfig(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const key = typeof raw.key === 'string' && HOTKEY_KEYS.test(raw.key) ? raw.key : 'Space';
  const modifiers = [];
  if (Array.isArray(raw.modifiers)) {
    for (const modifier of raw.modifiers) {
      if (HOTKEY_MODIFIERS.includes(modifier) && !modifiers.includes(modifier)) modifiers.push(modifier);
    }
  }
  if (modifiers.length === 0) modifiers.push('alt');
  return { enabled: raw.enabled !== false, key, modifiers };
}

function readHotkey() {
  try {
    if (!existsSync(hotkeyFile())) return defaultHotkey();
    return normalizeHotkeyConfig(JSON.parse(readFileSync(hotkeyFile(), 'utf8'))) ?? defaultHotkey();
  } catch {
    return defaultHotkey();
  }
}

function writeHotkey(raw) {
  const config = normalizeHotkeyConfig(raw);
  if (config === null) return null;
  mkdirSync(deskDir(), { recursive: true });
  writeFileSync(hotkeyFile(), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  return config;
}

let helperChild = null;
let helperError = '';
let helperCompiling = false;
let helperPendingRestart = false;

const MAC_HELPER_SOURCE = `import Cocoa
import Carbon
import CoreGraphics

let bundleId = "com.deepseek.dsh"
var hotKeyRef: EventHotKeyRef?
var handlerRef: EventHandlerRef?

func hasVisibleWindow(_ pid: pid_t) -> Bool {
  guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return false }
  for info in list {
    guard let owner = info[kCGWindowOwnerPID as String] as? pid_t, owner == pid else { continue }
    let layer = info[kCGWindowLayer as String] as? Int ?? 0
    if layer == 0 { return true }
  }
  return false
}

func reopen(_ app: NSRunningApplication) {
  if let scheme = URL(string: "dsh://open"), NSWorkspace.shared.open(scheme) { return }
  if let url = app.bundleURL {
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, _ in }
  } else {
    app.activate(options: [.activateIgnoringOtherApps])
  }
}

func toggle() {
  guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else { return }
  let visible = hasVisibleWindow(app.processIdentifier)
  if app.isHidden || !visible {
    app.unhide()
    reopen(app)
  } else if app.isActive {
    app.hide()
  } else {
    app.activate(options: [.activateIgnoringOtherApps])
  }
}

@_silgen_name("RunApplicationEventLoop")
func CarbonRunApplicationEventLoop()

let arguments = CommandLine.arguments
let code = UInt32(arguments.count > 1 ? arguments[1] : "49") ?? 49
let modifiers = UInt32(arguments.count > 2 ? arguments[2] : "2048") ?? 2048
var hotKeyID = EventHotKeyID(signature: OSType(0x44534348), id: 1)
RegisterEventHotKey(code, modifiers, hotKeyID, GetApplicationEventTarget(), 0, &hotKeyRef)
var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
InstallEventHandler(GetApplicationEventTarget(), { (_, _, _) -> OSStatus in
  toggle()
  return noErr
}, 1, &eventType, nil, &handlerRef)
CarbonRunApplicationEventLoop()
`;

const WIN_HELPER_SOURCE = String.raw`param([int]$Modifiers = 1, [int]$VirtualKey = 0x20)
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class DshWebChatHotKeyForm : Form {
  [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  const int WM_HOTKEY = 0x0312;
  int id = 0x4453;
  uint modifiers;
  uint vk;
  public DshWebChatHotKeyForm(uint modifiers, uint vk) {
    this.modifiers = modifiers;
    this.vk = vk;
    ShowInTaskbar = false;
    WindowState = FormWindowState.Minimized;
    Opacity = 0;
    FormBorderStyle = FormBorderStyle.None;
    Load += (s, e) => { RegisterHotKey(Handle, id, modifiers, vk); };
  }
  static IntPtr TargetWindow() {
    foreach (Process process in Process.GetProcesses()) {
      try {
        if (process.MainWindowHandle == IntPtr.Zero) continue;
        if (process.ProcessName.IndexOf("DeepSeek", StringComparison.OrdinalIgnoreCase) >= 0) return process.MainWindowHandle;
      } catch { }
    }
    return IntPtr.Zero;
  }
  protected override void WndProc(ref Message m) {
    if (m.Msg == WM_HOTKEY) {
      IntPtr window = TargetWindow();
      if (window != IntPtr.Zero) {
        if (IsWindowVisible(window)) ShowWindow(window, 0);
        else { ShowWindow(window, 9); SetForegroundWindow(window); }
      }
    }
    base.WndProc(ref m);
  }
}
"@
$form = New-Object DshWebChatHotKeyForm -ArgumentList ([uint32]$Modifiers), ([uint32]$VirtualKey)
[System.Windows.Forms.Application]::Run($form)
`;

function macAccelerator(config) {
  const keyCode = MAC_KEYCODES[config.key] === undefined ? 49 : MAC_KEYCODES[config.key];
  let modifiers = 0;
  for (const modifier of config.modifiers) modifiers |= MAC_MODS[modifier] ?? 0;
  return { keyCode, modifiers };
}

function winAccelerator(config) {
  let vk = WIN_KEYS[config.key];
  if (vk === undefined) {
    if (/^[A-Z0-9]$/.test(config.key)) vk = config.key.charCodeAt(0);
    else vk = 0x20;
  }
  let modifiers = 0;
  for (const modifier of config.modifiers) modifiers |= WIN_MODS[modifier] ?? 0;
  return { vk, modifiers };
}

function stopHotkeyHelper() {
  const child = helperChild;
  helperChild = null;
  if (child !== null) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
}

function startHotkeyHelper() {
  const config = readHotkey();
  if (config.enabled !== true) {
    stopHotkeyHelper();
    return;
  }
  stopHotkeyHelper();
  helperError = '';
  if (process.platform === 'darwin') {
    const dir = helperDir();
    const binary = join(dir, 'dsh-web-chat-hotkey');
    const source = join(dir, 'dsh-web-chat-hotkey.swift');
    mkdirSync(dir, { recursive: true });
    const needBuild = !existsSync(binary) || !existsSync(source) || readFileSync(source, 'utf8') !== MAC_HELPER_SOURCE;
    if (needBuild) {
      if (helperCompiling) {
        helperPendingRestart = true;
        return;
      }
      helperCompiling = true;
      try {
        writeFileSync(source, MAC_HELPER_SOURCE, 'utf8');
        const result = spawnSync('swiftc', ['-O', '-o', binary, source], { timeout: 120_000, encoding: 'utf8' });
        if (result.status !== 0) {
          helperError = 'swiftc: ' + String(result.stderr || result.error || 'build failed').slice(0, 400);
        } else {
          try {
            spawnSync('chmod', ['755', binary]);
          } catch {
            /* optional */
          }
        }
      } catch (error) {
        helperError = 'swiftc: ' + String(error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : error).slice(0, 400);
      } finally {
        helperCompiling = false;
        if (helperPendingRestart) {
          helperPendingRestart = false;
          if (helperError === '') startHotkeyHelper();
        }
      }
    }
    if (helperError !== '' || !existsSync(binary)) return;
    const { keyCode, modifiers } = macAccelerator(config);
    try {
      const child = spawn(binary, [String(keyCode), String(modifiers)], { stdio: 'ignore' });
      helperChild = child;
      child.on('exit', (code) => {
        if (helperChild === child) helperChild = null;
        if (code !== 0 && code !== null) helperError = 'helper exited with code ' + code;
      });
      child.on('error', (error) => {
        helperError = String(error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : error).slice(0, 400);
      });
    } catch (error) {
      helperError = String(error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : error).slice(0, 400);
    }
    return;
  }
  if (process.platform === 'win32') {
    const dir = helperDir();
    const script = join(dir, 'dsh-web-chat-hotkey.ps1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(script, WIN_HELPER_SOURCE, 'utf8');
    const { vk, modifiers } = winAccelerator(config);
    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Modifiers', String(modifiers), '-VirtualKey', String(vk)], { stdio: 'ignore', windowsHide: true });
      helperChild = child;
      child.on('exit', (code) => {
        if (helperChild === child) helperChild = null;
        if (code !== 0 && code !== null) helperError = 'helper exited with code ' + code;
      });
      child.on('error', (error) => {
        helperError = String(error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : error).slice(0, 400);
      });
    } catch (error) {
      helperError = String(error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : error).slice(0, 400);
    }
    return;
  }
  helperError = 'global hotkey is currently implemented for macOS and Windows only';
}

function hotkeyStatus() {
  return {
    platform: process.platform,
    config: readHotkey(),
    running: helperChild !== null,
    error: helperError,
    pid: helperChild !== null ? helperChild.pid ?? null : null,
  };
}

// ---------- 用量与余额：折叠会话日志 + 查 DSH 账号余额 ----------

function usageCachePath() {
  return join(deskDir(), USAGE_CACHE_FILE);
}

/** Local calendar day key (`YYYY-MM-DD`) for an epoch-millisecond timestamp. */
export function dayKey(time) {
  const date = new Date(typeof time === 'number' && Number.isFinite(time) ? time : Date.now());
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function emptyBuckets() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Provider usage sample of one event, or undefined. */
export function usageOfEvent(event) {
  if (event === null || typeof event !== 'object') return undefined;
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined;
  const data = event.data;
  if (data === null || typeof data !== 'object') return undefined;
  if (data.usage !== undefined && data.usage !== null && typeof data.usage === 'object') return data.usage;
  const stream = data.stream;
  if (!Array.isArray(stream)) return undefined;
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const chunk = stream[index]?.chunk;
    if (chunk !== null && typeof chunk === 'object' && chunk.type === 'usage' && chunk.usage !== null && typeof chunk.usage === 'object') return chunk.usage;
  }
  return undefined;
}

export function bucketsFromUsage(usage) {
  return { input: count(usage.inputTokens), output: count(usage.outputTokens), cacheRead: count(usage.cacheReadTokens), cacheWrite: count(usage.cacheWriteTokens) };
}

function bucketsEqual(left, right) {
  return BUCKET_KEYS.every((key) => left[key] === right[key]);
}

function bucketsTotal(buckets) {
  return buckets.input + buckets.output + buckets.cacheRead + buckets.cacheWrite;
}

export function createUsageState() {
  return { totals: emptyBuckets(), days: Object.create(null), last: null };
}

/**
 * Fold one session's durable events into per-day + total usage. Mirrors the
 * shipped `tokenUsage` projection fold: a later sample of the same turn+step
 * replaces the earlier one, `llm/retry-started` closes that slot, and each
 * accepted sample is attributed to the local day of its event.
 */
export function foldSessionEvents(events, state) {
  const next = state ?? createUsageState();
  if (!Array.isArray(events)) return next;
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    if (event.type === 'llm/retry-started') {
      const data = event.data;
      if (next.last !== null && data !== null && typeof data === 'object' && next.last.turn === data.turn && next.last.step === data.step) next.last = null;
      continue;
    }
    const usage = usageOfEvent(event);
    if (usage === undefined) continue;
    const data = event.data;
    const turn = data.turn;
    const step = data.step;
    const buckets = bucketsFromUsage(usage);
    const previous = next.last !== null && next.last.turn === turn && next.last.step === step ? next.last : null;
    const day = dayKey(event.time);
    if (previous !== null && previous.day === day && bucketsEqual(previous.buckets, buckets)) continue;
    for (const key of BUCKET_KEYS) next.totals[key] = Math.max(0, next.totals[key] - (previous === null ? 0 : previous.buckets[key])) + buckets[key];
    if (previous !== null) {
      const previousDay = previous.day ?? day;
      const oldBuckets = next.days[previousDay] ?? emptyBuckets();
      for (const key of BUCKET_KEYS) oldBuckets[key] = Math.max(0, oldBuckets[key] - previous.buckets[key]);
      next.days[previousDay] = oldBuckets;
    }
    const dayBuckets = next.days[day] ?? emptyBuckets();
    for (const key of BUCKET_KEYS) dayBuckets[key] += buckets[key];
    next.days[day] = dayBuckets;
    next.last = { turn, step, buckets, day };
  }
  return next;
}

function addBuckets(target, source) {
  for (const key of BUCKET_KEYS) target[key] += source !== null && typeof source === 'object' ? count(source[key]) : 0;
}

/** Aggregate cached per-session states into today's and all-time totals. */
export function summarizeUsage(sessions, now = Date.now()) {
  const today = emptyBuckets();
  const total = emptyBuckets();
  const todayKey = dayKey(now);
  const rows = sessions !== null && typeof sessions === 'object' ? Object.values(sessions) : [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    addBuckets(total, row.totals);
    addBuckets(today, row.days?.[todayKey] ?? null);
  }
  return {
    today: { ...today, total: bucketsTotal(today) },
    total: { ...total, total: bucketsTotal(total) },
    sessionCount: rows.length,
  };
}

function loadUsageCache() {
  try {
    const raw = JSON.parse(readFileSync(usageCachePath(), 'utf8'));
    if (raw === null || typeof raw !== 'object' || raw.version !== USAGE_CACHE_VERSION || raw.sessions === null || typeof raw.sessions !== 'object') return Object.create(null);
    const sessions = Object.create(null);
    for (const [id, row] of Object.entries(raw.sessions)) {
      if (typeof id !== 'string' || row === null || typeof row !== 'object' || typeof row.revision !== 'string') continue;
      const totals = emptyBuckets();
      addBuckets(totals, row.totals);
      const days = Object.create(null);
      if (row.days !== null && typeof row.days === 'object') {
        for (const [day, buckets] of Object.entries(row.days)) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
          const next = emptyBuckets();
          addBuckets(next, buckets);
          days[day] = next;
        }
      }
      sessions[id] = { revision: row.revision, totals, days };
    }
    return sessions;
  } catch {
    return Object.create(null);
  }
}

function saveUsageCache(sessions) {
  try {
    mkdirSync(dirname(usageCachePath()), { recursive: true });
    const temporary = usageCachePath() + '.' + process.pid + '.tmp';
    writeFileSync(temporary, JSON.stringify({ version: USAGE_CACHE_VERSION, sessions }), 'utf8');
    renameSync(temporary, usageCachePath());
  } catch (error) {
    /* usage cache persistence is best effort */
  }
}

/**
 * Refresh the per-session usage cache from the durable session store. Sessions
 * whose persistence revision is unchanged are kept; only changed logs are read.
 */
export async function refreshUsage(persistence, previous) {
  const snapshots = await persistence.list();
  const next = Object.create(null);
  let changed = false;
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    const id = snapshot?.header?.id;
    if (typeof id !== 'string' || id === '') continue;
    const revision = typeof snapshot.revision === 'string' ? snapshot.revision : '';
    const cached = previous[id];
    if (cached !== undefined && cached.revision === revision) {
      next[id] = cached;
      continue;
    }
    if (snapshot.formatStatus === 'migration-required') {
      if (cached !== undefined) next[id] = { ...cached, revision };
      changed = true;
      continue;
    }
    let events;
    let reader;
    try {
      reader = await persistence.open(id, 'read');
      events = (await reader.read())?.events;
    } catch (error) {
      if (cached !== undefined) next[id] = cached;
      continue;
    } finally {
      try {
        await reader?.close?.();
      } catch {
        /* closing a read handle is best effort */
      }
    }
    const state = foldSessionEvents(events, createUsageState());
    next[id] = { revision, totals: state.totals, days: state.days };
    changed = true;
  }
  if (!changed && Object.keys(previous).length !== Object.keys(next).length) changed = true;
  return { sessions: next, changed };
}

/** Client identity headers the account service derives from one caller. */
function accountClientMetadata(url) {
  const version = typeof process.env.DSH_CLIENT_VERSION === 'string' && process.env.DSH_CLIENT_VERSION !== '' ? process.env.DSH_CLIENT_VERSION : '0.0.0';
  const locale = url.searchParams.get('locale') || 'zh-CN';
  const rawTz = Number(url.searchParams.get('tz'));
  const timezoneOffsetSeconds = Number.isFinite(rawTz) ? rawTz : -new Date().getTimezoneOffset() * 60;
  return { version, locale, timezoneOffsetSeconds };
}

/** Read the Platform recharge-wallet summary through the account service. */
export async function readBalance(account, client) {
  const state = await account.getState();
  if (state?.status !== 'credential-stored') return { status: 'signed-out' };
  const result = await account.getBalance(client);
  if (result === null) return { status: 'signed-out' };
  if (result?.status !== 'ready') return { status: 'failed' };
  const wallets = (Array.isArray(result.value) ? result.value : []).map((wallet) => ({ currency: wallet.currency === 'USD' ? 'USD' : 'CNY', balance: String(wallet.balance), bonus: '0' }));
  for (const wallet of Array.isArray(result.bonusWallets) ? result.bonusWallets : []) {
    const currency = wallet.currency === 'USD' ? 'USD' : 'CNY';
    const existing = wallets.find((row) => row.currency === currency);
    if (existing === undefined) wallets.push({ currency, balance: '0', bonus: String(wallet.balance) });
    else existing.bonus = String(wallet.balance);
  }
  return { status: 'ready', wallets };
}

export function apply(ctx) {
  migrateLegacyData();
  let usage = Object.create(null);
  let usageAt = 0;
  let usageError = '';
  let refreshing = null;
  try {
    usage = loadUsageCache();
  } catch {
    usage = Object.create(null);
  }
  const refresh = async () => {
    const persistence = ctx.get('sessionPersistence');
    if (persistence === undefined) {
      usageError = 'session-persistence-unavailable';
      usageAt = Date.now();
      return;
    }
    try {
      const result = await refreshUsage(persistence, usage);
      usage = result.sessions;
      usageError = '';
      if (result.changed) saveUsageCache(usage);
    } catch (error) {
      usageError = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error);
    } finally {
      usageAt = Date.now();
      refreshing = null;
    }
  };
  const ensureUsage = () => {
    if (refreshing !== null) return refreshing;
    refreshing = refresh();
    return refreshing;
  };
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
          const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1');
          const route = url.pathname.slice(API_PREFIX.length) || '/';
          try {
            if (req.method === 'GET' && (route === '/auth/session' || route === '/auth/session/')) {
              const snapshot = readOwnSession();
              sendJson(res, 200, snapshot === null ? { ok: false, error: 'empty' } : { ok: true, session: snapshot });
              return;
            }
            if (req.method === 'POST' && (route === '/auth/session' || route === '/auth/session/')) {
              const body = await readJsonBody(req);
              const snapshot = writeOwnSession(body);
              sendJson(res, snapshot === null ? 400 : 200, snapshot === null ? { ok: false, error: 'invalid' } : { ok: true, at: snapshot.at });
              return;
            }
            if (req.method === 'DELETE' && (route === '/auth/session' || route === '/auth/session/')) {
              clearOwnSession();
              sendJson(res, 200, { ok: true });
              return;
            }
            if (req.method === 'GET' && (route === '/sessions' || route === '/sessions/')) {
              const count = Number(url.searchParams.get('count'));
              sendJson(res, 200, await listWebSessions(count));
              return;
            }
            if (req.method === 'POST' && (route === '/sessions/delete' || route === '/sessions/delete/')) {
              if (credentialCandidates().length === 0) {
                sendJson(res, 200, { ok: false, error: 'not-signed-in' });
                return;
              }
              const body = await readJsonBody(req);
              const id = body !== null && typeof body === 'object' && typeof body.id === 'string' ? body.id : '';
              if (id === '') {
                sendJson(res, 400, { ok: false, error: 'invalid-id' });
                return;
              }
              const result = await callSessionApiWithCandidates('/api/v0/chat_session/delete', { chat_session_ids: [id] });
              cache = { at: 0, value: null };
              sendJson(res, result.ok ? 200 : 502, result);
              return;
            }
            if (req.method === 'POST' && (route === '/sessions/pin' || route === '/sessions/pin/')) {
              if (credentialCandidates().length === 0) {
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
              const result = await callSessionApiWithCandidates('/api/v0/chat_session/batch_update_pinned', {
                chat_session_ids: [id],
                pinned,
              });
              cache = { at: 0, value: null };
              sendJson(res, result.ok ? 200 : 502, result);
              return;
            }
            if (req.method === 'GET' && (route === '/hotkey' || route === '/hotkey/')) {
              sendJson(res, 200, { ok: true, ...hotkeyStatus() });
              return;
            }
            if (req.method === 'POST' && (route === '/hotkey' || route === '/hotkey/')) {
              const body = await readJsonBody(req);
              const config = writeHotkey(body);
              if (config === null) {
                sendJson(res, 400, { ok: false, error: 'invalid-hotkey' });
                return;
              }
              startHotkeyHelper();
              sendJson(res, 200, { ok: true, ...hotkeyStatus() });
              return;
            }
            if (req.method === 'GET' && (route === '/usage' || route === '/usage/')) {
              await ensureUsage();
              const summary = summarizeUsage(usage);
              sendJson(res, 200, { ok: usageError === '', ...(usageError === '' ? {} : { error: usageError }), at: usageAt, today: summary.today, total: summary.total, sessionCount: summary.sessionCount });
              return;
            }
            if (req.method === 'GET' && (route === '/balance' || route === '/balance/')) {
              const account = ctx.get('deepseekAccount');
              if (account === undefined) {
                sendJson(res, 200, { ok: false, error: 'account-unavailable' });
                return;
              }
              const result = await readBalance(account, accountClientMetadata(url));
              sendJson(res, 200, { ok: result.status === 'ready', ...result, at: Date.now() });
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
    'dsh-web-chat: api',
  );
  ctx.effect(() => {
    startHotkeyHelper();
    return () => stopHotkeyHelper();
  }, 'dsh-web-chat: global hotkey helper');
}
