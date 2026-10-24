window.__ModuleLoader__.load({
  id: 'dsh-web-chat',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // 嵌入核心沿用 dsh-deepseek-web-chat：DSH 内嵌浏览器租约 + 共享网页登录态。
    // 交互形态：左侧栏「会话」列表负责选会话；选中后网页铺在**当前对话内容区**上，
    // 保留原生会话头（账号头像/名称、•••、右侧栏开关）不动。
    const TARGET = 'https://chat.deepseek.com/';
    const PANEL_ID = 'dsh-web-chat-page';
    const WORKSPACE_KEY = 'dsh-web-chat-browser';
    const SESSION_LIST_API = '/dsh-web-chat/api/sessions';
    const SESSION_LIST_REFRESH_MS = 20000;
    const CONVERSATION_URL = 'https://chat.deepseek.com/a/chat/s/';
    const UI_PREFS_KEY = 'dsh-web-chat.ui.v1';
    const SESSION_LIMIT_DEFAULT = 20;
    const SESSION_LIMIT_MAX = 60;
    const UNGROUPED_KEY = '__ungrouped';
    const GROUP_NAME_LIMIT = 24;
    const SHARED_LOGIN_API = '/deepseek-web-login/api/browser/session';
    const SHARED_LOGIN_TIMEOUT_MS = 4000;
    const SHARED_LOGIN_MAX_ENTRIES = 96;
    const SHARED_LOGIN_MAX_VALUE = 200000;
    const TOOLBAR_HEIGHT = 40;
    const LOW_BALANCE_THRESHOLD = 1;
    const CRITICAL_BALANCE_THRESHOLD = 0.1;

    let appCtx = null;

    // ---------- 极简 store ----------
    let state = { phase: 'idle', auth: 'unknown', error: '', notice: '', busy: false, title: '' };
    const stateListeners = new Set();
    function emit(patch) {
      state = Object.assign({}, state, patch);
      for (const fn of [...stateListeners]) {
        try {
          fn();
        } catch (error) {
          /* store listeners are best effort */
        }
      }
    }
    function subscribeState(fn) {
      stateListeners.add(fn);
      return () => stateListeners.delete(fn);
    }
    function useAppState() {
      return React.useSyncExternalStore(subscribeState, () => state, () => state);
    }

    // ---------- 会话页签矩形 ----------
    let areaRect = null;
    const rectListeners = new Set();
    function publishAreaRect(next) {
      areaRect = next;
      for (const fn of [...rectListeners]) {
        try {
          fn();
        } catch (error) {
          /* rect listeners are best effort */
        }
      }
    }
    function subscribeRect(fn) {
      rectListeners.add(fn);
      return () => rectListeners.delete(fn);
    }
    function useAreaRect() {
      return React.useSyncExternalStore(subscribeRect, () => areaRect, () => areaRect);
    }

    // ---------- 打开状态 / 界面偏好（折叠、显示更多、置顶）----------
    let pageOpen = false;
    const pageOpenListeners = new Set();
    function setPageOpen(value) {
      const next = value === true;
      if (pageOpen === next) return;
      pageOpen = next;
      try {
        document.documentElement.classList.toggle('dsh-web-chat-page-open', next);
      } catch (error) {
        /* class toggle is best effort */
      }
      for (const fn of [...pageOpenListeners]) {
        try {
          fn();
        } catch (error) {
          /* page listeners are best effort */
        }
      }
    }
    function subscribePageOpen(fn) {
      pageOpenListeners.add(fn);
      return () => pageOpenListeners.delete(fn);
    }
    function usePageOpen() {
      return React.useSyncExternalStore(subscribePageOpen, () => pageOpen, () => pageOpen);
    }

    function readLocalJson(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key);
        if (raw === null || raw === '') return fallback;
        const parsed = JSON.parse(raw);
        return parsed === null || parsed === undefined ? fallback : parsed;
      } catch (error) {
        return fallback;
      }
    }

    function writeLocalJson(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (error) {
        return false;
      }
    }

    /** Copy legacy groups/preferences only before DSH Chat has its own preferences. */
    function migrateLegacyUiPrefs() {
      try {
        if (window.localStorage.getItem(UI_PREFS_KEY) !== null) return false;
        const previous = readLocalJson('dsh-deepseek-webdesk.ui.v1', null);
        if (previous === null || typeof previous !== 'object' || Array.isArray(previous)) return false;
        return writeLocalJson(UI_PREFS_KEY, previous);
      } catch (error) {
        return false;
      }
    }

    function loadUiPrefs() {
      const raw = readLocalJson(UI_PREFS_KEY, {});
      const limit = Number(raw.limit);
      // 分组只存在本机（DeepSeek 云端没有分组概念）；assignments 允许引用未加载的会话 id，
      // 会话重新进入列表窗口时自动恢复分组。
      const groups = [];
      if (Array.isArray(raw.groups)) {
        for (const row of raw.groups) {
          if (row === null || typeof row !== 'object' || typeof row.id !== 'string' || row.id === '') continue;
          const name = typeof row.name === 'string' ? row.name.trim().slice(0, GROUP_NAME_LIMIT) : '';
          if (name === '' || groups.some((group) => group.id === row.id)) continue;
          groups.push({ id: row.id, name, createdAt: Number(row.createdAt) > 0 ? Number(row.createdAt) : Date.now() });
        }
      }
      const groupIds = new Set(groups.map((group) => group.id));
      const assignments = {};
      if (raw.assignments !== null && typeof raw.assignments === 'object') {
        for (const [sessionId, groupId] of Object.entries(raw.assignments)) {
          if (typeof sessionId === 'string' && sessionId !== '' && groupIds.has(groupId)) assignments[sessionId] = groupId;
        }
      }
      const sectionStates = {};
      if (raw.sectionStates !== null && typeof raw.sectionStates === 'object') {
        for (const [key, value] of Object.entries(raw.sectionStates)) {
          if (typeof key !== 'string' || key === '') continue;
          if (value !== 'expanded' && value !== 'collapsed') continue;
          if (key !== UNGROUPED_KEY && !groupIds.has(key)) continue;
          sectionStates[key] = value;
        }
      }
      return {
        collapsed: raw.collapsed === true,
        limit: Number.isFinite(limit) ? Math.max(SESSION_LIMIT_DEFAULT, Math.min(SESSION_LIMIT_MAX, Math.floor(limit))) : SESSION_LIMIT_DEFAULT,
        pins: Array.isArray(raw.pins) ? raw.pins.filter((id) => typeof id === 'string' && id !== '').slice(0, 200) : [],
        // 头像上方的「今日/总计 token 用量 + 余额」行，默认开，可在「设置 → 通用」里关掉。
        usageRow: raw.usageRow !== false,
        groups,
        assignments,
        // 分区显隐的显式覆盖（expanded/collapsed）；没有覆盖的分区走“默认展开到分组”规则（见 sectionCollapsed）。
        sectionStates,
      };
    }

    migrateLegacyUiPrefs();
    let uiPrefs = loadUiPrefs();
    const uiPrefsListeners = new Set();
    function emitUiPrefs() {
      for (const fn of [...uiPrefsListeners]) {
        try {
          fn();
        } catch (error) {
          /* prefs listeners are best effort */
        }
      }
    }
    function subscribeUiPrefs(fn) {
      uiPrefsListeners.add(fn);
      return () => uiPrefsListeners.delete(fn);
    }
    function useUiPrefs() {
      return React.useSyncExternalStore(subscribeUiPrefs, () => uiPrefs, () => uiPrefs);
    }
    function updateUiPrefs(patch) {
      uiPrefs = Object.assign({}, uiPrefs, patch);
      writeLocalJson(UI_PREFS_KEY, uiPrefs);
      emitUiPrefs();
    }
    function togglePinnedSession(id) {
      if (typeof id !== 'string' || id === '') return;
      const pins = new Set(uiPrefs.pins);
      if (pins.has(id)) pins.delete(id);
      else pins.add(id);
      updateUiPrefs({ pins: [...pins].slice(0, 200) });
    }

    // ---------- 会话分组（只存本机 uiPrefs，写完即持久化）----------
    function createGroup(name, assignSessionId) {
      const trimmed = name.trim().slice(0, GROUP_NAME_LIMIT);
      if (trimmed === '') return null;
      const id = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const patch = { groups: [...uiPrefs.groups, { id, name: trimmed, createdAt: Date.now() }] };
      if (typeof assignSessionId === 'string' && assignSessionId !== '') {
        patch.assignments = { ...uiPrefs.assignments, [assignSessionId]: id };
      }
      updateUiPrefs(patch);
      return id;
    }

    function renameGroup(id, name) {
      const trimmed = name.trim().slice(0, GROUP_NAME_LIMIT);
      if (trimmed === '' || !uiPrefs.groups.some((group) => group.id === id)) return false;
      updateUiPrefs({ groups: uiPrefs.groups.map((group) => (group.id === id ? { ...group, name: trimmed } : group)) });
      return true;
    }

    /** 删组不删会话：成员的归组关系一并清除，自动回到未分组。 */
    function deleteGroup(id) {
      if (!uiPrefs.groups.some((group) => group.id === id)) return;
      const assignments = {};
      for (const [sessionId, groupId] of Object.entries(uiPrefs.assignments)) {
        if (groupId !== id) assignments[sessionId] = groupId;
      }
      const sectionStates = { ...uiPrefs.sectionStates };
      delete sectionStates[id];
      updateUiPrefs({
        groups: uiPrefs.groups.filter((group) => group.id !== id),
        assignments,
        sectionStates,
      });
    }

    function assignSession(sessionId, groupId) {
      if (typeof sessionId !== 'string' || sessionId === '') return;
      const assignments = { ...uiPrefs.assignments };
      if (groupId === null || groupId === undefined || groupId === '') delete assignments[sessionId];
      else if (uiPrefs.groups.some((group) => group.id === groupId)) assignments[sessionId] = groupId;
      updateUiPrefs({ assignments });
    }

    /** 默认展开到分组：各分区默认只显示组头；仅当没有任何自定义分组时，未分组默认展开。显式覆盖存 sectionStates。 */
    function sectionCollapsed(key) {
      const override = uiPrefs.sectionStates[key];
      if (override === 'expanded') return false;
      if (override === 'collapsed') return true;
      return !(key === UNGROUPED_KEY && uiPrefs.groups.length === 0);
    }

    function toggleSectionCollapsed(key) {
      if (typeof key !== 'string' || key === '') return;
      const next = sectionCollapsed(key) ? 'expanded' : 'collapsed';
      updateUiPrefs({ sectionStates: { ...uiPrefs.sectionStates, [key]: next } });
    }

    // ---------- 网页会话列表（由 host 半读 DSH 网页登录账号后提供）----------
    let sessionList = { status: 'idle', rows: [], error: '', activeId: '', hasMore: false };
    const sessionListListeners = new Set();
    function emitSessionList(patch) {
      sessionList = Object.assign({}, sessionList, patch);
      for (const fn of [...sessionListListeners]) {
        try {
          fn();
        } catch (error) {
          /* list listeners are best effort */
        }
      }
    }
    function subscribeSessionList(fn) {
      sessionListListeners.add(fn);
      return () => sessionListListeners.delete(fn);
    }
    function useSessionList() {
      return React.useSyncExternalStore(subscribeSessionList, () => sessionList, () => sessionList);
    }
    let sessionListFetching = false;
    async function refreshSessionList() {
      if (sessionListFetching) return;
      sessionListFetching = true;
      emitSessionList({ status: sessionList.rows.length > 0 ? 'refreshing' : 'loading', error: '' });
      try {
        const url = SESSION_LIST_API + '?count=' + Math.max(SESSION_LIMIT_DEFAULT, uiPrefs.limit);
        const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
        const payload = response.ok ? await response.json() : null;
        if (payload !== null && typeof payload === 'object' && payload.ok === true && Array.isArray(payload.sessions)) {
          const rows = [];
          for (const row of payload.sessions) {
            if (row === null || typeof row !== 'object' || typeof row.id !== 'string' || row.id === '') continue;
            rows.push({
              id: row.id,
              title: typeof row.title === 'string' && row.title !== '' ? row.title : '未命名会话',
              pinned: row.pinned === true,
              updatedAt: Number(row.updatedAt) > 0 ? Number(row.updatedAt) : 0,
            });
          }
          emitSessionList({ status: 'ready', rows, error: '', hasMore: payload.hasMore === true });
        } else {
          emitSessionList({
            status: 'error',
            error: payload !== null && typeof payload === 'object' && typeof payload.error === 'string' ? payload.error : '无法读取网页会话列表',
          });
        }
      } catch (error) {
        emitSessionList({ status: 'error', error: String((error && error.message) || error) });
      } finally {
        sessionListFetching = false;
      }
    }

    async function pinWebSession(id, pinned) {
      try {
        const response = await fetch('/dsh-web-chat/api/sessions/pin', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, pinned: pinned === true }),
        });
        const payload = response.ok ? await response.json().catch(() => null) : null;
        if (payload !== null && payload !== undefined && payload.ok === true) {
          await refreshSessionList();
          return true;
        }
      } catch (error) {
        /* pin is best effort */
      }
      emit({ notice: '置顶失败' });
      clearNoticeSoon();
      return false;
    }

    async function deleteWebSession(id) {
      try {
        const response = await fetch('/dsh-web-chat/api/sessions/delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id }),
        });
        const payload = response.ok ? await response.json().catch(() => null) : null;
        if (payload !== null && payload !== undefined && payload.ok === true) {
          emitSessionList({ rows: sessionList.rows.filter((row) => row.id !== id) });
          if (sessionList.activeId === id) closePage();
          await refreshSessionList();
          return true;
        }
      } catch (error) {
        /* delete is best effort */
      }
      emit({ notice: '删除失败' });
      clearNoticeSoon();
      return false;
    }

    function getBridge() {
      const desktop = globalThis.dshDesktop;
      if (desktop === null || typeof desktop !== 'object' || desktop.protocolVersion !== 1) return undefined;
      const browser = desktop.browser;
      if (browser === undefined || typeof browser.acquire !== 'function') return undefined;
      return browser;
    }

    // ---------- 共享登录态（复用 dsh-deepseek-web-login）----------
    function normalizeSharedLoginSession(raw) {
      if (raw === null || typeof raw !== 'object' || raw.ok !== true) return null;
      const storage = {};
      let count = 0;
      if (raw.storage !== null && typeof raw.storage === 'object') {
        for (const key of Object.keys(raw.storage)) {
          if (count >= SHARED_LOGIN_MAX_ENTRIES) break;
          const value = raw.storage[key];
          if (typeof key !== 'string' || key === '' || typeof value !== 'string') continue;
          storage[key] = value.slice(0, SHARED_LOGIN_MAX_VALUE);
          count += 1;
        }
      }
      const writes = [];
      if (Array.isArray(raw.writes)) {
        for (const entry of raw.writes) {
          if (writes.length >= SHARED_LOGIN_MAX_ENTRIES) break;
          if (entry === null || typeof entry !== 'object') continue;
          if (typeof entry.key !== 'string' || entry.key === '' || typeof entry.value !== 'string') continue;
          writes.push({ key: entry.key, value: entry.value.slice(0, SHARED_LOGIN_MAX_VALUE) });
        }
      }
      const cookies = [];
      if (typeof raw.cookie === 'string') {
        for (const part of raw.cookie.split(';')) {
          const item = part.trim();
          if (item === '' || item.indexOf('=') <= 0) continue;
          cookies.push(item);
          if (cookies.length >= SHARED_LOGIN_MAX_ENTRIES) break;
        }
      }
      const userAgent = typeof raw.userAgent === 'string' && raw.userAgent.length <= 500 ? raw.userAgent.trim() : '';
      if (writes.length === 0 && cookies.length === 0 && Object.keys(storage).length === 0) return null;
      return { writes, storage, cookies, userAgent };
    }

    function sharedLoginWrites(session) {
      const rows = [];
      const index = new Map();
      const push = (key, value) => {
        if (!index.has(key)) {
          index.set(key, rows.length);
          rows.push({ key, value });
          return;
        }
        rows[index.get(key)] = { key, value };
      };
      if (session !== null && session !== undefined && session.storage !== null && typeof session.storage === 'object') {
        for (const key of Object.keys(session.storage)) {
          if (typeof session.storage[key] === 'string') push(key, session.storage[key]);
        }
      }
      for (const entry of (session !== null && session !== undefined && Array.isArray(session.writes) ? session.writes : [])) {
        if (entry !== null && typeof entry === 'object' && typeof entry.key === 'string') {
          push(entry.key, String(entry.value !== undefined && entry.value !== null ? entry.value : ''));
        }
      }
      return rows;
    }

    async function fetchSharedLoginSession() {
      let timer = 0;
      try {
        const response = await Promise.race([
          fetch(SHARED_LOGIN_API, { credentials: 'same-origin', cache: 'no-store' }),
          new Promise((resolve) => {
            timer = window.setTimeout(() => resolve(null), SHARED_LOGIN_TIMEOUT_MS);
          }),
        ]);
        if (response === null || response === undefined || response.ok !== true) return null;
        return normalizeSharedLoginSession(await response.json());
      } catch (error) {
        return null;
      } finally {
        window.clearTimeout(timer);
      }
    }

    /** 读取本插件自己保存的登录态（优先于 dsh-deepseek-web-login）。 */
    async function fetchOwnSession() {
      try {
        const response = await fetch('/dsh-web-chat/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok) return null;
        const payload = await response.json().catch(() => null);
        const session = payload !== null && payload !== undefined && payload.ok === true ? payload.session : null;
        if (session === null || typeof session !== 'object') return null;
        const cookie = Array.isArray(session.cookies) ? session.cookies.join('; ') : typeof session.cookie === 'string' ? session.cookie : '';
        return normalizeSharedLoginSession({
          ok: true,
          writes: Array.isArray(session.writes) ? session.writes : [],
          storage: session.storage !== null && typeof session.storage === 'object' ? session.storage : {},
          cookie,
          userAgent: typeof session.userAgent === 'string' ? session.userAgent : '',
        });
      } catch (error) {
        return null;
      }
    }

    /** 页面内抓取当前登录态（localStorage + 可读 cookie + UA）。序列化执行。 */
    function captureSessionInGuest() {
      const storage = {};
      try {
        for (let index = 0; index < window.localStorage.length; index += 1) {
          const key = window.localStorage.key(index);
          if (typeof key === 'string' && key !== '') storage[key] = String(window.localStorage.getItem(key) ?? '');
        }
      } catch (error) {
        /* storage may be unavailable */
      }
      const cookies = [];
      try {
        for (const part of String(document.cookie || '').split(';')) {
          const item = part.trim();
          if (item !== '' && item.indexOf('=') > 0) cookies.push(item);
        }
      } catch (error) {
        /* cookies may be unavailable */
      }
      return { storage, cookies, userAgent: String(navigator.userAgent || '') };
    }

    /** 把页面里的登录态存回 ~/.dsh/dsh-web-chat/session.json，重启后自动恢复。 */
    async function saveOwnSession(view) {
      if (view === null) return false;
      try {
        const snapshot = await view.executeJavaScript('(' + captureSessionInGuest.toString() + ')()', false);
        if (snapshot === null || typeof snapshot !== 'object') return false;
        const storage = snapshot.storage;
        if (storage === null || typeof storage !== 'object') return false;
        const raw = typeof storage.userToken === 'string' ? storage.userToken : '';
        if (raw === '' || raw.indexOf('"value":null') >= 0) return false;
        const response = await fetch('/dsh-web-chat/api/auth/session', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(snapshot),
        });
        return response.ok;
      } catch (error) {
        return false;
      }
    }

    /** 页面内安装：写 localStorage / 非 HttpOnly cookie，并强制中文界面。序列化后执行，不能引用外层。 */
    function installSessionInGuest(payload) {
      const isRecord = (value) => value !== null && typeof value === 'object';
      const writes = isRecord(payload) && Array.isArray(payload.writes) ? payload.writes : [];
      const cookies = isRecord(payload) && Array.isArray(payload.cookies) ? payload.cookies : [];
      const result = { applied: false, written: 0, failed: 0, cookies: 0, locale: false };
      let origin = '';
      try {
        origin = String(window.location.origin);
      } catch (error) {
        origin = '';
      }
      if (origin === '' || origin === 'null' || origin === 'about:blank') return result;
      for (let c = 0; c < cookies.length; c += 1) {
        try {
          document.cookie = String(cookies[c]) + '; path=/';
          result.cookies += 1;
        } catch (error) {
          /* cookie writes are best effort */
        }
      }
      for (let i = 0; i < writes.length; i += 1) {
        const row = writes[i];
        if (!isRecord(row) || typeof row.key !== 'string' || row.key === '') continue;
        try {
          window.localStorage.setItem(row.key, String(row.value !== undefined && row.value !== null ? row.value : ''));
          result.written += 1;
        } catch (error) {
          result.failed += 1;
        }
      }
      try {
        window.localStorage.setItem('__appKit_@deepseek/chat_localePreference', '{"value":"zh_CN","__version":"0"}');
        result.locale = true;
      } catch (error) {
        result.locale = false;
      }
      result.applied = result.written > 0 || result.cookies > 0;
      return result;
    }

    /** 已有登录态时也要把语言钉成中文（只改语言，不动登录）。 */
    function forceChineseLocaleInGuest() {
      try {
        const next = '{"value":"zh_CN","__version":"0"}';
        const previous = window.localStorage.getItem('__appKit_@deepseek/chat_localePreference');
        if (previous === next) return false;
        window.localStorage.setItem('__appKit_@deepseek/chat_localePreference', next);
        return true;
      } catch (error) {
        return false;
      }
    }

    /** Hide duplicated website navigation without relying on hashed classes or button labels.
     * Keep the sidebar mounted so its conversation links remain available for SPA navigation.
     * Serialized into the guest; all dependencies must be local to this function.
     */
    function hideWebSidebarInGuest() {
      let style = document.querySelector('style[data-dsh-web-chat-hide-sidebar]');
      if (style === null) {
        style = document.createElement('style');
        style.setAttribute('data-dsh-web-chat-hide-sidebar', '1');
        (document.head || document.documentElement).appendChild(style);
      }
      style.textContent =
        '[data-dsh-web-chat-websidebar]{position:fixed !important;visibility:hidden !important;pointer-events:none !important}' +
        '[data-dsh-web-chat-webheader]{display:none !important}';
      const hasContent = (node) => node.querySelector('textarea,[contenteditable="true"],.ds-markdown') !== null;
      const mark = () => {
        // One conversation is enough. Never treat a content/composer ancestor as navigation.
        const links = document.querySelectorAll('a[href^="/a/chat/s/"]');
        for (const link of links) {
          let node = link.parentElement;
          let sidebar = null;
          while (node !== null && node !== document.body) {
            const rect = node.getBoundingClientRect();
            if (rect.width >= 168 && rect.width <= 360 && rect.height >= 300 && !hasContent(node)) sidebar = node;
            node = node.parentElement;
          }
          if (sidebar !== null && !sidebar.hasAttribute('data-dsh-web-chat-websidebar')) sidebar.setAttribute('data-dsh-web-chat-websidebar', '1');
        }
        // The site renders title headers separately from the portal-mounted navigation.
        for (const header of document.querySelectorAll('.the-header')) {
          if (!hasContent(header) && !header.hasAttribute('data-dsh-web-chat-webheader')) header.setAttribute('data-dsh-web-chat-webheader', '1');
        }
        // The collapsed header has unlabelled icon buttons. Find its shallow top row,
        // including logo and duplicate title, while excluding message action toolbars.
        for (const button of document.querySelectorAll('button,[role="button"]')) {
          const rect = button.getBoundingClientRect();
          if (rect.width === 0 || rect.top < 0 || rect.top > 96 || rect.left > 240) continue;
          if (button.closest('[data-dsh-web-chat-websidebar],.ds-markdown') !== null) continue;
          let node = button.parentElement;
          let header = null;
          while (node !== null && node !== document.body) {
            const box = node.getBoundingClientRect();
            if (box.height > 100) break;
            if (box.height > 0 && box.width >= 100 && box.top >= 0 && box.top <= 96 &&
                !hasContent(node) && node.querySelectorAll('button,[role="button"]').length >= 3 &&
                node.querySelector('svg,img') !== null) header = node;
            node = node.parentElement;
          }
          if (header !== null && !header.hasAttribute('data-dsh-web-chat-webheader')) header.setAttribute('data-dsh-web-chat-webheader', '1');
        }
      };
      mark();
      if (window.__dshWebChatNavigationObserver === undefined) {
        let queued = false;
        const schedule = () => {
          if (queued) return;
          queued = true;
          window.requestAnimationFrame(() => { queued = false; mark(); });
        };
        const observer = new window.MutationObserver(schedule);
        observer.observe(document.documentElement, { childList: true, subtree: true });
        window.addEventListener('resize', schedule);
        window.__dshWebChatNavigationObserver = observer;
      }
      return true;
    }

    async function injectHideWebSidebar(view) {
      if (view === null || typeof view.executeJavaScript !== 'function') return;
      try {
        await view.executeJavaScript('(' + hideWebSidebarInGuest.toString() + ')()', false);
      } catch (error) {
        /* hiding the web sidebar is best effort */
      }
    }

    async function injectEarlyHideWebSidebar(view) {
      if (view === null || typeof view.executeJavaScript !== 'function') return;
      try {
        await view.executeJavaScript('(' + hideWebSidebarInGuest.toString() + ')()', false);
      } catch (error) {
        /* early injection is best effort */
      }
    }

    function probeAuthInGuest() {
      const composer = document.querySelector('textarea, [contenteditable="true"]');
      if (composer !== null) return 'in';
      const body = document.body;
      const text = body !== null && body !== undefined && typeof body.innerText === 'string' ? body.innerText.slice(0, 4000) : '';
      if (/登录|登入|Log in|Sign in|手机号|邮箱|Email|Phone|验证码/i.test(text)) return 'out';
      return 'unknown';
    }

    async function probeAuth(view) {
      if (view === null || view === undefined || typeof view.executeJavaScript !== 'function') return 'unknown';
      let timer = 0;
      try {
        const result = await Promise.race([
          view.executeJavaScript('(' + probeAuthInGuest.toString() + ')()', true),
          new Promise((resolve) => {
            timer = window.setTimeout(() => resolve('unknown'), 5000);
          }),
        ]);
        return result === 'in' || result === 'out' ? result : 'unknown';
      } catch (error) {
        return 'unknown';
      } finally {
        window.clearTimeout(timer);
      }
    }

    // ---------- guest 生命周期 ----------
    let view = null;
    let lease = null;
    let offOpenRequested = null;
    let sharedSession = null;
    let sharedSessionSource = '';
    let started = false;
    let starting = false;
    let prepared = false;
    let preparation = null;
    let loginApplied = false;
    let localeApplied = false;
    // 装回登录态引起的重载在途：期间不发起待跳会话的导航（匿名跳会话会被站点重定向）。
    let reloadingForLogin = false;

    function syncGuestTitle() {
      if (view === null) return;
      try {
        const loading = view.executeJavaScript('document.title');
        if (loading !== null && typeof loading.then === 'function') {
          loading
            .then((raw) => {
              const text = String(raw ?? '')
                .replace(/\s*[-–|]\s*DeepSeek.*$/i, '')
                .trim();
              if (text !== state.title) emit({ title: text });
            })
            .catch(() => {});
        }
      } catch (error) {
        /* title sync is best effort */
      }
    }

    async function handleDidFinishLoad(fullLoad = true) {
      if (view === null) return;
      const current = view;
      let url = '';
      try { url = current.getURL(); } catch (error) { return; }
      if (url === '' || url.startsWith('about:blank')) return;
      if (!fullLoad && reloadingForLogin) return;
      if (fullLoad) reloadingForLogin = false;
      // Keep the guest transparent throughout login/locale initialization and redirects.
      if (await prepareGuest()) return;
      if (view !== current) return;
      const auth = await probeAuth(current);
      if (view !== current || current.getURL() !== url || reloadingForLogin) return;
      emit({ auth });
      if (pendingConversationId !== '' && auth === 'in') {
        const target = CONVERSATION_URL + encodeURIComponent(pendingConversationId);
        if (pathOf(url) !== pathOf(target)) {
          await navigateGuest(target);
          return;
        }
        pendingConversationId = '';
      }
      await injectHideWebSidebar(current);
      if (view !== current || current.getURL() !== url || reloadingForLogin) return;
      current.style.opacity = '1';
      current.style.pointerEvents = '';
      emit({ phase: 'ready', error: '' });
      syncGuestTitle();
      const active = /\/a\/chat\/s\/([0-9a-zA-Z_-]{6,64})/.exec(url);
      emitSessionList({ activeId: active === null ? '' : active[1] });
      if (auth === 'in') void saveOwnSession(current);
      window.setTimeout(() => { void refreshSessionList(); }, 2500);
    }

    async function prepareGuest() {
      if (prepared || view === null) return false;
      if (preparation !== null) return preparation;
      const pending = initializeGuest();
      preparation = pending;
      try {
        return await pending;
      } finally {
        if (preparation === pending) preparation = null;
      }
    }

    async function initializeGuest() {
      const current = view;
      const auth = await probeAuth(current);
      if (view !== current) return true;
      emit({ auth: auth === 'in' || auth === 'out' ? auth : 'unknown' });
      if (auth === 'in') void saveOwnSession(current);
      let reload = false;
      if (auth !== 'in' && !loginApplied && sharedSession !== null) {
        try {
          const payload = { writes: sharedLoginWrites(sharedSession), cookies: sharedSession.cookies };
          if (payload.writes.length > 0 || payload.cookies.length > 0) {
            const result = await current.executeJavaScript(
              '(' + installSessionInGuest.toString() + ')(' + JSON.stringify(payload) + ')',
              false,
            );
            if (view !== current) return true;
            if (result !== null && typeof result === 'object' && result.applied === true) {
              loginApplied = true;
              reloadingForLogin = true;
              reload = true;
              emit({ notice: sharedSessionSource === 'local' ? '已恢复本机 DeepSeek 登录态' : '已沿用 DSH 网页登录态' });
            }
          }
        } catch (error) {
          /* shared login is optional */
        }
      }
      if (!localeApplied) {
        localeApplied = true;
        try {
          const changed = await current.executeJavaScript('(' + forceChineseLocaleInGuest.toString() + ')()', false);
          if (changed === true) reload = true;
        } catch (error) {
          /* locale forcing is best effort */
        }
      }
      if (view !== current) return true;
      prepared = true;
      if (reload) {
        reloadingForLogin = true;
        const target = pendingConversationId !== '' ? CONVERSATION_URL + encodeURIComponent(pendingConversationId) : current.getURL();
        try {
          const loading = current.loadURL(target);
          if (loading !== undefined && typeof loading.catch === 'function') loading.catch(error => {
            if (view !== current) return;
            reloadingForLogin = false;
            emit({ phase: 'error', error: '恢复登录后加载会话失败：' + String(error) });
          });
        } catch (error) {
          reloadingForLogin = false;
          emit({ phase: 'error', error: '恢复登录后加载会话失败：' + String(error) });
        }
      }
      window.setTimeout(() => {
        if (state.notice === '已沿用 DSH 网页登录态' || state.notice === '已恢复本机 DeepSeek 登录态') emit({ notice: '' });
      }, 5000);
      return reload;
    }

    function ensureGuest(hostNode) {
      if (started || starting || hostNode === null || hostNode === undefined) return;
      starting = true;
      const bridge = getBridge();
      if (bridge === undefined) {
        starting = false;
        emit({ phase: 'unsupported', error: '当前环境没有 DSH 内嵌浏览器通道（需要桌面端）' });
        return;
      }
      void (async () => {
        try {
          const reservation = await bridge.acquire(WORKSPACE_KEY);
          lease = reservation.lease;
          if (typeof bridge.onOpenRequested === 'function') {
            try {
              offOpenRequested = bridge.onOpenRequested(lease, (url) => {
                try {
                  window.open(String(url), '_blank', 'noopener,noreferrer');
                } catch (error) {
                  /* external links are best effort */
                }
              });
            } catch (error) {
              offOpenRequested = null;
            }
          }
          const ownSession = await fetchOwnSession();
          if (ownSession !== null) {
            sharedSession = ownSession;
            sharedSessionSource = 'local';
          } else {
            sharedSession = await fetchSharedLoginSession();
            sharedSessionSource = sharedSession !== null ? 'shared' : '';
          }
          const element = document.createElement('webview');
          element.className = 'dsh-web-chat-webview';
          element.style.opacity = '0';
          element.style.pointerEvents = 'none';
          element.setAttribute('partition', reservation.partition);
          element.setAttribute('name', reservation.lease);
          element.setAttribute('lang', 'zh-CN');
          if (sharedSession !== null && sharedSession.userAgent !== '') {
            element.setAttribute('useragent', sharedSession.userAgent);
          }
          element.setAttribute('src', 'about:blank#' + reservation.lease);
          element.addEventListener(
            'dom-ready',
            () => {
              const boot = () => {
                try {
                  // 首次加载就直达目标会话（若有），跳过根路径落地页，避免“先见默认页再跳会话”的二次加载闪现。
                  const initial = pendingConversationId !== '' ? CONVERSATION_URL + encodeURIComponent(pendingConversationId) : TARGET;
                  const loading = element.loadURL(initial);
                  if (loading !== undefined && typeof loading.catch === 'function') loading.catch(() => {});
                } catch (error) {
                  emit({ phase: 'error', error: String(error) });
                }
              };
              boot();
            },
            { once: true },
          );
          // 每次导航的 dom-ready（早于 React 渲染）都用已记录的侧栏类名提前隐藏，避免列表闪现。
          element.addEventListener('dom-ready', () => {
            void injectEarlyHideWebSidebar(element);
          });
          element.addEventListener('did-start-navigation', (event) => {
            if (event.isMainFrame !== true || event.isInPlace === true) return;
            element.style.opacity = '0';
            element.style.pointerEvents = 'none';
            emit({ phase: 'loading' });
          });
          element.addEventListener('did-finish-load', () => {
            void handleDidFinishLoad().catch((error) => emit({ phase: 'error', error: String(error) }));
          });
          // SPA 路由跳转不触发 did-finish-load，单独监听页内导航以维持侧栏高亮（activeId）。
          element.addEventListener('did-navigate-in-page', (event) => {
            const url = String((event && event.url) || '');
            const active = /\/a\/chat\/s\/([0-9a-zA-Z_-]{6,64})/.exec(url);
            emitSessionList({ activeId: active === null ? '' : active[1] });
            if (!reloadingForLogin) void handleDidFinishLoad(false).catch(() => {});
          });
          element.addEventListener('did-fail-load', (event) => {
            if (event === null || event === undefined || event.errorCode === -3) return;
            if (String(event.validatedURL ?? '').startsWith('about:blank')) return;
            emit({ phase: 'error', error: event.errorDescription ?? '页面加载失败' });
          });
          element.addEventListener('render-process-gone', () => {
            emit({ phase: 'error', error: '页面渲染进程退出，切换页签后会重试' });
          });
          hostNode.appendChild(element);
          view = element;
          started = true;
          emit({ phase: 'loading' });
        } catch (error) {
          emit({ phase: 'error', error: String(error) });
        } finally {
          starting = false;
        }
      })();
    }

    function releaseGuest() {
      if (offOpenRequested !== null) {
        try {
          offOpenRequested();
        } catch (error) {
          /* unsubscribe is best effort */
        }
        offOpenRequested = null;
      }
      const element = view;
      view = null;
      if (element !== null) {
        try {
          element.remove();
        } catch (error) {
          /* removal is best effort */
        }
      }
      const bridge = getBridge();
      if (lease !== null && bridge !== undefined) {
        try {
          bridge.release(lease);
        } catch (error) {
          /* release is best effort */
        }
      }
      lease = null;
      started = false;
      starting = false;
      prepared = false;
      preparation = null;
      loginApplied = false;
      localeApplied = false;
      reloadingForLogin = false;
      sharedSession = null;
      emit({ phase: 'idle', auth: 'unknown', error: '' });
    }

    // ---------- 网页对话读取（只读 DOM，不点发送）----------
    async function extractInGuest(mode, checkpoint, remote) {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const nextFrame = () =>
        new Promise((resolve) => {
          let settled = false;
          let timer = 0;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          };
          timer = setTimeout(finish, 160);
          try {
            requestAnimationFrame(() => requestAnimationFrame(finish));
          } catch (error) {
            finish();
          }
        });
      const BASE = {
        messages: ['[data-virtual-list-item-key]'],
        assistant: ['.ds-assistant-message-main-content'],
        think: ['.ds-think-content'],
      };
      const remoteSelectors =
        remote !== null && typeof remote === 'object' && remote.selectors !== null && typeof remote.selectors === 'object'
          ? remote.selectors
          : {};
      const candidatesFor = (key) => {
        const extra = Array.isArray(remoteSelectors[key])
          ? remoteSelectors[key].filter((item) => typeof item === 'string' && item !== '')
          : [];
        const rows = [];
        for (const selector of extra.concat(BASE[key])) {
          if (rows.indexOf(selector) === -1) rows.push(selector);
        }
        return rows;
      };
      const pickSelector = (list) => {
        let firstValid = null;
        for (const selector of list) {
          try {
            if (document.querySelector(selector) !== null) return selector;
            if (firstValid === null) firstValid = selector;
          } catch (error) {
            /* Skip selectors the page cannot parse. */
          }
        }
        return firstValid !== null ? firstValid : list[list.length - 1];
      };
      const ITEM = pickSelector(candidatesFor('messages'));
      const ASSISTANT = pickSelector(candidatesFor('assistant'));
      const THINK = pickSelector(candidatesFor('think'));
      const BLOCKS = new Set([
        'P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'UL', 'OL', 'LI',
        'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'TABLE', 'TR', 'HR',
        'FIGURE', 'FIGCAPTION',
      ]);
      const clean = (value) =>
        String(value || '')
          .replace(/\u00a0/g, ' ')
          .replace(/[ \t]+\n/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      const textOf = (node) => {
        if (node === null || node === undefined) return '';
        if (node.nodeType === 3) return node.nodeValue || '';
        if (node.nodeType !== 1) return '';
        const el = node;
        const tag = el.tagName;
        if (tag === 'BUTTON' || tag === 'SVG' || tag === 'STYLE' || tag === 'SCRIPT' || tag === 'NOSCRIPT') return '';
        const className = el.getAttribute('class') || '';
        if (
          className.indexOf('md-code-block-banner') !== -1 ||
          className.indexOf('md-code-block-action') !== -1 ||
          className.indexOf('md-code-block-footer') !== -1 ||
          className.indexOf('ds-markdown-code-copy-button') !== -1
        ) {
          return '';
        }
        if (el.getAttribute('aria-hidden') === 'true') return '';
        if (tag === 'BR') return '\n';
        if (tag === 'IMG') {
          const alt = el.getAttribute('alt') || '图片';
          const src = el.getAttribute('src') || '';
          if (src === '' || /^(data|blob):/i.test(src)) return '![' + alt + ']';
          let absolute = src;
          try {
            absolute = new URL(src, document.baseURI).href;
          } catch (error) {
            /* Keep the original src when the page cannot resolve it. */
          }
          return '![' + alt + '](' + absolute + ')';
        }
        if (tag === 'PRE') {
          const code = el.querySelector('code') || el;
          const className = code.getAttribute('class') || '';
          const match = className.match(/language-([\w+#.-]+)/);
          const body = String(code.innerText || code.textContent || '').replace(/\n+$/, '');
          return '\n```' + (match ? match[1] : '') + '\n' + body + '\n```\n';
        }
        if (tag === 'TABLE') {
          const rows = el.querySelectorAll('tr');
          const lines = [];
          for (const row of rows) {
            const cells = row.querySelectorAll('th,td');
            if (cells.length === 0) continue;
            const values = [];
            for (const cell of cells) {
              let value = '';
              for (const child of cell.childNodes) value += textOf(child);
              values.push(clean(value).replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim());
            }
            lines.push('| ' + values.join(' | ') + ' |');
            if (lines.length === 1) lines.push('| ' + values.map(() => '---').join(' | ') + ' |');
          }
          return lines.length === 0 ? '' : '\n' + lines.join('\n') + '\n';
        }
        let out = '';
        for (const child of el.childNodes) out += textOf(child);
        if (tag === 'A') {
          const href = el.getAttribute('href') || '';
          const label = out.trim();
          if (label === '' || href === '' || /^javascript:/i.test(href)) return label;
          let absolute = href;
          try {
            absolute = new URL(href, document.baseURI).href;
          } catch (error) {
            /* Keep the original href when the page cannot resolve it. */
          }
          return '[' + label + '](' + absolute + ')';
        }
        if (tag === 'LI') return '\n- ' + out.trim() + '\n';
        if (tag === 'TD' || tag === 'TH') return ' ' + out.trim() + ' |';
        if (BLOCKS.has(tag)) return '\n' + out + '\n';
        return out;
      };
      const KEY_ATTRIBUTE =
        remote !== null &&
        typeof remote === 'object' &&
        typeof remote.keyAttribute === 'string' &&
        /^data-[a-zA-Z0-9-]{1,48}$/.test(remote.keyAttribute)
          ? remote.keyAttribute
          : 'data-virtual-list-item-key';
      const readItem = (el) => {
        const assistant = el.querySelector(ASSISTANT) || null;
        if (assistant === null && (el.querySelector(THINK) || null) !== null) return null;
        const text = clean(textOf(assistant || el));
        if (text === '') return null;
        return { role: assistant === null ? 'user' : 'assistant', text };
      };
      // Stop controls and changing assistant text indicate a live, partial answer.
      // Keep this state sticky: finishing while we read must not silently erase the warning.
      const assistantText = new Map();
      let generatingObserved = false;
      const generationState = () => {
        const stop = [...document.querySelectorAll('button,[role="button"]')].some(button => {
          const label = [button.getAttribute('aria-label'), button.getAttribute('title'), button.textContent].filter(Boolean).join(' ');
          return /停止(?:生成|回答|响应|输出)|stop(?: generating| generation| responding| response)|^(?:停止|stop)$/i.test(label.trim());
        });
        if (stop || document.querySelector('[data-state="streaming"],[data-status="streaming"],[data-message-status="streaming"],[aria-busy="true"]') !== null) generatingObserved = true;
        for (const item of document.querySelectorAll(ITEM)) {
          const answer = item.querySelector(ASSISTANT);
          const key = item.getAttribute(KEY_ATTRIBUTE);
          if (answer === null || key === null) continue;
          const text = clean(textOf(answer));
          if (assistantText.has(key) && assistantText.get(key) !== text) generatingObserved = true;
          assistantText.set(key, text);
        }
        return generatingObserved;
      };
      generationState();
      if (mode === 'selection') {
        const selection = window.getSelection ? window.getSelection() : null;
        const selected = clean(selection ? selection.toString() : '');
        if (selected === '') return { ok: false, reason: 'no-selection' };
        return {
          ok: true,
          messages: [{ role: 'selection', text: selected }],
          truncated: false,
          total: 1,
          done: true,
          atStart: true,
          checkpoint: null,
        };
      }
      const first = document.querySelector(ITEM);
      if (first === null) return { ok: false, reason: 'no-messages' };
      let scroller = first.parentElement;
      while (scroller !== null && scroller !== document.body) {
        const style = getComputedStyle(scroller);
        if (/(auto|scroll)/.test(style.overflowY) && scroller.scrollHeight > scroller.clientHeight + 8) break;
        scroller = scroller.parentElement;
      }
      if (scroller === null || scroller === document.body) {
        scroller = document.scrollingElement || document.documentElement;
      }
      if (mode === 'last' || mode === 'round') {
        const originalTop = scroller.scrollTop;
        const startedAt = Date.now();
        let rows = [];
        try {
          scroller.scrollTop = scroller.scrollHeight;
          await nextFrame();
          await sleep(160);
          // A virtual list may increase height after the first bottom jump.
          scroller.scrollTop = scroller.scrollHeight;
          await nextFrame();
          await sleep(160);
          for (let step = 0; step < 120 && Date.now() - startedAt < 12000; step += 1) {
            const visible = [];
            for (const el of document.querySelectorAll(ITEM)) {
              const item = readItem(el);
              if (item !== null) visible.push({ ...item, key: el.getAttribute(KEY_ATTRIBUTE) || item.role + ':' + item.text });
            }
            const seen = new Set();
            rows = [...visible, ...rows].filter(item => {
              if (seen.has(item.key)) return false;
              seen.add(item.key);
              return true;
            });
            let boundary = -1;
            for (let index = rows.length - 1; index >= 0; index -= 1) {
              if (rows[index].role === (mode === 'last' ? 'assistant' : 'user')) { boundary = index; break; }
            }
            const generating = generationState();
            if (boundary !== -1) return {
              ok: true, messages: mode === 'last' ? [rows[boundary]] : rows.slice(boundary),
              truncated: generating, generating, done: true,
            };
            const before = scroller.scrollTop;
            if (before <= 0) break;
            scroller.scrollTop = Math.max(0, before - Math.max(220, Math.floor(scroller.clientHeight * 0.8)));
            await nextFrame();
            await sleep(100);
            if (scroller.scrollTop === before) break;
          }
          return rows.length === 0 ? { ok: false, reason: 'no-messages' } : { ok: true, messages: rows, truncated: true, generating: generationState(), done: false };
        } finally {
          scroller.scrollTop = originalTop;
        }
      }
      const messages = [];
      const indexByKey = new Map();
      const SEGMENT_BUDGET_MS = 12000;
      const MAX_STEPS = 120;
      let reported = -1;
      const report = () => {
        if (messages.length === reported) return;
        reported = messages.length;
        try {
          console.log('__DSH_DSC_PROGRESS__' + reported);
        } catch (error) {
          /* Progress reporting is best effort. */
        }
      };
      const capture = () => {
        for (const el of document.querySelectorAll(ITEM)) {
          const key = el.getAttribute(KEY_ATTRIBUTE) || '';
          const item = readItem(el);
          if (item === null) continue;
          const record = key === '' ? item : { key, role: item.role, text: item.text };
          if (key !== '' && indexByKey.has(key)) {
            messages[indexByKey.get(key)] = record;
            continue;
          }
          if (key !== '') indexByKey.set(key, messages.length);
          messages.push(record);
        }
        report();
      };
      const original = scroller.scrollTop;
      const resume =
        checkpoint !== null &&
        checkpoint !== undefined &&
        typeof checkpoint === 'object' &&
        Number.isFinite(Number(checkpoint.scrollTop));
      let atStart = resume ? checkpoint.atStart !== false : true;
      let finished = false;
      let endTop = original;
      const startedAt = Date.now();
      try {
        if (resume) {
          const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
          scroller.scrollTop = Math.min(max, Math.max(0, Number(checkpoint.scrollTop)));
          await nextFrame();
          await sleep(140);
          capture();
        } else {
          let lastHeight = -1;
          for (let settle = 0; settle < 6; settle += 1) {
            scroller.scrollTop = 0;
            await nextFrame();
            await sleep(120);
            capture();
            const height = scroller.scrollHeight;
            if (height === lastHeight) break;
            lastHeight = height;
          }
        }
        let lastTop = -1;
        for (let step = 0; step < MAX_STEPS; step += 1) {
          const max = scroller.scrollHeight - scroller.clientHeight;
          if (scroller.scrollTop >= max - 2) break;
          if (Date.now() - startedAt >= SEGMENT_BUDGET_MS) break;
          const delta = Math.max(220, Math.floor(scroller.clientHeight * 0.8));
          scroller.scrollTop = Math.min(max, scroller.scrollTop + delta);
          await nextFrame();
          await sleep(60);
          capture();
          if (scroller.scrollTop === lastTop) break;
          lastTop = scroller.scrollTop;
        }
        await sleep(80);
        capture();
        const maxAfter = scroller.scrollHeight - scroller.clientHeight;
        if (scroller.scrollTop >= maxAfter - 2) {
          await sleep(120);
          capture();
          const settledMax = scroller.scrollHeight - scroller.clientHeight;
          scroller.scrollTop = Math.max(0, settledMax);
          await nextFrame();
          await sleep(40);
          capture();
        }
        const finalMax = scroller.scrollHeight - scroller.clientHeight;
        finished = scroller.scrollTop >= finalMax - 2;
        endTop = scroller.scrollTop;
      } finally {
        try {
          scroller.scrollTop = original;
        } catch (error) {
          /* Best effort: the page may have re-rendered while collecting. */
        }
      }
      const generating = generationState();
      const nextCheckpoint = { scrollTop: endTop, atStart };
      if (messages.length === 0) {
        if (resume) {
          return {
            ok: true,
            messages,
            truncated: !finished || !atStart || generating,
            generating,
            total: 0,
            done: finished,
            atStart,
            checkpoint: nextCheckpoint,
          };
        }
        return { ok: false, reason: 'no-messages' };
      }
      return {
        ok: true,
        messages,
        truncated: !finished || !atStart || generating,
        generating,
        total: messages.length,
        done: finished,
        atStart,
        checkpoint: nextCheckpoint,
      };
    }
    async function captureMessages(mode) {
      if (view === null || typeof view.executeJavaScript !== 'function') return null;
      const source = '(' + extractInGuest.toString() + ')(' + JSON.stringify(['last', 'round', 'selection'].includes(mode) ? mode : 'all') + ', null, null)';
      let timer = 0;
      const result = await Promise.race([
        view.executeJavaScript(source, true),
        new Promise((resolve) => {
          timer = window.setTimeout(() => resolve(null), 25000);
        }),
      ]).finally(() => window.clearTimeout(timer));
      if (result === null || result === undefined || result.ok !== true || !Array.isArray(result.messages)) return null;
      let messages = result.messages.filter(
        (message) => message !== null && typeof message === 'object' && typeof message.text === 'string' && message.text.trim() !== '',
      );
      if (mode === 'last') {
        if (!messages.some(message => message.role === 'assistant')) return null;
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          if (messages[index].role === 'assistant') {
            messages = [messages[index]];
            break;
          }
        }
      } else if (mode === 'round') {
        let lastUser = -1;
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          if (messages[index].role === 'user') {
            lastUser = index;
            break;
          }
        }
        if (lastUser !== -1) messages = messages.slice(lastUser);
      }
      if (messages.length === 0) return null;
      return { messages, truncated: result.truncated === true || result.generating === true, generating: result.generating === true };
    }

    function formatHandoff(messages, mode, truncated, details = {}) {
      const now = new Date();
      const pad = (value) => String(value).padStart(2, '0');
      const stamp = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());
      const label = mode === 'last' ? '最后一条回复' : mode === 'round' ? '最近一轮问答' : '整段对话';
      const lines = [
        '【DeepSeek 网页对话 · 交给 Harness】',
        '时间：' + stamp,
        '范围：' + label + '（' + messages.length + ' 条消息' + (truncated ? ' · 提取不完整，可能未包含全部内容' : '') + '）',
        '',
        '## 对话记录',
        '',
      ];
      if (details.title) lines.splice(2, 0, '来源：' + String(details.title).replace(/[\r\n]+/g, ' '));
      if (details.url) lines.splice(3, 0, '链接：' + details.url);
      if (details.generating) lines.splice(4, 0, '注意：回复仍在生成，本记录为可能不完整的快照。');
      for (const message of messages) {
        lines.push(message.role === 'assistant' ? '### DeepSeek' : '### 我');
        lines.push(String(message.text).trim());
        lines.push('');
      }
      if (typeof details.instruction === 'string' && details.instruction.trim() !== '') {
        lines.push('## 接下来请做', '', details.instruction.trim());
      }
      return lines.join('\n').trim();
    }

    function handoffTaskOptions() {
      let workspaces = [];
      let previous = null;
      if (appCtx !== null) {
        try {
          const rows = appCtx.get('workspaces')?.list?.getSnapshot()?.items || [];
          workspaces = rows.map(row => ({ id: row.workspaceId, title: row.title || row.path || '工作区' }));
          const id = currentSessionId();
          const row = appCtx.get('sessions')?.list?.getSnapshot()?.byId?.[id];
          if (row !== undefined && row !== null) previous = { id, title: row.displayTitle || row.title || '未命名任务' };
        } catch (error) { /* unavailable tasks are not offered as destinations */ }
      }
      return { previous, workspaces };
    }

    function currentSessionId() {
      if (savedSessionId !== '') return savedSessionId;
      if (appCtx === null) return undefined;
      try {
        const uiSession = appCtx.get('uiSession');
        const value = uiSession !== null && uiSession !== undefined && uiSession.current !== undefined ? uiSession.current.value : undefined;
        return value !== null && value !== undefined ? value.key : undefined;
      } catch (error) {
        return undefined;
      }
    }

    function insertIntoComposerFor(sessionId, text) {
      if (appCtx === null) return { ok: false, reason: 'no-ctx' };
      if (sessionId === undefined || sessionId === null || sessionId === '') return { ok: false, reason: 'no-session' };
      let shell = null;
      try {
        const conversation = appCtx.get('conversation');
        if (conversation === null || conversation === undefined || conversation.input === undefined) return { ok: false, reason: 'no-composer' };
        shell = conversation.input.shell(sessionId);
      } catch (error) {
        return { ok: false, reason: 'no-composer' };
      }
      if (shell === null || shell.actions === undefined) return { ok: false, reason: 'no-composer' };
      const existing = typeof shell.projection?.detectText === 'string' ? shell.projection.detectText : '';
      const prefix = existing === '' ? '' : existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
      const payload = prefix + text;
      const span = { start: existing.length, end: existing.length, draftRev: shell.rev };
      try {
        if (shell.actions.insertText(payload, span)) return { ok: true, sessionId };
      } catch (error) {
        /* fall through to setDraft */
      }
      try {
        shell.actions.setDraft(existing + payload);
        return { ok: true, sessionId, fallback: true };
      } catch (error) {
        return { ok: false, reason: 'failed' };
      }
    }

    function insertIntoComposer(text) {
      return insertIntoComposerFor(currentSessionId(), text);
    }

    /** 面板会先取消工作区会话；返回会话后输入框挂载有延迟，这里短轮询等 shell 就绪。 */
    async function insertWithRetry(sessionId, text) {
      let last = { ok: false, reason: 'no-composer' };
      for (let attempt = 0; attempt < 24; attempt += 1) {
        last = insertIntoComposerFor(sessionId, text);
        if (last.ok === true) return last;
        if (last.reason === 'no-ctx' || last.reason === 'no-session') return last;
        await new Promise((resolve) => window.setTimeout(resolve, 120));
      }
      return last;
    }

    /** Deliver the exact reviewed draft through composer actions; never send a message. */
    async function doHandoff(text, destination, previousId, workspaceId) {
      if (state.busy) return { ok: false, error: '正在填入草稿，请稍等' };
      if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: '没有可填入的内容' };
      const options = handoffTaskOptions();
      if (destination !== 'new' && (!options.previous || options.previous.id !== previousId)) {
        return { ok: false, error: '刚才的任务已不可用，请选择新建任务' };
      }
      if (destination === 'new' && !options.workspaces.some(item => item.id === workspaceId)) {
        return { ok: false, error: '工作区已不可用，请重新选择' };
      }
      emit({ busy: true, notice: '' });
      try {
        const workspace = uiWorkspaceService();
        if (workspace === null || typeof workspace.openSession !== 'function') throw new Error('当前客户端无法打开目标任务');
        let sessionId = previousId;
        if (destination === 'new') {
          if (typeof workspace.connectWorkspace !== 'function') throw new Error('当前客户端不支持创建任务草稿');
          sessionId = await workspace.connectWorkspace(workspaceId);
          if (typeof sessionId !== 'string' || sessionId === '') throw new Error('未能创建目标任务');
        }
        leavePanelOnly();
        workspace.openSession(sessionId);
        const result = await insertWithRetry(sessionId, text);
        if (result.ok !== true) {
          let message = '未能填入任务草稿';
          try {
            await navigator.clipboard.writeText(text);
            message += '，内容已复制，可手动粘贴';
          } catch (error) { message += '，请返回网页重试'; }
          notifyComposer(message);
          return { ok: false, error: message };
        }
        focusComposerFor(sessionId);
        notifyComposer('已填入 ' + text.length + ' 字草稿，请检查后发送');
        return { ok: true };
      } catch (error) {
        return { ok: false, error: '填入失败：' + String(error.message || error) };
      } finally {
        emit({ busy: false });
      }
    }

    // ---------- UI ----------
    function statusLabel(app) {
      if (app.phase === 'loading') return '正在打开…';
      if (app.phase === 'unsupported') return '当前环境不支持';
      if (app.phase === 'error') return '加载失败';
      if (app.auth === 'in') return '已登录';
      if (app.auth === 'out') return '未登录';
      return '登录状态未知';
    }

    function PanelGlyph({ size = 18, active = false }) {
      const path =
        'M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z';
      return h(
        'span',
        { className: 'dsh-web-chat-glyph', 'aria-hidden': true },
        h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 50 50',
            fill: 'none',
            focusable: false,
            style: { opacity: active ? 1 : 0.86, display: 'block' },
          },
          h('path', { d: path, fill: '#4D6BFE', fillRule: 'nonzero' }),
        ),
      );
    }

    // ---------- 打开 / 关闭 / 导航 ----------
    let pendingConversationId = '';
    let savedSessionId = '';

    function pathOf(target) {
      try {
        return new URL(target).pathname;
      } catch (error) {
        return '';
      }
    }

    /**
     * 页面内 SPA 跳转：点（隐藏）侧栏里对应的会话链接，让应用走自己的路由（零重载、无闪现）。
     * 链接不在 DOM（虚拟列表未渲染）时返回 ''，由宿主侧退回整页加载；
     * 不用 pushState+popstate 模拟——DeepSeek 路由会把它判为无效导航渲染错误页。
     * 序列化后执行，不能引用外层。
     */
    function spaNavigateInGuest(path) {
      const link = document.querySelector('a[href="' + path + '"]');
      if (link === null) return '';
      link.click();
      return 'link';
    }

    /** 优先网页内 SPA 路由跳转（无整页加载、无闪现）；链接缺失时退回整页 loadURL 兜底。 */
    async function navigateGuest(target) {
      if (view === null) return false;
      let current = '';
      try {
        current = view.getURL();
      } catch (error) {
        current = '';
      }
      if (current === target) return true;
      const path = pathOf(target);
      if (path !== '' && typeof view.executeJavaScript === 'function') {
        try {
          if ((await view.executeJavaScript('(' + spaNavigateInGuest.toString() + ')(' + JSON.stringify(path) + ')', false)) === 'link') {
            return true;
          }
        } catch (error) {
          /* fall through to a full load */
        }
      }
      try {
        const loading = view.loadURL(target);
        if (loading !== undefined && typeof loading.catch === 'function') loading.catch(() => {});
        return true;
      } catch (error) {
        return false;
      }
    }

    function applyPendingConversation() {
      if (pendingConversationId === '') return false;
      const id = pendingConversationId;
      pendingConversationId = '';
      return navigateGuest(CONVERSATION_URL + encodeURIComponent(id));
    }

    function uiWorkspaceService() {
      if (appCtx === null) return null;
      try {
        const service = appCtx.get('uiWorkspace');
        return service !== null && service !== undefined ? service : null;
      } catch (error) {
        return null;
      }
    }

    function workspaceIdForSession(sessionId) {
      if (appCtx === null) return undefined;
      try {
        const workspaces = appCtx.get('workspaces');
        if (workspaces === null || workspaces === undefined || workspaces.list === undefined) return undefined;
        const snapshot = workspaces.list.getSnapshot();
        const items = snapshot !== null && snapshot !== undefined && Array.isArray(snapshot.items) ? snapshot.items : [];
        if (sessionId !== undefined && sessionId !== null && sessionId !== '') {
          const owner = items.find((item) => item !== null && item !== undefined && Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId));
          if (owner !== undefined) return owner.workspaceId;
        }
        return items.length > 0 ? items[0].workspaceId : undefined;
      } catch (error) {
        return undefined;
      }
    }

    function leavePanelOnly() {
      pendingConversationId = '';
      savedSessionId = '';
      setPageOpen(false);
      try {
        if (appCtx !== null && appCtx.layout !== undefined && typeof appCtx.layout.selectPanel === 'function') {
          appCtx.layout.selectPanel(null);
        }
      } catch (error) {
        /* leaving the panel is best effort */
      }
    }

    function enterWebPanel() {
      if (appCtx === null) return;
      const current = currentSessionId();
      if (current !== undefined && current !== null && current !== '') savedSessionId = current;
      const workspace = uiWorkspaceService();
      try {
        if (workspace !== null && typeof workspace.clearMain === 'function') workspace.clearMain();
      } catch (error) {
        /* leaving the session is best effort */
      }
      try {
        if (appCtx.layout !== undefined && typeof appCtx.layout.selectPanel === 'function') {
          appCtx.layout.selectPanel(PANEL_ID);
        }
      } catch (error) {
        /* panel selection is best effort */
      }
    }

    function openPage(id) {
      enterWebPanel();
      pendingConversationId = typeof id === 'string' ? id : '';
      setPageOpen(true);
      if (pendingConversationId === '') {
        if (view !== null) navigateGuest(TARGET);
        emitSessionList({ activeId: '' });
      } else {
        // A new guest boots directly into the requested URL. During initialization the
        // load handler owns the pending target; never race it with a timer/navigation.
        if (view !== null && prepared && !reloadingForLogin && state.phase === 'ready') {
          void applyPendingConversation();
        }
      }
      window.setTimeout(() => {
        void refreshSessionList();
      }, 1500);
    }

    function formatHotkey(config) {
      if (config === null || config === undefined || typeof config !== 'object') return '';
      const mac = /mac/i.test(String(navigator.platform || '')) || /Mac/.test(String(navigator.userAgent || ''));
      const labels = { control: mac ? '⌃' : 'Ctrl', alt: mac ? '⌥' : 'Alt', shift: mac ? '⇧' : 'Shift', meta: mac ? '⌘' : 'Win' };
      const keys = Array.isArray(config.modifiers) ? config.modifiers.map((modifier) => labels[modifier] ?? '') : [];
      const key = config.key === 'Space' ? 'Space' : String(config.key ?? '');
      return mac ? keys.join('') + ' ' + key : [...keys, key].join('+');
    }

    function keyFromEvent(event) {
      const code = typeof event.code === 'string' ? event.code : '';
      if (code === 'Space' || event.key === ' ' || event.key === 'Spacebar') return 'Space';
      let match = /^Key([A-Z])$/.exec(code);
      if (match !== null) return match[1];
      match = /^Digit([0-9])$/.exec(code);
      if (match !== null) return match[1];
      match = /^F([1-9]|1[0-2])$/.exec(code);
      if (match !== null) return code;
      return '';
    }

    function modifiersFromEvent(event) {
      const modifiers = [];
      if (event.ctrlKey === true) modifiers.push('control');
      if (event.altKey === true) modifiers.push('alt');
      if (event.shiftKey === true) modifiers.push('shift');
      if (event.metaKey === true) modifiers.push('meta');
      return modifiers;
    }

    async function fetchHotkeyState() {
      try {
        const response = await fetch('/dsh-web-chat/api/hotkey', { credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok) return null;
        const payload = await response.json().catch(() => null);
        return payload !== null && payload !== undefined && payload.ok === true ? payload : null;
      } catch (error) {
        return null;
      }
    }

    async function saveHotkeyState(config) {
      try {
        const response = await fetch('/dsh-web-chat/api/hotkey', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(config),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload === null || payload.ok !== true) return { ok: false, error: payload?.error ?? 'save-failed' };
        return { ok: true, state: payload };
      } catch (error) {
        return { ok: false, error: 'network' };
      }
    }

    function HotkeySettingsRow() {
      const [state, setState] = React.useState(null);
      const [recording, setRecording] = React.useState(false);
      const [saving, setSaving] = React.useState(false);
      const [error, setError] = React.useState('');
      const config = state !== null && state.config !== null && typeof state.config === 'object' ? state.config : { enabled: true, key: 'Space', modifiers: ['alt'] };
      const enabled = config.enabled !== false;
      const label = formatHotkey(config);
      const helperError = state !== null && typeof state.error === 'string' ? state.error : '';
      const running = state !== null && state.running === true;
      React.useEffect(() => {
        let disposed = false;
        const load = async () => {
          const payload = await fetchHotkeyState();
          if (!disposed && payload !== null) {
            setState(payload);
            setError(payload.error === '' ? '' : String(payload.error));
          }
        };
        void load();
        const timer = window.setInterval(() => { void load(); }, 5000);
        return () => {
          disposed = true;
          window.clearInterval(timer);
        };
      }, []);
      React.useEffect(() => {
        if (!recording) return undefined;
        const onKeyDown = (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (event.key === 'Escape') {
            setRecording(false);
            return;
          }
          const key = keyFromEvent(event);
          const modifiers = modifiersFromEvent(event);
          if (key === '' || modifiers.length === 0) return;
          setRecording(false);
          void persist({ enabled: true, key, modifiers });
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
      }, [recording]);
      const persist = async (next) => {
        setSaving(true);
        const result = await saveHotkeyState(next);
        setSaving(false);
        if (result.ok) {
          setState(result.state);
          setError(result.state.error === '' ? '' : String(result.state.error));
        } else {
          setError(String(result.error));
        }
      };
      const status = !enabled
        ? '已停用'
        : running
          ? '全局快捷键已生效'
          : helperError !== ''
            ? '助手未运行：' + helperError
            : '助手启动中…';
      return h(
        'div',
        { className: 'dsh-web-chat-set-row' },
        h(
          'div',
          { className: 'dsh-web-chat-set-copy' },
          h('div', { className: 'dsh-web-chat-set-title' }, '全局唤出 DSH'),
          h(
            'div',
            { className: 'dsh-web-chat-set-desc' },
            '任意页面按 ',
            h('kbd', { className: 'dsh-web-chat-kbd' }, label !== '' ? label : '⌥ Space'),
            ' 显示/隐藏整个 DeepSeek Harness；再按一次隐藏。macOS 默认 ⌥ Space，Windows 默认 Alt+Space，点「修改」可录制新组合。',
          ),
          h('div', { className: 'dsh-web-chat-set-binding' }, '状态：', status),
        ),
        h(
          'div',
          { className: 'dsh-web-chat-hotkey-actions' },
          recording
            ? h('span', { className: 'dsh-web-chat-hotkey-recording' }, '请按下组合键…（Esc 取消）')
            : h('button', { type: 'button', className: 'dsh-web-chat-btn', onClick: () => setRecording(true) }, '修改'),
          h(
            'button',
            {
              type: 'button',
              role: 'switch',
              'aria-checked': enabled ? 'true' : 'false',
              'aria-label': '启用全局唤出 DSH',
              className: 'dsh-web-chat-switch' + (enabled ? ' on' : ''),
              disabled: saving,
              onClick: () => { void persist({ enabled: !enabled, key: config.key, modifiers: config.modifiers }); },
            },
            h('span', { className: 'dsh-web-chat-switch-knob' }),
          ),
        ),
      );
    }

    function openNewConversation() {
      enterWebPanel();
      pendingConversationId = '';
      setPageOpen(true);
      if (view !== null) navigateGuest(TARGET);
      emitSessionList({ activeId: '' });
    }

    function closePage() {
      pendingConversationId = '';
      setPageOpen(false);
      emitSessionList({ activeId: '' });
      try {
        if (appCtx !== null && appCtx.layout !== undefined && typeof appCtx.layout.selectPanel === 'function') {
          appCtx.layout.selectPanel(null);
        }
      } catch (error) {
        /* leaving the panel is best effort */
      }
      const target = savedSessionId;
      savedSessionId = '';
      if (target !== '') {
        const workspace = uiWorkspaceService();
        try {
          if (workspace !== null && typeof workspace.openSession === 'function') workspace.openSession(target);
        } catch (error) {
          /* restoring the session is best effort */
        }
      }
    }

    function reloadGuest() {
      if (view === null) return;
      try {
        view.reload();
      } catch (error) {
        /* reload is best effort */
      }
    }

    function openExternalPage() {
      try {
        window.open(TARGET, '_blank', 'noopener,noreferrer');
      } catch (error) {
        /* external open is best effort */
      }
    }

    function RightGlyph({ size = 14 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, focusable: false },
        h('rect', { x: 2, y: 2.5, width: 12, height: 11, rx: 2, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('path', { d: 'M9.6 2.5v11', stroke: 'currentColor', strokeWidth: 1.2 }),
        h('rect', { x: 9.6, y: 2.5, width: 4.4, height: 11, rx: 1.2, fill: 'currentColor', opacity: 0.16 }),
      );
    }

    /**
     * 右侧栏是 DSH 的会话级能力（绑定 sessionId）。DeepSeek 页是独立面板，
     * 面板打开时没有活动会话 ⇒ 先返回原会话再展开右侧栏；若已有可用的右侧栏服务则直接切换。
     */
    function openRightSidebar() {
      if (appCtx === null) return;
      let sidebar = null;
      try {
        sidebar = appCtx.get('sidebarRight');
      } catch (error) {
        sidebar = null;
      }
      if (sidebar !== null && sidebar !== undefined && typeof sidebar.isExpanded === 'function') {
        try {
          if (sidebar.isExpanded() === true) {
            if (typeof sidebar.toggleExpanded === 'function') {
              sidebar.toggleExpanded();
              return;
            }
          }
        } catch (error) {
          /* fall through to the restore path */
        }
      }
      closePage();
      window.setTimeout(() => {
        try {
          const next = appCtx !== null ? appCtx.get('sidebarRight') : null;
          if (next !== null && next !== undefined && typeof next.toggleExpanded === 'function') next.toggleExpanded();
        } catch (error) {
          /* right sidebar is best effort */
        }
      }, 260);
    }

    // ---------- 用量与余额（Host 半折叠会话日志 + 查 DSH 账号余额）----------
    const USAGE_API = '/dsh-web-chat/api/usage';
    const BALANCE_API = '/dsh-web-chat/api/balance';
    const USAGE_REFRESH_MS = 60_000;
    const BALANCE_REFRESH_MS = 120_000;

    let usageSnapshot = { usage: null, usageError: '', balance: null, balanceError: '' };
    const usageListeners = new Set();
    function emitUsage(patch) {
      usageSnapshot = Object.assign({}, usageSnapshot, patch);
      for (const fn of [...usageListeners]) {
        try {
          fn();
        } catch (error) {
          /* usage listeners are best effort */
        }
      }
    }
    function subscribeUsage(fn) {
      usageListeners.add(fn);
      return () => usageListeners.delete(fn);
    }
    function useUsageSnapshot() {
      return React.useSyncExternalStore(subscribeUsage, () => usageSnapshot, () => usageSnapshot);
    }

    let usageFetching = false;
    let balanceFetching = false;
    let usagePollTimer = null;
    let balancePollTimer = null;
    let usagePollRefs = 0;

    async function refreshUsage() {
      if (usageFetching) return;
      usageFetching = true;
      try {
        const response = await fetch(USAGE_API, { credentials: 'same-origin', cache: 'no-store' });
        const payload = response.ok ? await response.json().catch(() => null) : null;
        if (payload !== null && typeof payload === 'object' && payload.ok === true) emitUsage({ usage: payload, usageError: '' });
        else emitUsage({ usageError: (payload && typeof payload.error === 'string' ? payload.error : '') || 'usage-unavailable' });
      } catch (error) {
        emitUsage({ usageError: String((error && error.message) || error) });
      } finally {
        usageFetching = false;
      }
    }

    async function refreshBalance() {
      if (balanceFetching) return;
      balanceFetching = true;
      try {
        const locale = (document.documentElement.getAttribute('lang') || navigator.language || 'zh-CN').slice(0, 16);
        const tz = -new Date().getTimezoneOffset() * 60;
        const url = BALANCE_API + '?locale=' + encodeURIComponent(locale) + '&tz=' + tz;
        const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
        const payload = response.ok ? await response.json().catch(() => null) : null;
        if (payload !== null && typeof payload === 'object' && typeof payload.status === 'string') emitUsage({ balance: payload, balanceError: '' });
        else emitUsage({ balanceError: (payload && typeof payload.error === 'string' ? payload.error : '') || 'balance-unavailable' });
      } catch (error) {
        emitUsage({ balanceError: String((error && error.message) || error) });
      } finally {
        balanceFetching = false;
      }
    }

    function refreshUsageAndBalance() {
      void refreshUsage();
      void refreshBalance();
    }

    /** Hold the two pollers while the row is mounted; the last release stops them. */
    function retainUsagePolling() {
      usagePollRefs += 1;
      if (usagePollRefs === 1) {
        refreshUsageAndBalance();
        usagePollTimer = window.setInterval(() => { void refreshUsage(); }, USAGE_REFRESH_MS);
        balancePollTimer = window.setInterval(() => { void refreshBalance(); }, BALANCE_REFRESH_MS);
      }
      return () => {
        usagePollRefs -= 1;
        if (usagePollRefs > 0) return;
        window.clearInterval(usagePollTimer);
        window.clearInterval(balancePollTimer);
        usagePollTimer = null;
        balancePollTimer = null;
      };
    }

    /** 紧凑 token 数：517 / 12.3K / 1.2M。 */
    function formatCompactTokens(value) {
      const number = Number(value);
      if (!Number.isFinite(number) || number <= 0) return '0';
      if (number < 1000) return String(Math.round(number));
      const units = ['K', 'M', 'B', 'T'];
      let scaled = number;
      let index = -1;
      while (scaled >= 1000 && index < units.length - 1) {
        scaled /= 1000;
        index += 1;
      }
      return String(scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10) + units[index];
    }

    /** 精确 token 数，千分位分组。 */
    function formatExactTokens(value) {
      const number = Number(value);
      return Number.isFinite(number) ? Math.round(number).toLocaleString('en-US') : '0';
    }

    /** 平台网页同款货币格式：两位小数，正的小额显示 <0.01。 */
    function formatBalanceAmount(amount, currency) {
      const symbol = currency === 'USD' ? '$' : '¥';
      const number = Number(amount);
      if (!Number.isFinite(number)) return symbol + '—';
      const magnitude = Math.abs(number);
      const body = magnitude === 0 ? '0.00' : magnitude < 0.01 ? '<0.01' : magnitude.toFixed(2);
      return (number < 0 ? '-' : '') + symbol + body;
    }

    function walletTotal(wallet) {
      const normal = Number(wallet.balance);
      const bonus = Number(wallet.bonus);
      return (Number.isFinite(normal) ? normal : 0) + (Number.isFinite(bonus) ? bonus : 0);
    }

    /** 余额低于 1 元（每个币种单独判断）时余额数值加粗提醒。 */
    function balanceIsLow(balance) {
      if (balance === null || typeof balance !== 'object' || balance.status !== 'ready') return false;
      if (!Array.isArray(balance.wallets) || balance.wallets.length === 0) return false;
      return balance.wallets.some((wallet) => walletTotal(wallet) < LOW_BALANCE_THRESHOLD);
    }

    /** 余额低于 0.1 元（每个币种单独判断）时余额数值变红。 */
    function balanceIsCritical(balance) {
      if (balance === null || typeof balance !== 'object' || balance.status !== 'ready') return false;
      if (!Array.isArray(balance.wallets) || balance.wallets.length === 0) return false;
      return balance.wallets.some((wallet) => walletTotal(wallet) < CRITICAL_BALANCE_THRESHOLD);
    }

    function usageTooltipLines(usage) {
      const lines = [];
      const line = (label, row) =>
        `${label}：输入 ${formatExactTokens(row.input)} · 输出 ${formatExactTokens(row.output)} · 缓存读 ${formatExactTokens(row.cacheRead)} · 合计 ${formatExactTokens(row.total)}`;
      if (usage && usage.today && usage.total) {
        lines.push(line('今日', usage.today));
        lines.push(line('总计', usage.total));
      }
      const updated = Number(usage && usage.at);
      if (Number.isFinite(updated) && updated > 0) {
        const clock = new Date(updated).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        lines.push('更新于 ' + clock + ' · 点击刷新');
      }
      return lines;
    }

    function balanceTooltipLines(balance) {
      const lines = [];
      if (balance === null || typeof balance !== 'object') return lines;
      if (balance.status === 'signed-out') return ['余额：未登录 DeepSeek 账号'];
      if (balance.status !== 'ready') return ['余额：读取失败'];
      if (!Array.isArray(balance.wallets) || balance.wallets.length === 0) return ['余额：无钱包数据'];
      for (const wallet of balance.wallets) {
        lines.push(
          '余额：' +
            formatBalanceAmount(walletTotal(wallet), wallet.currency) +
            '（充值 ' +
            formatBalanceAmount(wallet.balance, wallet.currency) +
            ' + 赠金 ' +
            formatBalanceAmount(wallet.bonus, wallet.currency) +
            '）',
        );
      }
      if (balanceIsCritical(balance)) lines.push('余额不足 ¥' + CRITICAL_BALANCE_THRESHOLD + '，请及时充值');
      return lines;
    }

    function UsageSegment({ label, value, bad, strong, critical }) {
      return h(
        'span',
        { className: 'dsh-web-chat-usage-seg' + (bad ? ' bad' : '') },
        h('span', { className: 'dsh-web-chat-usage-label' }, label),
        h('span', { className: 'dsh-web-chat-usage-value' + (strong ? ' strong' : '') + (critical ? ' critical' : '') }, value),
      );
    }

    /** 侧栏底部账号头像上方的一行：今日/总计 token 用量与 DeepSeek 余额。 */
    function UsageBalanceRow() {
      const prefs = useUiPrefs();
      const current = useUsageSnapshot();
      const visible = prefs.usageRow !== false;
      React.useEffect(() => (visible ? retainUsagePolling() : undefined), [visible]);
      React.useEffect(() => {
        if (!visible) return undefined;
        const onFocus = () => refreshUsageAndBalance();
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
      }, [visible]);
      if (!visible) return null;

      const usage = current.usage;
      const usageBad = usage === null && current.usageError !== '';
      const todayText = usage !== null && usage.today ? formatCompactTokens(usage.today.total) : '—';
      const totalText = usage !== null && usage.total ? formatCompactTokens(usage.total.total) : '—';

      const balance = current.balance;
      const balanceBad =
        current.balanceError !== '' ||
        (balance !== null && typeof balance === 'object' && balance.status !== 'ready' && balance.status !== 'signed-out');
      let balanceText = '—';
      if (balance !== null && typeof balance === 'object') {
        if (balance.status === 'signed-out') balanceText = '未登录';
        else if (balance.status === 'ready' && Array.isArray(balance.wallets) && balance.wallets.length > 0) {
          balanceText = balance.wallets.map((wallet) => formatBalanceAmount(walletTotal(wallet), wallet.currency)).join(' + ');
        }
      }
      const low = balanceIsLow(balance);
      const critical = balanceIsCritical(balance);
      const tooltip = usageTooltipLines(usage).concat(balanceTooltipLines(balance)).join('\n');
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-web-chat-usage-bar',
          title: tooltip !== '' ? tooltip : '今日/总计 token 用量与 DeepSeek 余额',
          'aria-label': '今日/总计 token 用量与 DeepSeek 余额，点击刷新',
          onClick: () => {
            emitUsage({ usageError: '', balanceError: '' });
            refreshUsageAndBalance();
          },
        },
        h(UsageSegment, { label: '今日', value: todayText, bad: usageBad }),
        h('span', { className: 'dsh-web-chat-usage-dot' }, '·'),
        h(UsageSegment, { label: '总计', value: totalText, bad: usageBad }),
        h('span', { className: 'dsh-web-chat-usage-dot' }, '·'),
        h(UsageSegment, { label: '余额', value: balanceText, bad: balanceBad, strong: low, critical }),
      );
    }

    function UsageSettingsRow() {
      const prefs = useUiPrefs();
      const enabled = prefs.usageRow !== false;
      return h(
        'div',
        { className: 'dsh-web-chat-set-row' },
        h(
          'div',
          { className: 'dsh-web-chat-set-copy' },
          h('div', { className: 'dsh-web-chat-set-title' }, '侧栏显示用量与余额'),
          h(
            'div',
            { className: 'dsh-web-chat-set-desc' },
            '在左侧栏账号头像上方显示一行「今日 token 用量 · 总计 token 用量 · DeepSeek 余额」；悬停看输入/输出/缓存读明细与充值/赠金拆分，点一下立即刷新，余额低于 ¥1 时加粗、低于 ¥0.1 时变红。',
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            role: 'switch',
            'aria-checked': enabled ? 'true' : 'false',
            'aria-label': '侧栏显示用量与余额',
            className: 'dsh-web-chat-switch' + (enabled ? ' on' : ''),
            onClick: () => updateUiPrefs({ usageRow: !enabled }),
          },
          h('span', { className: 'dsh-web-chat-switch-knob' }),
        ),
      );
    }

    function formatSessionTime(seconds) {
      const value = Number(seconds);
      if (!Number.isFinite(value) || value <= 0) return '';
      const date = new Date(value * 1000);
      const now = new Date();
      const pad = (value) => String(value).padStart(2, '0');
      if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()) {
        return pad(date.getHours()) + ':' + pad(date.getMinutes());
      }
      if (date.getFullYear() === now.getFullYear()) return pad(date.getMonth() + 1) + '-' + pad(date.getDate());
      return String(date.getFullYear());
    }

    function composerShellFor(sessionId) {
      if (appCtx === null) return null;
      if (sessionId === undefined || sessionId === null || sessionId === '') return null;
      try {
        const conversation = appCtx.get('conversation');
        if (conversation === null || conversation === undefined || conversation.input === undefined) return null;
        return conversation.input.shell(sessionId);
      } catch (error) {
        return null;
      }
    }

    function composerShell() {
      return composerShellFor(currentSessionId());
    }

    function focusComposerFor(sessionId) {
      const shell = composerShellFor(sessionId);
      if (shell !== null && typeof shell.focus === 'function') {
        try {
          shell.focus();
        } catch (error) {
          /* focus is best effort */
        }
      }
    }

    function focusComposer() {
      focusComposerFor(currentSessionId());
    }

    function notifyComposer(text) {
      const shell = composerShell();
      if (shell !== null && typeof shell.notify === 'function') {
        try {
          shell.notify('info', text);
        } catch (error) {
          /* notify is best effort */
        }
      }
    }

    function clearNoticeSoon() {
      window.setTimeout(() => {
        if (state.notice !== '') emit({ notice: '' });
      }, 4000);
    }

    async function copyHandoffText() {
      const captured = await captureMessages('all');
      if (captured === null) {
        emit({ notice: '没有读到可复制的消息' });
        clearNoticeSoon();
        return;
      }
      const text = formatHandoff(captured.messages, 'all', captured.truncated);
      try {
        await navigator.clipboard.writeText(text);
        emit({ notice: '已复制整段交接文本，可粘贴给其他 Agent' });
      } catch (error) {
        emit({ notice: '复制失败' });
      }
      clearNoticeSoon();
    }

    // ---------- 会话列表 ----------
    function compareRows(left, right) {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
      return right.updatedAt - left.updatedAt;
    }

    /** 会话按分组切片：自定义分组在前（创建顺序），未分组殿后；每段内部置顶在前 + 时间倒序。带搜索词时按标题过滤并隐藏空段。 */
    function groupedSessionRows(list, query) {
      const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
      const pins = new Set(uiPrefs.pins);
      const rows = list.rows
        .filter((row) => needle === '' || row.title.toLowerCase().includes(needle))
        .map((row) => ({
          id: row.id,
          title: row.title,
          updatedAt: row.updatedAt,
          pinned: row.pinned === true || pins.has(row.id),
          groupId: uiPrefs.assignments[row.id] ?? '',
        }));
      const sections = [];
      for (const group of uiPrefs.groups) {
        const sectionRows = rows.filter((row) => row.groupId === group.id).sort(compareRows);
        if (needle !== '' && sectionRows.length === 0) continue;
        sections.push({ key: group.id, type: 'group', group, rows: sectionRows });
      }
      const rest = rows.filter((row) => row.groupId === '').sort(compareRows);
      if (needle === '' || rest.length > 0) {
        sections.push({ key: UNGROUPED_KEY, type: 'ungrouped', group: null, rows: rest });
      }
      return sections;
    }

    function PinGlyph({ size = 13, filled = false }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, focusable: false },
        h('path', {
          d: 'M12 17v5',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z',
          fill: filled ? 'currentColor' : 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
      );
    }

    function ChevronGlyph({ size = 12, open = true }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': true,
          focusable: false,
          style: { transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform .15s ease' },
        },
        h('path', { d: 'M4 6.5 8 10.5 12 6.5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      );
    }

    function TrashGlyph({ size = 14 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, focusable: false },
        h('path', {
          d: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    function PlusGlyph({ size = 16 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, focusable: false, strokeWidth: 1 },
        h('path', { d: 'M8 2V14', stroke: 'currentColor' }),
        h('path', { d: 'M2 8H14', stroke: 'currentColor' }),
      );
    }

    function TriangleGlyph({ size = 14, open = false }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': true,
          focusable: false,
          style: { transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 150ms var(--ds-ease-in-out, ease)' },
        },
        h('path', {
          d: 'M5.5 4.5C5.5 4.40714 5.52586 4.31612 5.57467 4.23713C5.62349 4.15815 5.69334 4.09431 5.77639 4.05279C5.85945 4.01126 5.95242 3.99368 6.0449 4.00202C6.13738 4.01036 6.22572 4.04429 6.3 4.1L10.967 7.6C11.0291 7.64657 11.0795 7.70697 11.1142 7.77639C11.1489 7.84582 11.167 7.92238 11.167 8C11.167 8.07762 11.1489 8.15418 11.1142 8.22361C11.0795 8.29303 11.0291 8.35343 10.967 8.4L6.3 11.9C6.22572 11.9557 6.13738 11.9896 6.0449 11.998C5.95242 12.0063 5.85945 11.9887 5.77639 11.9472C5.69334 11.9057 5.62349 11.8419 5.57467 11.7629C5.52586 11.6839 5.5 11.5929 5.5 11.5V4.5Z',
          fill: 'currentColor',
        }),
      );
    }

    // 分组图标与官方 ui-primitives 同款：收起 IconFolderCloseRegular、展开 IconFolderOpenRegular（path 原样取自 dsh-client-ui-primitives）。
    function FolderGlyph({ size = 16, open = false }) {
      if (open) {
        return h(
          'svg',
          { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, focusable: false },
          h('path', {
            d: 'M2.55912 7.93683C2.67584 7.49906 3.0723 7.19446 3.52536 7.19446H13.6491C14.3061 7.19446 14.7846 7.81725 14.6153 8.45209L13.4411 12.856C13.3244 13.2938 12.9279 13.5984 12.4748 13.5984H2.35113C1.69411 13.5984 1.21562 12.9756 1.38489 12.3407L2.55912 7.93683Z',
            fill: 'currentColor',
            opacity: '0.16',
          }),
          h('path', {
            d: 'M13.6491 6.69446C14.6346 6.69453 15.3522 7.62895 15.0983 8.58118L13.9245 12.9845C13.7494 13.6412 13.1539 14.0988 12.4743 14.0988H2.35126C1.36574 14.0988 0.648153 13.1643 0.902044 12.212L2.07587 7.80774C2.25102 7.15128 2.84567 6.69455 3.52509 6.69446H13.6491ZM3.52509 7.69446C3.29865 7.69455 3.10004 7.84674 3.04169 8.06555L1.86786 12.4698C1.78345 12.7872 2.02285 13.0988 2.35126 13.0988H12.4743C12.7007 13.0988 12.8992 12.9463 12.9577 12.7277L14.1325 8.32336C14.2171 8.00598 13.9776 7.69453 13.6491 7.69446H3.52509Z',
            fill: 'currentColor',
          }),
          h('path', {
            d: 'M4.7666 1.90137C5.13227 1.90144 5.48571 2.03525 5.75977 2.27734L7.27246 3.61328C7.36379 3.69382 7.48174 3.73828 7.60352 3.73828H12.3994C13.2276 3.73841 13.8993 4.41005 13.8994 5.23828V6.7168C13.8183 6.70327 13.735 6.69436 13.6494 6.69434H12.8994V5.23828C12.6754 4.96233 12.3994 4.73841 12.3994 4.73828H7.60352C7.23781 4.73828 6.88446 4.60438 6.61035 4.3623L5.09766 3.02637C5.00636 2.94576 4.88838 2.90144 4.7666 2.90137H2.0498C1.77366 2.90137 1.5498 3.12523 1.5498 3.40137V9.78223L0.902344 12.2119C0.648452 13.1642 1.36604 14.0986 2.35156 14.0986H2.0498C1.2214 14.0986 0.549838 13.427 0.549805 12.5986V3.40137C0.549805 2.57294 1.22138 1.90137 2.0498 1.90137H4.7666Z',
            fill: 'currentColor',
          }),
        );
      }
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, focusable: false, strokeWidth: 1 },
        h('path', {
          d: 'M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z',
          stroke: 'currentColor',
        }),
        h('path', { d: 'M3.63501 7.66614H12.3647', stroke: 'currentColor' }),
      );
    }

    function SearchGlyph({ size = 14 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, focusable: false, strokeWidth: 1 },
        h('path', {
          d: 'M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586Z',
          stroke: 'currentColor',
        }),
        h('path', { d: 'M10.2991 10.3933L14.7783 14.8725', stroke: 'currentColor' }),
      );
    }

    function CloseGlyph({ size = 12 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, focusable: false, strokeWidth: 1 },
        h('path', { d: 'M3.5 3.5L12.5 12.5', stroke: 'currentColor' }),
        h('path', { d: 'M12.5 3.5L3.5 12.5', stroke: 'currentColor' }),
      );
    }

    function PencilGlyph({ size = 12 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, focusable: false },
        h('path', {
          d: 'M2.5 13.5l.5-2.4L10.6 3.5l1.9 1.9L4.9 13l-2.4.5Z',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M10 4.1l1.9 1.9', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
      );
    }

    function SidebarSessionEntry({ wide = true }) {
      const list = useSessionList();
      const prefs = useUiPrefs();
      const [pendingDelete, setPendingDelete] = React.useState(null);
      // 归组菜单 / 分组新建与重命名表单 / 删除分组确认，三块浮层状态。
      const [groupMenu, setGroupMenu] = React.useState(null);
      const [groupForm, setGroupForm] = React.useState(null);
      const [pendingGroupDelete, setPendingGroupDelete] = React.useState(null);
      // 区头内联搜索（对齐工作区）：展开时标题与操作按钮让位，按标题过滤会话。
      const [search, setSearch] = React.useState('');
      const [searchExpanded, setSearchExpanded] = React.useState(false);
      const searchInputRef = React.useRef(null);
      React.useEffect(() => {
        if (searchExpanded && searchInputRef.current !== null && typeof searchInputRef.current.focus === 'function') {
          searchInputRef.current.focus();
        }
      }, [searchExpanded]);
      // 滚动自动加载：接近底部或内容不满一屏时 limit+20 重拉，替代「显示更多」按钮。
      const [loadingMore, setLoadingMore] = React.useState(false);
      const listRef = React.useRef(null);
      const loadMoreLock = React.useRef(false);
      const searching = search.trim() !== '';
      const triggerLoadMore = () => {
        if (loadMoreLock.current) return;
        if (!list.hasMore || list.status !== 'ready') return;
        if (uiPrefs.limit >= SESSION_LIMIT_MAX) return;
        loadMoreLock.current = true;
        setLoadingMore(true);
        updateUiPrefs({ limit: Math.min(SESSION_LIMIT_MAX, uiPrefs.limit + 20) });
        void refreshSessionList().finally(() => {
          loadMoreLock.current = false;
          setLoadingMore(false);
        });
      };
      const handleListScroll = () => {
        if (searching || !list.hasMore) return;
        const element = listRef.current;
        if (element === null || element.clientHeight === 0) return;
        if (element.scrollHeight <= element.clientHeight) {
          triggerLoadMore();
          return;
        }
        if (element.scrollTop + element.clientHeight >= element.scrollHeight - 80) triggerLoadMore();
      };
      // 内容不满一屏时永远等不到滚动事件，渲染后主动补一页，直到出现滚动条或拉满。
      React.useEffect(() => {
        if (searching || !list.hasMore || list.status !== 'ready') return undefined;
        if (uiPrefs.limit >= SESSION_LIMIT_MAX) return undefined;
        const element = listRef.current;
        if (element === null || element.scrollHeight > element.clientHeight) return undefined;
        const timer = window.setTimeout(() => {
          handleListScroll();
        }, 120);
        return () => window.clearTimeout(timer);
      }, [list, prefs, searching]);
      React.useEffect(() => {
        if (pendingDelete === null && groupMenu === null && groupForm === null && pendingGroupDelete === null) return undefined;
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            setPendingDelete(null);
            setGroupMenu(null);
            setGroupForm(null);
            setPendingGroupDelete(null);
          }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
      }, [pendingDelete, groupMenu, groupForm, pendingGroupDelete]);
      React.useEffect(() => {
        void refreshSessionList();
        const timer = window.setInterval(() => {
          void refreshSessionList();
        }, SESSION_LIST_REFRESH_MS);
        return () => window.clearInterval(timer);
      }, []);
      // 56px 轨道只放一个图标按钮。
      if (!wide) {
        return h(
          'button',
          { type: 'button', className: 'dsh-web-chat-foot-icon', title: 'DeepSeek 会话区', 'aria-label': 'DeepSeek 会话区', onClick: () => openPage() },
          h(PanelGlyph, { size: 20 }),
        );
      }
      const sections = groupedSessionRows(list, search);
      const children = [];
      if (!prefs.collapsed) {
        if (list.status === 'loading') {
          children.push(h('div', { key: 'loading', className: 'dsh-web-chat-foot-empty' }, '读取网页会话…'));
        } else if (list.rows.length === 0) {
          if (list.error === 'not-signed-in') {
            children.push(
              h(
                'button',
                {
                  key: 'login',
                  type: 'button',
                  className: 'dsh-web-chat-foot-item dsh-web-chat-foot-state-btn',
                  title: '登录 DeepSeek 网页版',
                  onClick: () => openNewConversation(),
                },
                h('span', { className: 'dsh-web-chat-foot-label' }, '未登录，点击登录'),
              ),
            );
          } else if (list.error === 'token-expired') {
            children.push(
              h(
                'button',
                {
                  key: 'relogin',
                  type: 'button',
                  className: 'dsh-web-chat-foot-item dsh-web-chat-foot-state-btn',
                  title: '打开 DeepSeek 网页重新登录',
                  onClick: () => openNewConversation(),
                },
                h('span', { className: 'dsh-web-chat-foot-label' }, '登录已过期，点击重新登录'),
              ),
            );
          } else if (list.error !== '') {
            children.push(
              h(
                'button',
                {
                  key: 'retry',
                  type: 'button',
                  className: 'dsh-web-chat-foot-item dsh-web-chat-foot-state-btn',
                  title: '重新加载会话列表',
                  onClick: () => void refreshSessionList(),
                },
                h('span', { className: 'dsh-web-chat-foot-label' }, '读取失败，点击重新加载'),
              ),
            );
          } else {
            children.push(h('div', { key: 'empty', className: 'dsh-web-chat-foot-empty' }, '还没有网页会话'));
          }
        } else {
          const renderRow = (row, inGroup) =>
            h(
              'div',
              {
                key: row.id,
                className: 'dsh-web-chat-foot-item' + (inGroup ? ' in-group' : '') + (row.id === list.activeId ? ' active' : ''),
                role: 'button',
                tabIndex: 0,
                title: row.title,
                onClick: () => openPage(row.id),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openPage(row.id);
                  }
                },
              },
              h('span', { className: 'dsh-web-chat-slot', 'aria-hidden': true }),
              h('span', { className: 'dsh-web-chat-foot-label' }, row.title),
              row.pinned
                ? h(
                    'span',
                    { className: 'dsh-web-chat-pin-static', role: 'img', title: '已置顶', 'aria-label': '已置顶' },
                    h(PinGlyph, { size: 14, filled: true }),
                  )
                : null,
              h('span', { className: 'dsh-web-chat-foot-time' }, formatSessionTime(row.updatedAt)),
              h(
                'span',
                { className: 'dsh-web-chat-foot-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-web-chat-foot-act',
                    title: row.pinned ? '取消置顶' : '置顶',
                    'aria-label': row.pinned ? '取消置顶' : '置顶',
                    onClick: (event) => {
                      event.stopPropagation();
                      const target = !row.pinned;
                      const inLocal = prefs.pins.includes(row.id);
                      if (target && !inLocal) togglePinnedSession(row.id);
                      if (!target && inLocal) togglePinnedSession(row.id);
                      void pinWebSession(row.id, target);
                    },
                  },
                  h(PinGlyph, { size: 14, filled: row.pinned }),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-web-chat-foot-act',
                    title: row.groupId === '' ? '归入分组' : '移动分组',
                    'aria-label': row.groupId === '' ? '归入分组' : '移动分组',
                    onClick: (event) => {
                      event.stopPropagation();
                      const rect = event.currentTarget.getBoundingClientRect();
                      setGroupMenu({
                        sessionId: row.id,
                        groupId: row.groupId,
                        left: Math.max(8, Math.min(rect.left - 8, window.innerWidth - 200)),
                        top: Math.min(rect.bottom + 4, Math.max(8, window.innerHeight - 60 - prefs.groups.length * 32)),
                      });
                    },
                  },
                  h(FolderGlyph),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-web-chat-foot-act danger',
                    title: '删除会话',
                    'aria-label': '删除会话',
                    onClick: (event) => {
                      event.stopPropagation();
                      setPendingDelete(row);
                    },
                  },
                  h(TrashGlyph),
                ),
              ),
            );
          for (const section of sections) {
            // 搜索时无视折叠态，命中行全部展开；每个分组包独立容器，组间距不随展开状态漂移（对齐原生 groupSection）。
            const collapsed = !searching && sectionCollapsed(section.key);
            const sectionChildren = [
              // 分组头对齐原生工作区 projectRow：34px、文件夹图标（悬停换成旋转三角）、14px 标题。
              h(
                'div',
                {
                  key: 'head-' + section.key,
                  className: 'dsh-web-chat-group-head',
                  role: 'button',
                  tabIndex: 0,
                  'aria-expanded': collapsed ? 'false' : 'true',
                  'aria-label': section.type === 'group' ? section.group.name + ' 分组' : '未分组会话',
                  title: collapsed ? '展开' : '收起',
                  onClick: () => toggleSectionCollapsed(section.key),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      toggleSectionCollapsed(section.key);
                    }
                  },
                },
                h('span', { className: 'dsh-web-chat-slot dsh-web-chat-slot-folder', 'aria-hidden': true }, h(FolderGlyph, { size: 16, open: !collapsed })),
                h('span', { className: 'dsh-web-chat-slot dsh-web-chat-slot-chev', 'aria-hidden': true }, h(TriangleGlyph, { open: !collapsed })),
                h('span', { className: 'dsh-web-chat-group-name' }, section.type === 'group' ? section.group.name : '未分组'),
                h('span', { className: 'dsh-web-chat-group-count' }, String(section.rows.length)),
                section.type === 'group'
                  ? h(
                      'span',
                      { className: 'dsh-web-chat-group-actions' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-web-chat-foot-act',
                          title: '重命名分组',
                          'aria-label': '重命名分组',
                          onClick: (event) => {
                            event.stopPropagation();
                            setGroupForm({ id: section.group.id, name: section.group.name });
                          },
                        },
                        h(PencilGlyph, { size: 14 }),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-web-chat-foot-act danger',
                          title: '删除分组',
                          'aria-label': '删除分组',
                          onClick: (event) => {
                            event.stopPropagation();
                            setPendingGroupDelete(section.group);
                          },
                        },
                        h(TrashGlyph, { size: 14 }),
                      ),
                    )
                  : null,
              ),
            ];
            if (!collapsed) {
              for (const row of section.rows) sectionChildren.push(renderRow(row, section.type === 'group'));
            }
            children.push(h('div', { key: 'section-' + section.key, className: 'dsh-web-chat-group-section' }, sectionChildren));
          }
          if (searching && sections.length === 0) {
            children.push(h('div', { key: 'nomatch', className: 'dsh-web-chat-foot-empty' }, '没有匹配的会话'));
          }
        }
        if (loadingMore && !searching) {
          // 自动加载中：列表底部一个小 spinner；拉满 60 条后不再有任何残留行。
          children.push(h('div', { key: 'more-loading', className: 'dsh-web-chat-more-loading' }, h('span', { className: 'dsh-web-chat-spin-dot' })));
        }
      }
      const groupFormValid = groupForm !== null && groupForm.name.trim() !== '';
      const submitGroupForm = () => {
        if (groupForm === null || !groupFormValid) return;
        if (groupForm.id === null) createGroup(groupForm.name, groupForm.assignSessionId);
        else renameGroup(groupForm.id, groupForm.name);
        setGroupForm(null);
      };
      // 会话区主体（order 2，占列表可用高度 40%）与用量余额行（order 4，钉在工作区底部、设置行上方）拆成兄弟节点排序。
      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'dsh-web-chat-foot' + (prefs.collapsed ? ' is-collapsed' : '') },
        // 区头对齐原生工作区 sectionHeader：文字标签 + 内联搜索 + 圆形图标按钮；搜索展开时标签与按钮让位。
        h(
          'div',
          {
            className: 'dsh-web-chat-section-head',
            role: 'button',
            tabIndex: 0,
            title: prefs.collapsed ? '展开会话区' : '收起会话区',
            'aria-label': prefs.collapsed ? '展开会话区' : '收起会话区',
            'aria-expanded': prefs.collapsed ? 'false' : 'true',
            onClick: () => updateUiPrefs({ collapsed: prefs.collapsed !== true }),
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                updateUiPrefs({ collapsed: prefs.collapsed !== true });
              }
            },
          },
          h(
            'span',
            { className: 'dsh-web-chat-section-label' + (searchExpanded ? ' hidden' : '') },
            '会话区',
            // 整区收起时，有分组则用「···」提示里面还有分组。
            prefs.collapsed && prefs.groups.length > 0 ? h('span', { key: 'dots', className: 'dsh-web-chat-section-dots' }, '···') : null,
          ),
          h(
            'span',
            { className: 'dsh-web-chat-search-slot' + (searchExpanded ? ' expanded' : '') },
            h(
              'div',
              {
                className: 'dsh-web-chat-search' + (searchExpanded ? ' expanded' : ''),
                onClick: (event) => {
                  event.stopPropagation();
                  if (!searchExpanded) setSearchExpanded(true);
                },
              },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-web-chat-search-btn',
                  title: '搜索会话',
                  'aria-label': '搜索会话',
                  'aria-expanded': searchExpanded ? 'true' : 'false',
                  onClick: (event) => {
                    event.stopPropagation();
                    setSearchExpanded(true);
                  },
                },
                h(SearchGlyph, { size: searchExpanded ? 11 : 14 }),
              ),
              h('input', {
                ref: searchInputRef,
                className: 'dsh-web-chat-search-input',
                type: 'text',
                placeholder: '搜索会话',
                value: search,
                tabIndex: searchExpanded ? 0 : -1,
                onChange: (event) => setSearch(event.target.value),
                onKeyDown: (event) => {
                  if (event.key !== 'Escape') return;
                  setSearch('');
                  setSearchExpanded(false);
                },
              }),
              searchExpanded
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-web-chat-search-clear',
                      title: '清空搜索',
                      'aria-label': '清空搜索',
                      onClick: (event) => {
                        event.stopPropagation();
                        setSearch('');
                        setSearchExpanded(false);
                      },
                    },
                    h(CloseGlyph, { size: 12 }),
                  )
                : null,
            ),
          ),
          h(
            'div',
            { className: 'dsh-web-chat-section-actions' + (searchExpanded ? ' hidden' : '') },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-web-chat-section-btn',
                title: prefs.collapsed ? '展开会话区' : '收起会话区',
                'aria-label': prefs.collapsed ? '展开会话区' : '收起会话区',
                onClick: (event) => {
                  event.stopPropagation();
                  updateUiPrefs({ collapsed: prefs.collapsed !== true });
                },
              },
              h(
                'span',
                { className: 'dsh-web-chat-section-btn-glyph' + (prefs.collapsed ? '' : ' flip') },
                h(ChevronGlyph, { size: 14, open: true }),
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-web-chat-section-btn',
                title: '新建分组',
                'aria-label': '新建分组',
                onClick: () => setGroupForm({ id: null, name: '' }),
              },
              h(PlusGlyph, { size: 16 }),
            ),
          ),
        ),
        prefs.collapsed ? null : h('div', { className: 'dsh-web-chat-foot-list', ref: listRef, onScroll: handleListScroll }, children),
        pendingDelete === null
          ? null
          : h(
              'div',
              {
                className: 'dsh-web-chat-modal-backdrop',
                onClick: (event) => {
                  if (event.target === event.currentTarget) setPendingDelete(null);
                },
              },
              h(
                'div',
                { className: 'dsh-web-chat-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '删除会话' },
                h('div', { className: 'dsh-web-chat-modal-title' }, '删除会话'),
                h(
                  'div',
                  { className: 'dsh-web-chat-modal-body' },
                  '确定要删除「',
                  h('strong', { className: 'dsh-web-chat-modal-name' }, pendingDelete.title),
                  '」吗？',
                ),
                h('div', { className: 'dsh-web-chat-modal-hint' }, '删除后该会话会从 DeepSeek 网页版中移除，且无法恢复。'),
                h(
                  'div',
                  { className: 'dsh-web-chat-modal-actions' },
                  h('button', { type: 'button', className: 'dsh-web-chat-btn', onClick: () => setPendingDelete(null) }, '取消'),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-web-chat-btn danger',
                      onClick: () => {
                        const target = pendingDelete;
                        setPendingDelete(null);
                        void deleteWebSession(target.id);
                      },
                    },
                    '删除',
                  ),
                ),
              ),
            ),
        // 归组菜单：列出全部分组（当前组打 ✓）、新建分组、移出分组。
        groupMenu === null
          ? null
          : h(
              'div',
              { className: 'dsh-web-chat-menu-backdrop', onClick: () => setGroupMenu(null) },
              h(
                'div',
                {
                  className: 'dsh-web-chat-hdr-menu',
                  style: { left: groupMenu.left, top: groupMenu.top, minWidth: '184px' },
                  role: 'menu',
                  'aria-label': '归入分组',
                  onClick: (event) => event.stopPropagation(),
                },
                h('div', { className: 'dsh-web-chat-hdr-label' }, '归入分组'),
                prefs.groups.map((group) =>
                  h(
                    'button',
                    {
                      key: group.id,
                      type: 'button',
                      className: 'dsh-web-chat-hdr-item',
                      onClick: () => {
                        const target = groupMenu;
                        setGroupMenu(null);
                        if (target !== null && group.id !== target.groupId) assignSession(target.sessionId, group.id);
                      },
                    },
                    h('span', { className: 'dsh-web-chat-menu-check' }, group.id === groupMenu.groupId ? '✓' : ''),
                    group.name,
                  ),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-web-chat-hdr-item',
                    onClick: () => {
                      const target = groupMenu;
                      setGroupMenu(null);
                      if (target !== null) setGroupForm({ id: null, name: '', assignSessionId: target.sessionId });
                    },
                  },
                  h('span', { className: 'dsh-web-chat-menu-check' }),
                  '＋ 新建分组…',
                ),
                groupMenu.groupId === ''
                  ? null
                  : h(
                      'div',
                      { key: 'leave' },
                      h('div', { className: 'dsh-web-chat-hdr-sep' }),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-web-chat-hdr-item',
                          onClick: () => {
                            const target = groupMenu;
                            setGroupMenu(null);
                            if (target !== null) assignSession(target.sessionId, null);
                          },
                        },
                        h('span', { className: 'dsh-web-chat-menu-check' }),
                        '移出分组',
                      ),
                    ),
              ),
            ),
        // 新建 / 重命名分组弹窗。
        groupForm === null
          ? null
          : h(
              'div',
              {
                className: 'dsh-web-chat-modal-backdrop',
                onClick: (event) => {
                  if (event.target === event.currentTarget) setGroupForm(null);
                },
              },
              h(
                'div',
                {
                  className: 'dsh-web-chat-modal',
                  role: 'dialog',
                  'aria-modal': 'true',
                  'aria-label': groupForm.id === null ? '新建分组' : '重命名分组',
                },
                h('div', { className: 'dsh-web-chat-modal-title' }, groupForm.id === null ? '新建分组' : '重命名分组'),
                h('input', {
                  className: 'dsh-web-chat-modal-input',
                  value: groupForm.name,
                  autoFocus: true,
                  maxLength: GROUP_NAME_LIMIT,
                  placeholder: '分组名称',
                  onChange: (event) => setGroupForm({ ...groupForm, name: event.target.value }),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') submitGroupForm();
                  },
                }),
                h(
                  'div',
                  { className: 'dsh-web-chat-modal-actions' },
                  h('button', { type: 'button', className: 'dsh-web-chat-btn', onClick: () => setGroupForm(null) }, '取消'),
                  h(
                    'button',
                    { type: 'button', className: 'dsh-web-chat-btn', disabled: !groupFormValid, onClick: submitGroupForm },
                    groupForm.id === null ? '创建' : '保存',
                  ),
                ),
              ),
            ),
        // 删除分组确认弹窗：只删归组关系，会话回到未分组。
        pendingGroupDelete === null
          ? null
          : h(
              'div',
              {
                className: 'dsh-web-chat-modal-backdrop',
                onClick: (event) => {
                  if (event.target === event.currentTarget) setPendingGroupDelete(null);
                },
              },
              h(
                'div',
                { className: 'dsh-web-chat-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '删除分组' },
                h('div', { className: 'dsh-web-chat-modal-title' }, '删除分组'),
                h(
                  'div',
                  { className: 'dsh-web-chat-modal-body' },
                  '确定要删除分组「',
                  h('strong', { className: 'dsh-web-chat-modal-name' }, pendingGroupDelete.name),
                  '」吗？',
                ),
                h('div', { className: 'dsh-web-chat-modal-hint' }, '分组内的会话不会被删除，会回到「未分组」。'),
                h(
                  'div',
                  { className: 'dsh-web-chat-modal-actions' },
                  h('button', { type: 'button', className: 'dsh-web-chat-btn', onClick: () => setPendingGroupDelete(null) }, '取消'),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-web-chat-btn danger',
                      onClick: () => {
                        const target = pendingGroupDelete;
                        setPendingGroupDelete(null);
                        deleteGroup(target.id);
                      },
                    },
                    '删除',
                  ),
                ),
              ),
            ),
        ),
        // 用量余额行：独立兄弟节点，经 CSS order 钉在工作区底部、设置行上方。
        h(UsageBalanceRow),
      );
    }

    // ---------- 原生会话头里的「⋯」菜单 ----------
    // ---------- 主区域网页页（自带头部，选中时工作区会话取消选中）----------
    function PageSeat() {
      const ref = React.useRef(null);
      React.useEffect(() => {
        const element = ref.current;
        if (element === null) return undefined;
        let frame = 0;
        const measure = () => {
          frame = 0;
          if (!element.isConnected) {
            publishAreaRect(null);
            return;
          }
          const rect = element.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            publishAreaRect({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
          } else {
            publishAreaRect(null);
          }
        };
        const schedule = () => {
          if (frame === 0) frame = requestAnimationFrame(measure);
        };
        const observer = new ResizeObserver(schedule);
        observer.observe(element);
        window.addEventListener('resize', schedule);
        const poll = window.setInterval(schedule, 600);
        schedule();
        return () => {
          observer.disconnect();
          window.removeEventListener('resize', schedule);
          window.clearInterval(poll);
          if (frame !== 0) cancelAnimationFrame(frame);
          publishAreaRect(null);
          if (pageOpen) {
            setPageOpen(false);
            savedSessionId = '';
            emitSessionList({ activeId: '' });
          }
        };
      }, []);
      return h('div', { ref, className: 'dsh-web-chat-page' });
    }

    function HandoffDialog({ onClose }) {
      const [mode, setMode] = React.useState('round');
      const [destination, setDestination] = React.useState('new');
      const [instruction, setInstruction] = React.useState('');
      const [snapshot] = React.useState(() => {
        const options = handoffTaskOptions();
        return {
          ...options,
          source: { title: state.title || 'DeepSeek 网页对话', url: view === null ? '' : view.getURL() },
          workspaceId: workspaceIdForSession(currentSessionId()) || '',
        };
      });
      const [targets, setTargets] = React.useState({ previous: snapshot.previous, workspaces: snapshot.workspaces });
      const [workspaceId, setWorkspaceId] = React.useState(snapshot.workspaceId);
      const [captured, setCaptured] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [error, setError] = React.useState('');
      const [submitting, setSubmitting] = React.useState(false);
      const [retry, setRetry] = React.useState(0);
      const dialogRef = React.useRef(null);
      React.useEffect(() => {
        let active = true;
        setLoading(true);
        setCaptured(null);
        setError('');
        const available = handoffTaskOptions();
        setTargets(available);
        setWorkspaceId(current => available.workspaces.some(item => item.id === current) ? current : '');
        if (available.previous === null) setDestination('new');
        void captureMessages(mode).then(result => {
          if (!active) return;
          if (view === null || view.getURL() !== snapshot.source.url) {
            setError('来源会话已切换，请关闭后重新打开');
          } else if (result === null) {
            setError('未读到对话内容，请等待回复完成后重新读取');
          } else {
            setCaptured(result);
          }
        }).catch(() => { if (active) setError('读取失败，请重新读取'); })
          .finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
      }, [mode, retry]);
      React.useEffect(() => {
        if (typeof document === 'undefined') return;
        const previous = document.activeElement;
        dialogRef.current?.querySelector('select')?.focus();
        return () => { if (previous?.isConnected) previous.focus(); };
      }, []);
      const draft = captured === null ? '' : formatHandoff(captured.messages, mode, captured.truncated, {
        ...snapshot.source, instruction, generating: captured.generating,
      });
      const validTarget = destination === 'new' ? workspaceId !== '' : targets.previous !== null;
      const submit = async () => {
        if (loading || submitting || draft === '' || !validTarget) return;
        setSubmitting(true);
        setError('');
        try {
          const result = await doHandoff(draft, destination, targets.previous?.id || '', workspaceId);
          if (result.ok) onClose();
          else setError(result.error);
        } catch (error) {
          setError('填入失败，请重试');
        } finally {
          setSubmitting(false);
        }
      };
      const keyDown = event => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          if (!submitting) onClose();
        }
        if (event.key === 'Tab') {
          const nodes = [...(dialogRef.current?.querySelectorAll('button:not(:disabled),select:not(:disabled),textarea,input,[tabindex="0"]') || [])];
          const first = nodes[0];
          const last = nodes[nodes.length - 1];
          if (event.shiftKey && event.target === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && event.target === last) { event.preventDefault(); first?.focus(); }
        }
      };
      return h('div', {
        className: 'dsh-web-chat-modal-backdrop dsh-web-chat-handoff-backdrop',
        onClick: event => { if (event.target === event.currentTarget && !submitting) onClose(); },
        onKeyDown: keyDown,
      }, h('section', { className: 'dsh-web-chat-modal dsh-web-chat-handoff-dialog', ref: dialogRef, role: 'dialog', 'aria-modal': 'true', 'aria-label': '交给 Harness' },
        h('div', { className: 'dsh-web-chat-modal-title' }, '交给 Harness'),
        h('div', { className: 'dsh-web-chat-handoff-source' }, '来源：' + snapshot.source.title,
          h('div', { className: 'dsh-web-chat-handoff-url' }, snapshot.source.url)),
        h('div', { className: 'dsh-web-chat-handoff-fields' },
          h('label', { className: 'dsh-web-chat-handoff-field' }, '带哪些内容',
            h('select', { 'aria-label': '带哪些内容', value: mode, disabled: loading || submitting, onChange: event => setMode(event.target.value) },
              h('option', { value: 'round' }, '最近一轮问答'),
              h('option', { value: 'last' }, '最后一条回复'),
              h('option', { value: 'all' }, '整段对话'))),
          h('label', { className: 'dsh-web-chat-handoff-field' }, '交给哪个任务',
            h('select', { 'aria-label': '交给哪个任务', value: destination, disabled: submitting, onChange: event => setDestination(event.target.value) },
              h('option', { value: 'new' }, '新建任务'),
              h('option', { value: 'current', disabled: targets.previous === null },
                targets.previous === null ? '没有刚才的任务' : '刚才的任务：' + targets.previous.title)))),
        destination === 'new' ? h('label', { className: 'dsh-web-chat-handoff-field' }, '所在工作区',
          h('select', { 'aria-label': '所在工作区', value: workspaceId, disabled: submitting, onChange: event => setWorkspaceId(event.target.value) },
            h('option', { value: '', disabled: true }, '请选择工作区'),
            targets.workspaces.map(item => h('option', { key: item.id, value: item.id }, item.title))),
          targets.workspaces.length === 0 ? h('span', { className: 'dsh-web-chat-modal-hint' }, '请先在 Harness 添加一个工作区') : null) : null,
        h('label', { className: 'dsh-web-chat-handoff-field' }, '接下来做什么（可选）',
          h('textarea', { 'aria-label': '接下来做什么', rows: 2, value: instruction, disabled: submitting,
            placeholder: '例如：根据以上方案检查并修改本地配置', onChange: event => setInstruction(event.target.value) })),
        h('div', { className: 'dsh-web-chat-handoff-preview-label' }, '草稿预览',
          h('span', { 'aria-live': 'polite' }, loading ? '正在读取…' : Array.from(draft).length.toLocaleString() + ' 字')),
        h('textarea', { className: 'dsh-web-chat-handoff-preview', 'aria-label': '草稿预览', readOnly: true, rows: 8, value: draft,
          placeholder: loading ? '正在读取对话并生成预览…' : '读取后将在这里展示最终填入的内容' }),
        captured?.generating ? h('div', { className: 'dsh-web-chat-handoff-warning', role: 'alert' }, '回复仍在生成，当前预览可能不完整。请等待生成结束后重新读取。') : captured?.truncated ? h('div', { className: 'dsh-web-chat-handoff-warning', role: 'alert' }, '提取不完整，可能遗漏部分对话。请检查预览，或缩小内容范围。') : null,
        error !== '' ? h('div', { className: 'dsh-web-chat-handoff-warning', role: 'alert' }, error) : null,
        h('div', { className: 'dsh-web-chat-modal-hint' }, '预览是读取时的快照，不会随回复更新；若网页仍在生成，请等待完成后重新读取。确认后只填入草稿，由你检查并发送。图片和附件不会随文字转移。'),
        h('div', { className: 'dsh-web-chat-modal-actions' },
          h('button', { type: 'button', className: 'dsh-web-chat-btn', disabled: loading || submitting, onClick: () => setRetry(value => value + 1) }, '重新读取'),
          h('button', { type: 'button', className: 'dsh-web-chat-btn', disabled: submitting, onClick: onClose }, '取消'),
          h('button', { type: 'button', className: 'dsh-web-chat-btn dsh-web-chat-handoff-primary', disabled: loading || submitting || draft === '' || !validTarget, onClick: submit },
            submitting ? '正在填入…' : '填入任务草稿'))));
    }

    function WebSessionToolbar() {
      const app = useAppState();
      const [handoffOpen, setHandoffOpen] = React.useState(false);
      const refresh = () => {
        if (view === null) return;
        try {
          view.reload();
        } catch (error) {
          /* reload is best effort */
        }
        emit({ notice: '' });
      };
      return h(
        'div',
        { className: 'dsh-web-chat-bar' },
        h('span', { className: 'dsh-web-chat-dot' + (app.auth === 'in' ? ' on' : app.phase === 'error' ? ' bad' : '') }),
        h('span', { className: 'dsh-web-chat-title' }, 'dsh-web-chat'),
        h('span', { className: 'dsh-web-chat-doc-title', title: app.title }, app.title !== '' ? app.title : '网页对话'),
        h('span', { className: 'dsh-web-chat-spacer' }),
        app.notice !== '' ? h('span', { className: 'dsh-web-chat-notice', title: app.notice }, app.notice) : null,
        h(
          'button',
          { type: 'button', className: 'dsh-web-chat-btn dsh-web-chat-icon-btn', title: '刷新', 'aria-label': '刷新', onClick: refresh },
          h(RefreshGlyph, { size: 14 }),
        ),
        h('button', {
          type: 'button', className: 'dsh-web-chat-btn', onClick: () => setHandoffOpen(true),
          disabled: app.busy || view === null || app.phase !== 'ready',
        }, '交给 Harness'),
        handoffOpen ? h(HandoffDialog, { onClose: () => setHandoffOpen(false) }) : null,
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-web-chat-btn dsh-web-chat-icon-btn',
            title: '右侧栏',
            'aria-label': '开关右侧栏',
            onClick: () => openRightSidebar(),
          },
          h(RightGlyph, { size: 14 }),
        ),
      );
    }

    function RefreshGlyph({ size = 14 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, focusable: false },
        h('path', {
          d: 'M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    function WebSessionHost() {
      const open = usePageOpen();
      const app = useAppState();
      const rect = useAreaRect();
      const hostRef = React.useRef(null);
      React.useEffect(() => {
        if (open && rect !== null && hostRef.current !== null) ensureGuest(hostRef.current);
      }, [open, rect]);
      React.useEffect(() => {
        if (view === null || rect === null) return;
        try {
          view.style.width = '100%';
          view.style.height = '100%';
          view.style.display = 'flex';
          view.executeJavaScript('window.dispatchEvent(new Event("resize"))').catch(() => {});
        } catch (error) {
          /* resize is best effort */
        }
      }, [rect]);
      const style = {
        position: 'fixed',
        zIndex: 30,
        overflow: 'hidden',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
      };
      if (open && rect !== null) {
        Object.assign(style, { left: rect.left, top: rect.top, width: rect.width, height: rect.height, visibility: 'visible' });
      } else {
        Object.assign(style, { left: '-99999px', top: '-99999px', width: '420px', height: '620px', visibility: 'hidden' });
      }
      return h(
        'div',
        { className: 'dsh-web-chat-overlay', style },
        h(WebSessionToolbar),
        h('div', { ref: hostRef, className: 'dsh-web-chat-webapp' }),
        app.phase === 'loading' ? h('div', { className: 'dsh-web-chat-loading' }, '正在打开 DeepSeek…') : null,
        app.notice !== '' ? h('div', { className: 'dsh-web-chat-toast' }, app.notice) : null,
      );
    }

    const CSS = [
      '.dsh-web-chat-glyph{display:inline-flex;align-items:center;justify-content:center}',
      '.dsh-web-chat-overlay{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--dsw-alias-label-primary,#1f2329)}',
      '.dsh-web-chat-bar{height:40px;flex:0 0 40px;display:flex;align-items:center;gap:8px;padding:0 10px;border-bottom:1px solid var(--dsw-alias-border-l1,#e8eaee);background:var(--dsw-alias-bg-layer-1,#fff);font-size:12px}',
      '.dsh-web-chat-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#8b93a3);flex:0 0 auto}',
      '.dsh-web-chat-dot.on{background:var(--dsw-alias-state-success-primary,#16a34a)}',
      '.dsh-web-chat-dot.bad{background:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.dsh-web-chat-title{font-weight:600;white-space:nowrap}',
      '.dsh-web-chat-status{color:var(--dsw-alias-label-secondary,#545b66);white-space:nowrap}',
      '.dsh-web-chat-spacer{flex:1 1 auto}',
      '.dsh-web-chat-notice{color:var(--dsw-alias-state-success-primary,#16a34a);max-width:34%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-web-chat-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1,#e0e3e8);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);border-radius:6px;height:26px;padding:0 10px;font-size:12px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:4px}',
      '.dsh-web-chat-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.dsh-web-chat-btn:disabled{opacity:.55;cursor:default}',
      '.dsh-web-chat-icon-btn{width:28px;padding:0;justify-content:center}',
      '.dsh-web-chat-caret{font-size:10px;line-height:1;color:var(--dsw-alias-label-tertiary,#8b93a3)}',
      '.dsh-web-chat-page{display:flex;flex:1 1 auto;min-height:0;width:100%;height:100%;background:var(--dsw-alias-bg-layer-1,#fff)}',
      '.dsh-web-chat-doc-title{max-width:52%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500;font-size:13px;color:var(--dsw-alias-label-primary,#1f2329)}',
      '.dsh-web-chat-loading{position:absolute;left:0;right:0;top:40px;bottom:0;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#545b66);font-size:13px;z-index:1}',
      '.dsh-web-chat-menu-wrap{position:relative}',
      '.dsh-web-chat-menu{display:none;position:absolute;right:0;top:30px;min-width:132px;padding:4px;border:1px solid var(--dsw-alias-border-l1,#e0e3e8);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 8px 24px rgba(0,0,0,.12);z-index:5}',
      '.dsh-web-chat-menu-item{display:block;width:100%;text-align:left;appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-primary,#1f2329);border-radius:6px;padding:7px 9px;font-size:12px;cursor:pointer;white-space:nowrap}',
      '.dsh-web-chat-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.dsh-web-chat-menu-item.sub{padding-left:20px;font-size:12px;color:var(--dsw-alias-label-secondary,#545b66)}',
      '.dsh-web-chat-menu-label{padding:5px 9px 2px;color:var(--dsw-alias-label-tertiary,#8b93a3);font-size:11px;letter-spacing:.04em}',
      '.dsh-web-chat-menu-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l1,#e8eaee)}',
      '.dsh-web-chat-webapp{flex:1 1 auto;min-height:0;display:flex;position:relative;background:#fff}',
      '.dsh-web-chat-webview{width:100%;height:100%;display:flex;border:0}',
      '.dsh-web-chat-placeholder{flex:1 1 auto;min-height:0;width:100%;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-1,#fff)}',
      '.dsh-web-chat-placeholder-inner{display:flex;flex-direction:column;align-items:center;gap:10px;color:var(--dsw-alias-label-secondary,#545b66)}',
      '.dsh-web-chat-placeholder-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329)}',
      '.dsh-web-chat-placeholder-text{font-size:12px;max-width:460px;text-align:center;line-height:1.7}',
      '.dsh-web-chat-spinner{width:22px;height:22px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2,#d7dae0);border-top-color:var(--dsw-alias-brand-primary,#4d6bfe);animation:dsh-web-chat-spin .9s linear infinite}',
      '.dsh-web-chat-spinner.bad{border-top-color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.dsh-web-chat-foot{display:flex;flex-direction:column;flex:2 1 0px;order:2;min-height:0;width:100%;box-sizing:border-box;padding:0 0 4px;font-size:14px;line-height:20px}',
      '.dsh-web-chat-foot.is-collapsed{flex:0 0 auto}',
      // 会话区挪到工作区上面：footArea 与 footerActions 都透明化（display:contents），
      // 会话区与工作区按 2:3 分配扣除顶部控件、用量和账号后的可用高度，列表各自滚动；
      // 用量余额行(.dsh-web-chat-usage-bar, order 4) 钉在工作区底部、settingsArea(order 5) 之上。
      '[class*="footArea"]{display:contents !important}',
      '[class*="footerActions"]{display:contents !important}',
      '[class*="regionArea"]{order:3 !important;flex:3 1 0px !important;min-height:0 !important}',
      '[class*="settingsArea"]{order:5 !important;flex:0 0 auto !important}',
      '[class*="collapsed"] .dsh-web-chat-foot-icon{align-self:center}',
      '.dsh-web-chat-section-head{flex:0 0 auto;display:flex;align-items:center;gap:4px;box-sizing:border-box;height:36px;padding-left:4px;margin:2px 0 4px;color:var(--dsw-alias-label-tertiary,#8b93a3);cursor:pointer;user-select:none}',
      '.dsh-web-chat-section-head:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe));outline-offset:-2px;border-radius:12px}',
      '.dsh-web-chat-section-label{flex:none;max-width:45%;min-width:0;overflow:hidden;white-space:nowrap;font-size:14px;line-height:20px;color:inherit;opacity:1;visibility:visible;transition:max-width 180ms var(--ds-ease-in-out,ease),opacity 120ms var(--ds-ease-in-out,ease),visibility 0s linear}',
      '.dsh-web-chat-section-label.hidden{max-width:0;opacity:0;visibility:hidden;transition-delay:0s,0s,180ms}',
      '.dsh-web-chat-section-dots{flex:none;margin-left:6px;letter-spacing:2px;color:var(--dsw-alias-label-caption,#8b93a3);font-size:12px;line-height:20px}',
      '.dsh-web-chat-section-actions{flex:none;display:flex;align-items:center;gap:4px;max-width:60px;opacity:1;overflow:hidden;visibility:visible;transition:max-width 180ms var(--ds-ease-in-out,ease),opacity 120ms var(--ds-ease-in-out,ease),visibility 0s linear}',
      '.dsh-web-chat-section-actions.hidden{max-width:0;opacity:0;visibility:hidden;pointer-events:none;transition-delay:0s,0s,180ms}',
      '.dsh-web-chat-search-slot{flex:1;max-width:28px;min-width:0;display:flex;align-items:center;margin-left:auto;padding-left:0;box-sizing:border-box;transition:max-width 180ms var(--ds-ease-in-out,ease),padding-left 180ms var(--ds-ease-in-out,ease)}',
      '.dsh-web-chat-search-slot.expanded{max-width:100%}',
      '.dsh-web-chat-search{flex:none;display:flex;align-items:center;width:100%;height:28px;margin:0;padding:0;box-sizing:border-box;border:none;border-radius:50%;background:transparent;cursor:text;color:var(--dsw-alias-label-secondary,#545b66);overflow:hidden;transition:width 180ms var(--ds-ease-in-out,ease),border-color 180ms var(--ds-ease-in-out,ease),background-color 180ms var(--ds-ease-in-out,ease)}',
      '.dsh-web-chat-search.expanded{width:calc(100% + 4px);height:30px;margin-inline:-2px;padding:0 4px 0 0;border:0.5px solid var(--dsw-alias-border-l4,#d7dae0);border-radius:10px;color:var(--dsw-alias-label-caption,#8b93a3)}',
      '.dsh-web-chat-search-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:50%;padding:0;background:transparent;cursor:pointer;color:inherit}',
      '.dsh-web-chat-search-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.dsh-web-chat-search.expanded .dsh-web-chat-search-btn:hover{background:transparent}',
      '.dsh-web-chat-search-input{flex:1;width:0;min-width:0;border:none;outline:none;background:transparent;opacity:0;pointer-events:none;font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary,#1f2329);transition:opacity 120ms var(--ds-ease-in-out,ease)}',
      '.dsh-web-chat-search.expanded .dsh-web-chat-search-input{margin-left:-2px;opacity:1;pointer-events:auto}',
      '.dsh-web-chat-search-input::placeholder{color:var(--dsw-alias-label-tertiary,#8b93a3)}',
      '.dsh-web-chat-search-clear{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:none;border-radius:50%;padding:0;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary,#545b66)}',
      '.dsh-web-chat-search-clear:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.dsh-web-chat-section-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:50%;padding:0;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary,#545b66)}',
      '.dsh-web-chat-section-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.dsh-web-chat-section-btn-glyph{display:inline-flex;transition:transform 150ms var(--ds-ease-in-out,ease)}',
      '.dsh-web-chat-section-btn-glyph.flip{transform:rotate(180deg)}',
      '.dsh-web-chat-section-head button{-webkit-app-region:no-drag}',
      '.dsh-web-chat-foot-list{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;gap:0;overflow-y:auto}',
      '.dsh-web-chat-foot-list > * + *{margin-top:4px}',
      '.dsh-web-chat-group-section{display:flex;flex-direction:column;flex:0 0 auto}',
      '.dsh-web-chat-group-section > * + *{margin-top:2px}',
      '.dsh-web-chat-foot-item{box-sizing:border-box;flex:0 0 32px;display:flex;align-items:center;height:32px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#1f2329);font:inherit;font-size:14px;line-height:20px;text-align:left;cursor:pointer;user-select:none;overflow:hidden}',
      '.dsh-web-chat-foot-item:hover,.dsh-web-chat-foot-item.active{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.dsh-web-chat-foot-empty{flex:0 0 auto;padding:10px 12px;color:var(--dsw-alias-label-tertiary,#8b93a3);font-size:12px;line-height:18px}',
      '.dsh-web-chat-slot{flex:none;width:16px;height:20px;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,#8b93a3)}',
      '.dsh-web-chat-foot-label{flex:1;min-width:0;margin:0 6px 0 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-web-chat-pin-static{display:inline-flex;flex:none;width:16px;height:20px;align-items:center;justify-content:center;color:var(--dsw-alias-label-caption,#8b93a3)}',
      '.dsh-web-chat-foot-time{flex:none;padding-left:6px;color:var(--dsw-alias-label-caption,#8b93a3);font-size:10px;line-height:16px}',
      '.dsh-web-chat-foot-item:hover .dsh-web-chat-foot-time,.dsh-web-chat-foot-item:hover .dsh-web-chat-pin-static{display:none}',
      '.dsh-web-chat-foot-icon{appearance:none;border:0;background:transparent;width:36px;height:36px;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;color:var(--dsw-alias-label-primary)}',
      '.dsh-web-chat-foot-icon:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-web-chat-bar{-webkit-app-region:drag;user-select:none}',
      '.dsh-web-chat-bar button,.dsh-web-chat-bar .dsh-web-chat-menu,.dsh-web-chat-bar .dsh-web-chat-menu-wrap{-webkit-app-region:no-drag}',
      '.dsh-web-chat-hdr-btn{appearance:none;border:0;background:transparent;width:28px;height:28px;border-radius:var(--dsw-radius-sm,6px);color:var(--dsw-alias-label-secondary);font-size:18px;line-height:1;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0}',
      '.dsh-web-chat-hdr-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsh-web-chat-hdr-menu{position:fixed;z-index:1000;min-width:212px;padding:5px;border:1px solid var(--dsw-alias-border-l1,#e0e3e8);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 10px 30px rgba(0,0,0,.16);display:flex;flex-direction:column;gap:1px}',
      '.dsh-web-chat-hdr-item{appearance:none;border:0;background:transparent;text-align:left;padding:7px 10px;border-radius:7px;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;cursor:pointer;white-space:nowrap}',
      '.dsh-web-chat-hdr-item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-web-chat-hdr-item.sub{padding-left:24px;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dsh-web-chat-hdr-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l1,#e8eaee)}',
      '.dsh-web-chat-hdr-label{padding:6px 10px 2px;color:var(--dsw-alias-label-tertiary);font-size:11px;letter-spacing:.04em}',
      '.dsh-web-chat-toast{position:absolute;left:50%;bottom:20px;transform:translateX(-50%);padding:7px 14px;border-radius:999px;background:rgba(20,22,26,.86);color:#fff;font-size:12px;line-height:18px;z-index:2;pointer-events:none;max-width:80%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-web-chat-foot-state-btn{color:var(--dsw-alias-label-tertiary)}',
      '.dsh-web-chat-foot-state-btn:hover{color:var(--dsw-alias-label-primary)}',
      '.dsh-web-chat-hotkey-actions{display:flex;align-items:center;gap:10px;flex:none}',
      '.dsh-web-chat-hotkey-recording{color:var(--dsw-alias-state-business-primary,#4d6bfe);font-size:12px;line-height:18px}',
      '.dsh-web-chat-set-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#eceef1)}',
      '.dsh-web-chat-set-copy{min-width:0;display:flex;flex-direction:column;gap:4px}',
      '.dsh-web-chat-set-title{color:var(--dsw-alias-label-primary,#1f2329);font-size:14px;line-height:22px;font-weight:500}',
      '.dsh-web-chat-set-desc{color:var(--dsw-alias-label-tertiary,#8b93a3);font-size:12px;line-height:18px}',
      '.dsh-web-chat-set-binding{color:var(--dsw-alias-label-secondary,#545b66);font-size:12px;line-height:18px;display:flex;align-items:center;gap:6px}',
      '.dsh-web-chat-kbd{display:inline-flex;align-items:center;padding:1px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#e0e3e8);background:var(--dsw-alias-bg-layer-2,#f7f8fa);font-family:var(--dsw-alias-font-mono,monospace);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#545b66)}',
      '.dsh-web-chat-switch{position:relative;flex:none;width:34px;height:20px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,#d9dde3);background:var(--dsw-alias-bg-layer-3,#eef1f6);cursor:pointer;padding:0;transition:background .15s ease,border-color .15s ease}',
      '.dsh-web-chat-switch.on{background:var(--dsw-alias-brand-primary,#4d6bfe);border-color:transparent}',
      '.dsh-web-chat-switch-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .15s ease}',
      '.dsh-web-chat-switch.on .dsh-web-chat-switch-knob{transform:translateX(14px)}',
      '.dsh-web-chat-modal-backdrop{position:fixed;inset:0;z-index:2000;background:rgba(15,17,20,.36);display:flex;align-items:center;justify-content:center;padding:24px}',
      '.dsh-web-chat-modal{width:320px;max-width:calc(100vw - 48px);box-sizing:border-box;padding:18px 18px 14px;border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,#e6e8ec);box-shadow:0 18px 48px rgba(0,0,0,.24);color:var(--dsw-alias-label-primary,#1f2329);font-family:inherit}',
      '.dsh-web-chat-handoff-backdrop{-webkit-app-region:no-drag;cursor:default;white-space:normal}',
      '.dsh-web-chat-handoff-dialog{width:560px;max-height:calc(100vh - 48px);overflow:auto;font-size:13px;line-height:1.5}',
      '.dsh-web-chat-handoff-source{margin-bottom:14px;font-size:12px;color:var(--dsw-alias-label-secondary,#545b66);overflow-wrap:anywhere}',
      '.dsh-web-chat-handoff-url{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b93a3)}',
      '.dsh-web-chat-handoff-fields{display:flex;flex-wrap:wrap;gap:12px}',
      '.dsh-web-chat-handoff-field{display:flex;flex:1;min-width:0;flex-direction:column;gap:5px;margin-bottom:12px;font-size:12px;color:var(--dsw-alias-label-secondary,#545b66)}',
      '.dsh-web-chat-handoff-field select,.dsh-web-chat-handoff-field textarea,.dsh-web-chat-handoff-preview{box-sizing:border-box;width:100%;min-width:0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1,#e0e3e8);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f7f8fa);color:var(--dsw-alias-label-primary,#1f2329);font:inherit;font-size:13px;line-height:1.5}',
      '.dsh-web-chat-handoff-field textarea{resize:vertical;min-height:60px}.dsh-web-chat-handoff-field select{height:36px;text-overflow:ellipsis}',
      '.dsh-web-chat-handoff-preview-label{display:flex;justify-content:space-between;gap:12px;margin:2px 0 6px;font-size:12px;color:var(--dsw-alias-label-secondary,#545b66)}',
      '.dsh-web-chat-handoff-preview{height:180px;min-height:100px;resize:vertical;white-space:pre-wrap}',
      '.dsh-web-chat-handoff-warning{margin-top:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary,#935b00);background:var(--dsw-alias-bg-layer-2,#fff8e8);padding:8px 10px;border-radius:8px}',
      '.dsh-web-chat-btn.dsh-web-chat-handoff-primary{background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff;border-color:transparent}.dsh-web-chat-btn:disabled{opacity:.5;cursor:default}',
      '.dsh-web-chat-modal-title{font-size:15px;font-weight:600;line-height:22px;margin-bottom:8px}',
      '.dsh-web-chat-modal-body{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#545b66);word-break:break-word}',
      '.dsh-web-chat-modal-name{color:var(--dsw-alias-label-primary,#1f2329)}',
      '.dsh-web-chat-modal-hint{margin-top:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8b93a3)}',
      '.dsh-web-chat-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}',
      '.dsh-web-chat-btn.danger{background:var(--dsw-alias-state-error-primary,#dc2626);border-color:transparent;color:#fff}',
      '.dsh-web-chat-btn.danger:hover{background:var(--dsw-alias-state-error-primary,#dc2626);opacity:.9}',
      '.dsh-web-chat-foot-actions{display:none;align-items:center;gap:10px;flex:none}',
      '.dsh-web-chat-foot-item:hover .dsh-web-chat-foot-actions{display:inline-flex}',
      '.dsh-web-chat-foot-act{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#8b93a3);width:16px;height:16px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0}',
      '.dsh-web-chat-foot-act:hover{color:var(--dsw-alias-label-primary,#1f2329)}',
      '.dsh-web-chat-foot-act.danger:hover{color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.dsh-web-chat-page-title{display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden;white-space:nowrap;font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary,#1f2329)}',
      '.dsh-web-chat-session-title{display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden;white-space:nowrap}',
      '.dsh-web-chat-session-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-web-chat-more-loading{flex:0 0 auto;display:flex;align-items:center;justify-content:center;padding:8px 0 4px}',
      '.dsh-web-chat-spin-dot{width:14px;height:14px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2,#d7dae0);border-top-color:var(--dsw-alias-brand-primary,#4d6bfe);animation:dsh-web-chat-spin .9s linear infinite}',
      '.dsh-web-chat-usage-bar{box-sizing:border-box;width:100%;flex:none;order:4;margin-top:2px;display:flex;align-items:center;justify-content:space-between;gap:6px;min-height:26px;padding:2px 8px;border:0;border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-tertiary,#8b93a3);font-family:inherit;font-size:11px;line-height:16px;text-align:left;cursor:pointer;white-space:nowrap;overflow:hidden}',
      '.dsh-web-chat-usage-bar:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-secondary,#545b66)}',
      '.dsh-web-chat-usage-bar:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe));outline-offset:-2px}',
      '.dsh-web-chat-usage-seg{display:inline-flex;align-items:baseline;gap:3px;min-width:0}',
      '.dsh-web-chat-usage-seg.bad .dsh-web-chat-usage-value{color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.dsh-web-chat-usage-label{color:var(--dsw-alias-label-tertiary,#8b93a3);flex:none}',
      '.dsh-web-chat-usage-value{color:var(--dsw-alias-label-secondary,#545b66);font-variant-numeric:tabular-nums;font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-web-chat-usage-value.strong{font-weight:700;color:var(--dsw-alias-label-primary,#1f2329)}',
      '.dsh-web-chat-usage-value.critical{color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.dsh-web-chat-usage-dot{color:var(--dsw-alias-label-quaternary,#c1c6cf);flex:none}',
      '.dsh-web-chat-group-head{box-sizing:border-box;display:flex;align-items:center;gap:6px;min-width:0;height:34px;padding:0 8px;border-radius:8px;color:var(--dsw-alias-label-primary,#1f2329);font:inherit;font-size:14px;line-height:20px;cursor:pointer;user-select:none}',
      '.dsh-web-chat-group-head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.dsh-web-chat-group-head:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe));outline-offset:-2px}',
      '.dsh-web-chat-group-head .dsh-web-chat-slot-chev{display:none}',
      '.dsh-web-chat-group-head:hover .dsh-web-chat-slot-chev{display:inline-flex}',
      '.dsh-web-chat-group-head:hover .dsh-web-chat-slot-folder{display:none}',
      '.dsh-web-chat-group-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-web-chat-group-count{flex:none;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary,#8b93a3)}',
      '.dsh-web-chat-group-actions{display:none;align-items:center;gap:10px;flex:none}',
      '.dsh-web-chat-group-head:hover .dsh-web-chat-group-actions{display:inline-flex}',
      '.dsh-web-chat-foot-item.in-group{padding-left:24px}',
      '.dsh-web-chat-menu-backdrop{position:fixed;inset:0;z-index:999}',
      '.dsh-web-chat-menu-check{display:inline-flex;justify-content:center;width:16px;flex:none;margin-right:2px;color:var(--dsw-alias-state-success-primary,#16a34a);font-size:11px}',
      '.dsh-web-chat-modal-input{box-sizing:border-box;width:100%;height:32px;margin-top:10px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1,#e0e3e8);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f7f8fa);color:var(--dsw-alias-label-primary,#1f2329);font:inherit;font-size:13px;outline:none}',
      '.dsh-web-chat-modal-input:focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '@keyframes dsh-web-chat-spin{to{transform:rotate(360deg)}}',
    ].join('\n');

    function apply(ctx) {
      appCtx = ctx;
      ctx.effect(
        () => {
          const tag = document.createElement('style');
          tag.dataset.plugin = 'dsh-web-chat';
          tag.textContent = CSS;
          document.head.appendChild(tag);
          return () => {
            tag.remove();
          };
        },
        'dsh-web-chat: styles',
      );
      ctx.effect(() => {
        try {
          return ctx.slots.inject('settings.general.item', () =>
            ctx.slots.register(
              {
                name: 'settings.general.item',
                id: 'dsh-web-chat-hotkey',
                order: 30,
              },
              HotkeySettingsRow,
            ),
          );
        } catch (error) {
          console.warn('[dsh-web-chat] settings.general.item 槽位不可用：', error);
          return undefined;
        }
      }, 'dsh-web-chat: settings row');
      ctx.effect(() => {
        try {
          return ctx.slots.inject('settings.general.item', () =>
            ctx.slots.register(
              {
                name: 'settings.general.item',
                id: 'dsh-web-chat-usage-row',
                order: 31,
              },
              UsageSettingsRow,
            ),
          );
        } catch (error) {
          console.warn('[dsh-web-chat] settings.general.item (usage) 槽位不可用：', error);
          return undefined;
        }
      }, 'dsh-web-chat: usage settings row');
      // 侧边栏底部的「会话」区：位于工作区列表下方、设置之上（sidebar.footer.action）。
      ctx.effect(() => {
        try {
          return ctx.slots.inject('sidebar.footer.action', () =>
            ctx.slots.register(
              {
                name: 'sidebar.footer.action',
                id: 'dsh-web-chat-entry',
              },
              SidebarSessionEntry,
            ),
          );
        } catch (error) {
          console.warn('[dsh-web-chat] sidebar.footer.action 槽位不可用：', error);
          return undefined;
        }
      }, 'dsh-web-chat: sidebar session entry');
      // 主区域的 DeepSeek 网页页（选中时工作区会话取消选中，顶部用本页自己的头部）。
      ctx.effect(() => {
        try {
          return ctx.slots.inject('main', () =>
            ctx.slots.register(
              {
                name: 'main',
                key: PANEL_ID,
              },
              PageSeat,
            ),
          );
        } catch (error) {
          console.warn('[dsh-web-chat] main 槽位不可用：', error);
          return undefined;
        }
      }, 'dsh-web-chat: main page');
      ctx.effect(() => {
        try {
          return ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register(
              {
                name: 'shell.overlay',
                id: 'dsh-web-chat-host',
              },
              WebSessionHost,
            ),
          );
        } catch (error) {
          console.warn('[dsh-web-chat] shell.overlay 槽位不可用：', error);
          return undefined;
        }
      }, 'dsh-web-chat: overlay host');
      ctx.effect(() => {
        void refreshSessionList();
        const timer = window.setInterval(() => {
          void refreshSessionList();
        }, SESSION_LIST_REFRESH_MS);
        const titleTimer = window.setInterval(() => {
          if (pageOpen) syncGuestTitle();
        }, 4000);
        const authTimer = window.setInterval(() => {
          if (!pageOpen || view === null) return;
          void probeAuth(view).then((auth) => {
            if (auth !== 'in' && auth !== 'out') return;
            emit({ auth });
            if (auth === 'in' && view !== null) void saveOwnSession(view);
          });
        }, 30000);
        return () => {
          window.clearInterval(timer);
          window.clearInterval(titleTimer);
          window.clearInterval(authTimer);
        };
      }, 'dsh-web-chat: session list poll');
      ctx.effect(
        () => () => {
          releaseGuest();
          appCtx = null;
        },
        'dsh-web-chat: cleanup',
      );
    }

    return {
      inject: ['slots', 'layout'],
      apply,
    };
  },
});
