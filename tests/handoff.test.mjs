import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
function fn(name, context = {}) {
  const match = source.match(new RegExp('    (?:async )?function ' + name + '\\([^]*?\\n    }'));
  assert.ok(match, name + ' exists');
  return vm.runInNewContext('(' + match[0] + ')', context);
}
const messages = [{ role: 'user', text: '问题' }, { role: 'assistant', text: '方案' }];
test('draft includes source and next action while preserving truncation warning', () => {
  const format = fn('formatHandoff');
  const text = format(messages, 'round', true, { title: '性能讨论', url: 'https://chat.deepseek.com/a/chat/s/abcdef', instruction: '检查本地配置' });
  assert.match(text, /来源：性能讨论/);
  assert.match(text, /https:\/\/chat.deepseek.com\/a\/chat\/s\/abcdef/);
  assert.match(text, /检查本地配置/);
  assert.match(text, /不完整|未包含/);
  assert.match(text, /### 我\n问题/);
  assert.match(text, /### DeepSeek\n方案/);
});
test('previous task is named from Host and a removed task cannot be selected', () => {
  let byId = { old: { displayTitle: '优化本地项目' } };
  const options = fn('handoffTaskOptions', { currentSessionId: () => 'old', appCtx: { get: name => name === 'sessions' ? { list: { getSnapshot: () => ({ byId }) } } : { list: { getSnapshot: () => ({ items: [{ workspaceId: 'w1', title: '本地项目', path: '/project', sessionIds: ['old'] }] }) } } } });
  assert.equal(options().previous.title, '优化本地项目');
  assert.equal(options().workspaces[0].id, 'w1');
  byId = {};
  assert.equal(options().previous, null);
});
test('new task receives exactly the preview text through its composer, without sending', async () => {
  const writes = [];
  const opened = [];
  const workspace = { connectWorkspace: async id => { assert.equal(id, 'w1'); return 'new-session'; }, openSession: id => opened.push(id) };
  const context = { state: { busy: false }, emit() {}, uiWorkspaceService: () => workspace, handoffTaskOptions: () => ({ previous: null, workspaces: [{ id: 'w1' }] }), leavePanelOnly() {}, insertWithRetry: async (id, text) => { writes.push({ id, text }); return { ok: true }; }, focusComposerFor() {}, notifyComposer() {}, navigator: { clipboard: { writeText: async () => {} } } };
  const result = await fn('doHandoff', context)('预览正文\n下一步', 'new', '', 'w1');
  assert.equal(result.ok, true);
  assert.deepEqual(opened, ['new-session']);
  assert.deepEqual(writes, [{ id: 'new-session', text: '预览正文\n下一步' }]);
});
test('removed destination is rejected without opening any task', async () => {
  const context = { state: { busy: false }, emit() {}, handoffTaskOptions: () => ({ previous: null, workspaces: [] }), uiWorkspaceService: () => { throw Error('must not navigate'); } };
  const result = await fn('doHandoff', context)('preview', 'current', 'removed', '');
  assert.equal(result.ok, false);
  assert.match(result.error, /任务.*不可用|任务.*不存在/);
});
test('latest range is requested from the guest rather than slicing an incomplete early history', async () => {
  let script = '';
  const capture = fn('captureMessages', { view: { getURL: () => 'https://chat.deepseek.com/a/chat/s/abcdef', executeJavaScript: async value => { script = value; return { ok: true, messages, truncated: false }; } }, extractInGuest() {}, window: { setTimeout: () => 1, clearTimeout() {} } });
  const result = await capture('round');
  assert.match(script, /\("round",/);
  assert.equal(result.messages.length, 2);
});

function componentHarness(name, extra = {}) {
  const slots = [];
  const effects = [];
  let cursor = 0;
  const React = {
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
    useRef(value) { const [ref] = this.useState({ current: value }); return ref; },
    useEffect(effect, deps) { const index = cursor++; const previous = slots[index]; if (!previous || deps.some((value, i) => value !== previous.deps[i])) { previous?.cleanup?.(); effects.push(() => { slots[index] = { deps, cleanup: effect() }; }); } },
  };
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value !== null && value !== false && value !== undefined) });
  const context = { React, h, state: { title: '来源会话' }, view: { getURL: () => 'https://chat.deepseek.com/a/chat/s/abcdef' }, currentSessionId: () => '', workspaceIdForSession: () => 'w1', handoffTaskOptions: () => ({ previous: null, workspaces: [{ id: 'w1', title: '项目' }] }), captureMessages: async () => ({ messages, truncated: false }), formatHandoff: fn('formatHandoff'), ...extra };
  const renderComponent = fn(name, context);
  let tree;
  const render = () => { cursor = 0; tree = renderComponent({ onClose() {} }); return tree; };
  const all = (node = tree) => typeof node !== 'object' ? [] : [node, ...node.children.flatMap(child => all(child))];
  return { render, all, flush: async () => { for (const effect of effects.splice(0)) effect(); await new Promise(resolve => setImmediate(resolve)); render(); } };
}
test('dialog defaults to recent round and new task and confirms the reviewed text only', async () => {
  let delivered;
  const harness = componentHarness('HandoffDialog', { doHandoff: async (...args) => { delivered = args; return { ok: true }; } });
  harness.render();
  await harness.flush();
  let nodes = harness.all();
  assert.equal(nodes.find(node => node.props['aria-label'] === '带哪些内容').props.value, 'round');
  assert.equal(nodes.find(node => node.props['aria-label'] === '交给哪个任务').props.value, 'new');
  const oldTask = nodes.find(node => node.type === 'option' && node.props.value === 'current');
  assert.equal(oldTask.props.disabled, true);
  nodes.find(node => node.props['aria-label'] === '接下来做什么').props.onChange({ target: { value: '修改配置' } });
  harness.render();
  nodes = harness.all();
  const preview = nodes.find(node => node.props['aria-label'] === '草稿预览').props.value;
  assert.match(preview, /修改配置/);
  assert.equal(delivered, undefined);
  await nodes.find(node => node.type === 'button' && node.children.includes('填入任务草稿')).props.onClick();
  assert.equal(delivered[0], preview);
  assert.equal(delivered[1], 'new');
  assert.equal(delivered[3], 'w1');
});
test('a stale async scope result never replaces the current preview', async () => {
  const resolves = [];
  const harness = componentHarness('HandoffDialog', { captureMessages: mode => new Promise(resolve => resolves.push({ mode, resolve })) });
  harness.render(); await harness.flush();
  harness.all().find(node => node.props['aria-label'] === '带哪些内容').props.onChange({ target: { value: 'all' } });
  harness.render(); await harness.flush();
  resolves[1].resolve({ messages: [{ role: 'assistant', text: '完整记录' }], truncated: true });
  await harness.flush();
  resolves[0].resolve({ messages: [{ role: 'assistant', text: '过期预览' }], truncated: false });
  await harness.flush();
  const preview = harness.all().find(node => node.props['aria-label'] === '草稿预览').props.value;
  assert.match(preview, /完整记录/);
  assert.doesNotMatch(preview, /过期预览/);
  assert.ok(harness.all().some(node => node.props.role === 'alert'));
});

