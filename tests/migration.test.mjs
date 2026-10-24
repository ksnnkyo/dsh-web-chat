import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import * as host from '../index.js';
const { migrateLegacyData } = host;

function home(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-web-chat-migration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'deepseek-webdesk'));
  return directory;
}
test('legacy login and hotkey are copied into the new namespace without removing originals', t => {
  const directory = home(t);
  const legacy = path.join(directory, 'deepseek-webdesk');
  fs.writeFileSync(path.join(legacy, 'session.json'), JSON.stringify({ storage: { userToken: 'fixture-token' }, cookies: [] }));
  fs.writeFileSync(path.join(legacy, 'hotkey.json'), JSON.stringify({ enabled: false, key: 'K', modifiers: ['alt'] }));
  assert.equal(typeof migrateLegacyData, 'function');
  migrateLegacyData(directory);
  const sessionPath = path.join(directory, 'dsh-web-chat', 'session.json');
  assert.equal(JSON.parse(fs.readFileSync(sessionPath)).storage.userToken, 'fixture-token');
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'dsh-web-chat', 'hotkey.json'))).enabled, false);
  assert.equal(fs.existsSync(path.join(legacy, 'session.json')), true);
  if (process.platform !== 'win32') assert.equal(fs.statSync(sessionPath).mode & 0o777, 0o600);
});
test('migration never overwrites existing new settings or copies invalid legacy files', t => {
  const directory = home(t);
  fs.mkdirSync(path.join(directory, 'dsh-web-chat'));
  const destination = path.join(directory, 'dsh-web-chat', 'session.json');
  fs.writeFileSync(destination, JSON.stringify({ storage: { userToken: 'newer-token' } }));
  fs.writeFileSync(path.join(directory, 'deepseek-webdesk', 'session.json'), JSON.stringify({ storage: { userToken: 'older-token' } }));
  fs.writeFileSync(path.join(directory, 'deepseek-webdesk', 'hotkey.json'), 'not json');
  assert.equal(typeof migrateLegacyData, 'function');
  migrateLegacyData(directory);
  assert.equal(typeof migrateLegacyData, 'function');
  migrateLegacyData(directory);
  assert.equal(JSON.parse(fs.readFileSync(destination)).storage.userToken, 'newer-token');
  assert.equal(fs.existsSync(path.join(directory, 'dsh-web-chat', 'hotkey.json')), false);
});
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
function migratePrefs(storage) {
  const context = vm.createContext({ window: { localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } }, UI_PREFS_KEY: 'dsh-web-chat.ui.v1' });
  for (const name of ['readLocalJson', 'writeLocalJson', 'migrateLegacyUiPrefs']) {
    const match = source.match(new RegExp('    function ' + name + '\\([^]*?\\n    }'));
    assert.ok(match, name);
    vm.runInContext(match[0], context);
  }
  context.migrateLegacyUiPrefs();
}
test('legacy groups and collapse preferences migrate once without altering legacy storage', () => {
  const value = JSON.stringify({ groups: [{ id: 'g1', name: '工具' }], assignments: { session: 'g1' }, sectionStates: { g1: 'expanded' } });
  const storage = new Map([['dsh-deepseek-webdesk.ui.v1', value]]);
  migratePrefs(storage);
  assert.equal(storage.get('dsh-web-chat.ui.v1'), value);
  assert.equal(storage.get('dsh-deepseek-webdesk.ui.v1'), value);
  storage.set('dsh-web-chat.ui.v1', '{}');
  migratePrefs(storage);
  assert.equal(storage.get('dsh-web-chat.ui.v1'), '{}');
});
