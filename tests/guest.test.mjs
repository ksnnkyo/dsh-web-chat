import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Window } from 'happy-dom';

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
function guestFunction(name, context) {
  const match = source.match(new RegExp('    (?:async )?function ' + name + '\\([^]*?\\n    }'));
  assert.ok(match, name);
  return vm.runInNewContext('(' + match[0] + ')', context);
}
function rect(node, x, y, width, height) {
  node.getBoundingClientRect = () => ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height });
}
function fixture() {
  const window = new Window({ url: 'https://chat.deepseek.com/a/chat/s/abcdef' });
  window.setInterval = () => 1;
  window.document.body.innerHTML = '<div id="root"><div id="header"><div id="nav"><svg></svg><button></button><button></button><button></button></div><div>会话标题</div><button id="share"></button></div><main><div class="ds-markdown"><button></button><button></button><button></button>正文</div><textarea></textarea></main></div>';
  const document = window.document;
  rect(document.getElementById('root'), 0, 0, 1200, 900);
  rect(document.getElementById('header'), 0, 0, 1200, 64);
  rect(document.getElementById('nav'), 16, 12, 220, 40);
  rect(document.querySelector('main'), 0, 64, 1200, 836);
  rect(document.querySelector('.ds-markdown'), 160, 80, 800, 50);
  for (const button of document.querySelectorAll('button')) rect(button, 32, 16, 32, 32);
  return { window, document };
}

test('unlabelled top navigation and duplicate title are hidden without hiding chat content', async () => {
  const context = fixture();
  guestFunction('hideWebSidebarInGuest', context)();
  assert.equal(context.document.getElementById('header').hasAttribute('data-dsh-web-chat-webheader'), true);
  assert.equal(context.document.querySelector('main').hasAttribute('data-dsh-web-chat-webheader'), false);
  assert.equal(context.document.querySelector('.ds-markdown').hasAttribute('data-dsh-web-chat-webheader'), false);
  await context.window.happyDOM.abort();
});

test('native sidebar with a single conversation is hidden', async () => {
  const context = fixture();
  const sidebar = context.document.createElement('aside');
  sidebar.innerHTML = '<a href="/a/chat/s/abcdef">唯一会话</a>';
  context.document.getElementById('root').prepend(sidebar);
  rect(sidebar, 0, 0, 260, 900);
  guestFunction('hideWebSidebarInGuest', context)();
  assert.equal(sidebar.hasAttribute('data-dsh-web-chat-websidebar'), true);
  await context.window.happyDOM.abort();
});

test('navigation mounted after injection is hidden by the observer', async () => {
  const context = fixture();
  const header = context.document.getElementById('header');
  header.remove();
  guestFunction('hideWebSidebarInGuest', context)();
  context.document.getElementById('root').prepend(header);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(header.hasAttribute('data-dsh-web-chat-webheader'), true);
  await context.window.happyDOM.abort();
});

function lifecycle({ auth = 'out', applied = true, url = 'https://chat.deepseek.com/' } = {}) {
  const events = [];
  const loads = [];
  const scripts = [];
  const context = {
    view: { style: {}, getURL: () => url, executeJavaScript: async code => { scripts.push(code); return code.includes('installSessionInGuest') ? { applied } : false; },
      loadURL: async target => { loads.push(target); }, reload: () => loads.push(url) },
    prepared: false, preparation: null, loginApplied: false, localeApplied: false, reloadingForLogin: false,
    sharedSession: { cookies: [], writes: [{ key: 'userToken', value: 'fixture' }] }, sharedSessionSource: 'local',
    pendingConversationId: 'abcdef', CONVERSATION_URL: 'https://chat.deepseek.com/a/chat/s/', TARGET: 'https://chat.deepseek.com/',
    state: { notice: '' }, window: { setTimeout: () => 1 },
    emit: event => events.push(event), emitSessionList() {}, syncGuestTitle() {}, saveOwnSession() {}, refreshSessionList() {},
    probeAuth: async () => auth, sharedLoginWrites: session => session.writes,
    installSessionInGuest() {}, forceChineseLocaleInGuest() {}, injectHideWebSidebar: async () => {},
    pathOf: target => new URL(target).pathname,
  };
  context.initializeGuest = guestFunction('initializeGuest', context);
  context.prepareGuest = guestFunction('prepareGuest', context);
  return { context, events, loads, scripts, finish: guestFunction('handleDidFinishLoad', context) };
}

test('restoring login never publishes ready for the intermediate page and loads the requested conversation', async () => {
  const { finish, events, loads } = lifecycle();
  await finish();
  assert.equal(events.some(event => event.phase === 'ready'), false);
  assert.deepEqual(loads, ['https://chat.deepseek.com/a/chat/s/abcdef']);
});

test('a live authenticated session is not overwritten with an older saved snapshot', async () => {
  const { finish, loads, scripts } = lifecycle({ auth: 'in', url: 'https://chat.deepseek.com/a/chat/s/abcdef' });
  await finish();
  assert.deepEqual(loads, []);
  assert.equal(scripts.some(code => code.includes('installSessionInGuest')), false);
});

test('portal navigation at 157px and the separate website header are both hidden', async () => {
  const context = fixture();
  const { document, window } = context;
  const header = document.getElementById('header');
  header.className = 'the-header';
  const nav = document.getElementById('nav');
  const portal = document.createElement('div');
  rect(portal, 0, 0, 1200, 900);
  document.body.append(portal);
  portal.append(nav);
  rect(nav, 16, 12, 157, 40);
  guestFunction('hideWebSidebarInGuest', context)();
  assert.equal(nav.hasAttribute('data-dsh-web-chat-webheader'), true);
  assert.equal(header.hasAttribute('data-dsh-web-chat-webheader'), true);
  assert.equal(portal.hasAttribute('data-dsh-web-chat-webheader'), false);
  await window.happyDOM.abort();
});

test('overlapping load handlers await one initialization and never reveal its intermediate page', async () => {
  const { context, finish, events, loads } = lifecycle();
  let resolveAuth;
  let calls = 0;
  context.probeAuth = () => ++calls === 1 ? new Promise(resolve => { resolveAuth = resolve; }) : Promise.resolve('out');
  const first = finish();
  await Promise.resolve();
  const second = finish(false);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(events.some(event => event.phase === 'ready'), false);
  assert.equal(calls, 1);
  resolveAuth('out');
  await Promise.all([first, second]);
  assert.equal(loads.length, 1);
  context.view.getURL = () => 'https://chat.deepseek.com/a/chat/s/abcdef';
  context.probeAuth = async () => 'in';
  await finish();
  assert.equal(context.view.style.opacity, '1');
  assert.equal(events.some(event => event.phase === 'ready'), true);
});
