import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8');

let definition = null;
const fakeWindow = {
  __ModuleLoader__: {
    load(next) {
      definition = next;
    },
  },
  localStorage: {
    getItem() {
      return null;
    },
    setItem() {},
  },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
  addEventListener() {},
  removeEventListener() {},
};

globalThis.window = fakeWindow;
globalThis.document = {
  createElement() {
    return {
      dataset: {},
      remove() {},
    };
  },
  head: {
    appendChild() {},
  },
};

vm.runInThisContext(source, { filename: 'client.js' });

const reactStub = {
  createElement(type, props, ...children) {
    return { type, props, children };
  },
  useRef(value) {
    return { current: value };
  },
  useState(value) {
    return [value, () => {}];
  },
  useEffect() {},
  useLayoutEffect() {},
  useSyncExternalStore() {
    return null;
  },
};

const plugin = definition.factory((id) => (id === 'react' ? reactStub : {}));
const registered = [];
const effects = [];
const ctx = {
  effect(fn, label) {
    const dispose = fn();
    effects.push({ label, dispose });
    return dispose;
  },
  slots: {
    inject(name, register) {
      register();
      return () => {};
    },
    register(options, component) {
      registered.push({ options, component });
      return () => {};
    },
  },
  get() {
    return undefined;
  },
};

test('client bundle registers sidebar entry, header menu and persistent overlay host', () => {
  assert.equal(typeof plugin.apply, 'function');
  plugin.apply(ctx);

  const byName = new Map(registered.map((entry) => [entry.options.name, entry]));
  assert.deepEqual([...byName.keys()].sort(), ['main', 'settings.general.item', 'shell.overlay', 'sidebar.footer.action']);

  const entry = byName.get('sidebar.footer.action');
  assert.equal(entry.options.id, 'dsh-web-chat-entry');
  assert.equal(typeof entry.component, 'function');

  const page = byName.get('main');
  assert.equal(page.options.key, 'dsh-web-chat-page');
  assert.equal(typeof page.component, 'function');

  const settingsRows = registered.filter((entry) => entry.options.name === 'settings.general.item');
  const settingsIds = settingsRows.map((entry) => entry.options.id).sort();
  assert.deepEqual(settingsIds, ['dsh-web-chat-hotkey', 'dsh-web-chat-usage-row']);
  for (const settingsRow of settingsRows) assert.equal(typeof settingsRow.component, 'function');

  const host = byName.get('shell.overlay');
  assert.equal(host.options.id, 'dsh-web-chat-host');
  assert.equal(typeof host.component, 'function');

  assert.match(source, /async function extractInGuest/);
  assert.match(source, /__appKit_@deepseek\/chat_localePreference/);
  assert.match(source, /deepseek-web-login\/api\/browser\/session/);
  assert.match(source, /conversation\.input\.shell\(/);
  assert.match(source, /function SidebarTabSwitcher\b/);
  assert.match(source, /function TerminalGlyph\b/);
  assert.match(source, /function PersonLaptopGlyph\b/);
  assert.match(source, /data-dsh-sidebar-tab/);
  assert.match(source, /\.dsh-web-chat-switcher\b/);

  for (const entry of effects) {
    if (typeof entry.dispose === 'function') assert.doesNotThrow(() => entry.dispose());
  }
});

test('sidebarTab preference defaults to session and supports workspace toggle', () => {
  const match = source.match(/function loadUiPrefs\(\) \{[\s\S]*?\n    \}/);
  assert.ok(match);
  const context = vm.createContext({
    readLocalJson: (key, fallback) => context.__mockValue || fallback,
    SESSION_LIMIT_DEFAULT: 50,
    SESSION_LIMIT_MAX: 200,
    GROUP_NAME_LIMIT: 24,
    UNGROUPED_KEY: '__ungrouped__',
    UI_PREFS_KEY: 'dsh-web-chat.ui.v1',
  });
  vm.runInContext(match[0], context);

  context.__mockValue = {};
  const defaultPrefs = context.loadUiPrefs();
  assert.equal(defaultPrefs.sidebarTab, 'session');

  context.__mockValue = { sidebarTab: 'workspace' };
  const workspacePrefs = context.loadUiPrefs();
  assert.equal(workspacePrefs.sidebarTab, 'workspace');
});
