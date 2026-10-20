import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSessions } from '../index.js';

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