test('retry refreshes workspaces that became available after opening the dialog', async () => {
  let workspaces = [];
  const harness = componentHarness('HandoffDialog', { handoffTaskOptions: () => ({ previous: null, workspaces }) });
  harness.render(); await harness.flush();
  workspaces = [{ id: 'w2', title: '刚加载的项目' }];
  harness.all().find(node => node.type === 'button' && node.children.includes('重新读取')).props.onClick();
  harness.render(); await harness.flush();
  assert.ok(harness.all().some(node => node.type === 'option' && node.props.value === 'w2'));
});

import { Window } from 'happy-dom';
test('virtualized latest-round extraction walks backward from the tail and restores scroll position', async () => {
  const window = new Window({ url: 'https://chat.deepseek.com/' });
  const document = window.document;
  document.body.innerHTML = '<div id="scroll" style="overflow-y:auto"></div>';
  const scroller = document.getElementById('scroll');
  let top = 100;
  const render = () => {
    scroller.innerHTML = top >= 1500 ? '<div data-virtual-list-item-key="latest-answer"><div class="ds-assistant-message-main-content">最新回复</div></div>' : top >= 1000 ? '<div data-virtual-list-item-key="latest-user">最新问题</div><div data-virtual-list-item-key="latest-answer"><div class="ds-assistant-message-main-content">最新回复</div></div>' : '<div data-virtual-list-item-key="old-user">旧问题</div><div data-virtual-list-item-key="old-answer"><div class="ds-assistant-message-main-content">旧回复</div></div>';
  };
  Object.defineProperties(scroller, { scrollHeight: { get: () => 2000 }, clientHeight: { get: () => 400 }, scrollTop: { get: () => top, set: value => { top = Math.max(0, Math.min(1600, value)); render(); } } });
  render();
  const extract = fn('extractInGuest', { window, document, getComputedStyle: el => window.getComputedStyle(el), setTimeout: callback => { queueMicrotask(callback); return 1; }, clearTimeout() {}, requestAnimationFrame: callback => queueMicrotask(callback), console: { log() {} } });
  const result = await extract('round', null, null);
  assert.deepEqual(Array.from(result.messages, row => row.text), ['最新问题', '最新回复']);
  assert.equal(result.truncated, false);
  assert.equal(top, 100);
  await window.happyDOM.abort();
});

