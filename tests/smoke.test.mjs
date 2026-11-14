import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

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

test('resolveSidebarRoot and pageZoomScale handle native and claude-style DOM structures', async () => {
  const resolveMatch = source.match(/function resolveSidebarRoot\(anchor\) \{[\s\S]*?\n    \}/);
  const zoomMatch = source.match(/function pageZoomScale\(\) \{[\s\S]*?\n    \}/);
  assert.ok(resolveMatch);
  assert.ok(zoomMatch);

  const win = new Window();
  try {
    const context = vm.createContext({ document: win.document });
    vm.runInContext(resolveMatch[0] + '\n' + zoomMatch[0], context);

    assert.equal(context.pageZoomScale(), 1);
    win.document.body.setAttribute('data-dsh-claude-page-zoom', '1.25');
    assert.equal(context.pageZoomScale(), 1.25);
    win.document.body.setAttribute('data-dsh-claude-page-zoom', 'invalid');
    assert.equal(context.pageZoomScale(), 1);

    win.document.body.innerHTML =
      '<div data-slot="sidebar"><div class="kB3qhq_root" data-dsh-claude-part="sidebar-root">' +
      '<div class="kB3qhq_footArea" data-dsh-claude-part="foot-area">' +
      '<div class="kB3qhq_footerActions" data-dsh-claude-part="footer-actions">' +
      '<div data-slot="sidebar.footer.action"><span id="anchor"></span></div>' +
      '</div></div></div></div>';
    const anchor = win.document.getElementById('anchor');
    const root = context.resolveSidebarRoot(anchor);
    assert.equal(root.className, 'kB3qhq_root');

    win.document.body.innerHTML =
      '<div data-slot="sidebar"><div data-dsh-claude-part="sidebar-root">' +
      '<div data-slot="sidebar.footer.action"><span id="anchor2"></span></div></div></div>';
    const fallbackRoot = context.resolveSidebarRoot(win.document.getElementById('anchor2'));
    assert.equal(fallbackRoot.getAttribute('data-dsh-claude-part'), 'sidebar-root');
  } finally {
    await win.happyDOM.abort();
  }
});

