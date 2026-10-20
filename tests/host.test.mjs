import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSessions, normalizeSessionSnapshot, sessionToken } from '../index.js';

const payload = {
  code: 0,
  data: {
    biz_data: {
      has_more: true,
      chat_sessions: [
        { id: '658ea2c7-4086-4907-a4d8-c938000d7c1e', title: ' WorkBuddy模型代理DSH ', pinned: true, updated_at: 1792464747.896 },
        { id: 'second', title: '', pinned: false, updated_at: 'not-a-number' },
        { id: '', title: 'ignored', updated_at: 1 },
        null,
      ],
    },
  },
};

test('normalizeSessions maps the DeepSeek fetch_page payload', () => {
  const result = normalizeSessions(payload);
  assert.equal(result.hasMore, true);
  assert.equal(result.sessions.length, 2);
  assert.deepEqual(result.sessions[0], {
    id: '658ea2c7-4086-4907-a4d8-c938000d7c1e',
    title: 'WorkBuddy模型代理DSH',
    pinned: true,
    updatedAt: 1792464747.896,
  });
  assert.equal(result.sessions[1].title, '未命名会话');
  assert.equal(result.sessions[1].updatedAt, 0);
});

test('normalizeSessions rejects unexpected payloads', () => {
  assert.throws(() => normalizeSessions(null), /unexpected DeepSeek session response/);
  assert.throws(() => normalizeSessions({ data: {} }), /unexpected DeepSeek session response/);
});


test('guest session snapshots are clamped and their userToken is readable', () => {
  const snapshot = normalizeSessionSnapshot({
    storage: { userToken: '{"value":"tok","__version":"0"}', theme: 'dark', bad: 42 },
    cookies: ['smidV2=abc', 'broken'],
    userAgent: 'Mozilla/5.0 Chrome/155',
    at: '2026-10-20T00:00:00.000Z',
  });
  assert.notEqual(snapshot, null);
  assert.deepEqual(snapshot.storage, { userToken: '{"value":"tok","__version":"0"}', theme: 'dark' });
  assert.deepEqual(snapshot.cookies, ['smidV2=abc']);
  assert.equal(snapshot.userAgent, 'Mozilla/5.0 Chrome/155');
  assert.equal(sessionToken(snapshot), 'tok');
  assert.equal(sessionToken({ storage: { userToken: 'bare-token' } }), 'bare-token');
  assert.equal(normalizeSessionSnapshot({ storage: {}, cookies: [] }), null);
});