test('streaming replies carry an incomplete warning for latest and full-history capture', async () => {
  for (const mode of ['round', 'all']) {
    const window = new Window({ url: 'https://chat.deepseek.com/' });
    const document = window.document;
    document.body.innerHTML = '<button aria-label="停止生成"></button><div data-virtual-list-item-key="user">问题</div><div data-virtual-list-item-key="answer"><div class="ds-assistant-message-main-content">生成到一半</div></div>';
    const extract = fn('extractInGuest', { window, document, getComputedStyle: el => window.getComputedStyle(el), setTimeout: callback => { queueMicrotask(callback); return 1; }, clearTimeout() {}, requestAnimationFrame: callback => queueMicrotask(callback), console: { log() {} } });
    const result = await extract(mode, null, null);
    assert.equal(result.generating, true);
    assert.equal(result.truncated, true);
    await window.happyDOM.abort();
  }
});
test('preview explicitly warns when the captured reply is still generating', async () => {
  const harness = componentHarness('HandoffDialog', { captureMessages: async () => ({ messages, truncated: true, generating: true }) });
  harness.render(); await harness.flush();
  assert.ok(harness.all().some(node => node.props.role === 'alert' && node.children.some(child => typeof child === 'string' && child.includes('仍在生成'))));
});

test('unlabelled streaming text changes also mark the preview incomplete', async () => {
  const window = new Window({ url: 'https://chat.deepseek.com/' });
  const document = window.document;
  document.body.innerHTML = '<div data-virtual-list-item-key="u">问题</div><div data-virtual-list-item-key="a"><div class="ds-assistant-message-main-content">半截</div></div>';
  const extract = fn('extractInGuest', { window, document, getComputedStyle: el => window.getComputedStyle(el), setTimeout: callback => { queueMicrotask(() => { document.querySelector('.ds-assistant-message-main-content').textContent = '半截回答继续增长'; callback(); }); return 1; }, clearTimeout() {}, requestAnimationFrame: callback => queueMicrotask(callback), console: { log() {} } });
  const result = await extract('round', null, null);
  assert.equal(result.generating, true);
  assert.equal(result.truncated, true);
  await window.happyDOM.abort();
});
test('capture retains generation state even if a guest reports history traversal as complete', async () => {
  const capture = fn('captureMessages', { view: { executeJavaScript: async () => ({ ok: true, messages, truncated: false, generating: true }) }, extractInGuest() {}, window: { setTimeout: () => 1, clearTimeout() {} } });
  const result = await capture('round');
  assert.equal(result.generating, true);
  assert.equal(result.truncated, true);
});