test('SidebarSessionEntry portals sidebar UI outside foot-area to survive claude-style footer takeover', async () => {
  const win = new Window({ url: 'https://localhost/' });
  win.document.body.innerHTML =
    '<div data-slot="sidebar"><div class="kB3qhq_root" data-dsh-claude-part="sidebar-root">' +
    '<div class="kB3qhq_regionArea" data-dsh-claude-part="region-area"></div>' +
    '<div class="kB3qhq_footArea" data-dsh-claude-part="foot-area">' +
    '<div class="kB3qhq_footerActions" data-dsh-claude-part="footer-actions">' +
    '<div data-slot="sidebar.footer.action"></div>' +
    '</div></div></div></div>';
  const slotContainer = win.document.querySelector('[data-slot="sidebar.footer.action"]');
  const sidebarRoot = win.document.querySelector('.kB3qhq_root');
  const regionArea = win.document.querySelector('.kB3qhq_regionArea');
  const footArea = win.document.querySelector('.kB3qhq_footArea');

  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  let injectedCss = '';
  const localRegistered = [];

  try {
    globalThis.window = win;
    globalThis.document = {
      documentElement: win.document.documentElement,
      body: win.document.body,
      createElement(tag) {
        return {
          tagName: tag,
          dataset: {},
          set textContent(value) {
            injectedCss = value;
          },
          remove() {},
        };
      },
      head: { appendChild() {} },
    };

    const states = [];
    const refs = [];
    const layoutEffects = [];
    const portalCalls = [];
    const hookReact = {
      Fragment: Symbol('Fragment'),
      createElement(type, props, ...children) {
        return { type, props, children };
      },
      useRef(initial) {
        const idx = hookCursor.ref++;
        if (!(idx in refs)) refs[idx] = { current: initial };
        return refs[idx];
      },
      useState(initial) {
        const idx = hookCursor.state++;
        if (!(idx in states)) states[idx] = typeof initial === 'function' ? initial() : initial;
        return [
          states[idx],
          (next) => {
            states[idx] = typeof next === 'function' ? next(states[idx]) : next;
          },
        ];
      },
      useEffect() {},
      useLayoutEffect(fn) {
        layoutEffects.push(fn);
      },
      useSyncExternalStore(_sub, getSnap) {
        return getSnap();
      },
    };
    const hookCursor = { ref: 0, state: 0 };

    const scopedPlugin = definition.factory((id) => {
      if (id === 'react') return hookReact;
      if (id === 'react-dom') {
        return {
          createPortal(children, container) {
            portalCalls.push({ children, container });
            return { $$portal: true, children, container };
          },
        };
      }
      return {};
    });

    const localEffects = [];
    scopedPlugin.apply({
      effect(fn) {
        const d = fn();
        localEffects.push(d);
        return d;
      },
      slots: {
        inject(_n, reg) {
          reg();
          return () => {};
        },
        register(opts, comp) {
          localRegistered.push({ opts, comp });
          return () => {};
        },
      },
      get() {
        return undefined;
      },
    });

    const Entry = localRegistered.find((r) => r.opts.id === 'dsh-web-chat-entry').comp;
    const renderEntry = (wide) => {
      hookCursor.ref = 0;
      hookCursor.state = 0;
      layoutEffects.length = 0;
      portalCalls.length = 0;
      return Entry({ wide });
    };

    // Pass 1 (pre-layout): only an empty hidden anchor sits inside footerActions.
    const preLayoutTree = renderEntry(true);
    assert.equal(preLayoutTree.type, 'span');
    assert.equal(preLayoutTree.props.className, 'dsh-web-chat-slot-anchor');
    assert.equal(portalCalls.length, 0);

    // Mount the anchor element into footerActions and run layout effect.
    const anchorEl = win.document.createElement('span');
    anchorEl.className = 'dsh-web-chat-slot-anchor';
    anchorEl.setAttribute('aria-hidden', 'true');
    slotContainer.appendChild(anchorEl);
    preLayoutTree.props.ref.current = anchorEl;
    for (const fn of layoutEffects) fn();

    // Pass 2 (post-layout, wide=true): portal targets regionArea (outside footArea), anchor stays inert.
    const postWide = renderEntry(true);
    assert.equal(postWide.type, hookReact.Fragment);
    assert.equal(portalCalls.length, 1);
    assert.equal(portalCalls[0].container, regionArea);
    assert.equal(footArea.contains(portalCalls[0].container), false);
    assert.equal(anchorEl.textContent, '');
    assert.equal(anchorEl.querySelector('svg, img, canvas, button'), null);

    // Pass 3 (collapsed rail, wide=false): collapsed icon also portals to regionArea.
    const postNarrow = renderEntry(false);
    assert.equal(postNarrow.type, hookReact.Fragment);
    assert.equal(portalCalls.length, 1);
    assert.equal(portalCalls[0].container, regionArea);
    assert.equal(portalCalls[0].children.props.className, 'dsh-web-chat-foot-icon');

    // Verify CSS leaves footArea at order:5 without display:contents and supports data-ds-dark-theme.
    assert.doesNotMatch(injectedCss, /\[class\*="footArea"\]\{display:contents/);
    assert.doesNotMatch(injectedCss, /\[class\*="footerActions"\]\{display:contents/);
    assert.match(injectedCss, /\[class\*="footArea"\]\{order:5 !important;flex:0 0 auto !important\}/);
    assert.match(injectedCss, /\.dsh-web-chat-slot-anchor\{display:none !important\}/);
    assert.match(injectedCss, /data-ds-dark-theme/);

    for (const dispose of localEffects) {
      if (typeof dispose === 'function') dispose();
    }
  } finally {
    globalThis.window = prevWindow;
    globalThis.document = prevDocument;
    await win.happyDOM.abort();
  }
});
