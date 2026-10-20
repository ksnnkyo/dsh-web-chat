import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bucketsFromUsage,
  createUsageState,
  dayKey,
  foldSessionEvents,
  readBalance,
  refreshUsage,
  summarizeUsage,
  usageOfEvent,
} from '../index.js';

const at = (year, month, day, hour = 12) => new Date(year, month - 1, day, hour).getTime();

function assistant(seq, turn, step, usage, time) {
  return { type: 'assistant/message', seq, time, data: { turn, step, usage } };
}

test('local calendar day keys follow the host timezone', () => {
  assert.equal(dayKey(at(2026, 10, 20, 0)), '2026-10-20');
  assert.equal(dayKey(at(2026, 10, 20, 23)), '2026-10-20');
  assert.equal(dayKey(at(2026, 1, 2, 3)), '2026-01-02');
});

test('usage samples of one turn and step replace each other', () => {
  const state = createUsageState();
  foldSessionEvents(
    [
      assistant(1, 1, 1, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 5 }, at(2026, 10, 20, 9)),
      assistant(2, 1, 1, { inputTokens: 120, outputTokens: 12, cacheReadTokens: 7 }, at(2026, 10, 20, 9)),
      assistant(3, 1, 2, { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0 }, at(2026, 10, 20, 10)),
    ],
    state,
  );
  assert.deepEqual(state.totals, { input: 320, output: 32, cacheRead: 7, cacheWrite: 0 });
});

test('retry resets the replacement slot so the retried attempt adds to the total', () => {
  const state = createUsageState();
  foldSessionEvents(
    [
      assistant(1, 2, 1, { inputTokens: 100, outputTokens: 10 }, at(2026, 10, 20, 9)),
      { type: 'llm/retry-started', seq: 2, time: at(2026, 10, 20, 9), data: { turn: 2, step: 1 } },
      assistant(3, 2, 1, { inputTokens: 100, outputTokens: 10 }, at(2026, 10, 20, 9)),
    ],
    state,
  );
  assert.deepEqual(state.totals, { input: 200, output: 20, cacheRead: 0, cacheWrite: 0 });
});

test('sample days split per local date and summarize into today versus all time', () => {
  const state = createUsageState();
  foldSessionEvents(
    [
      assistant(1, 1, 1, { inputTokens: 100, outputTokens: 10 }, at(2026, 10, 19, 22)),
      assistant(2, 1, 2, { inputTokens: 50, outputTokens: 5 }, at(2026, 10, 20, 1)),
    ],
    state,
  );
  const summary = summarizeUsage({ a: state, b: state }, at(2026, 10, 20, 12));
  assert.equal(summary.sessionCount, 2);
  assert.deepEqual(summary.today, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, total: 110 });
  assert.deepEqual(summary.total, { input: 300, output: 30, cacheRead: 0, cacheWrite: 0, total: 330 });
});

test('usage falls back to the last usage chunk of an attempt stream', () => {
  const event = {
    type: 'assistant/attempt',
    seq: 1,
    time: at(2026, 10, 20),
    data: {
      turn: 1,
      step: 1,
      stream: [
        { type: 'chunk', chunk: { type: 'text-delta', text: 'hi' } },
        { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 42, outputTokens: 4, cacheWriteTokens: 2 } } },
      ],
    },
  };
  assert.deepEqual(bucketsFromUsage(usageOfEvent(event)), { input: 42, output: 4, cacheRead: 0, cacheWrite: 2 });
  assert.equal(usageOfEvent({ type: 'tool/call', seq: 2, time: 0, data: {} }), undefined);
});

test('refresh reads unseen logs once and reuses rows for unchanged revisions', async () => {
  const opened = [];
  const events = [assistant(1, 1, 1, { inputTokens: 30, outputTokens: 3 }, at(2026, 10, 20, 8))];
  const persistence = {
    async list() {
      return [
        { header: { id: 'a' }, revision: 'r1' },
        { header: { id: 'b' }, revision: 'r1' },
      ];
    },
    async open(id) {
      opened.push(id);
      return {
        async read() {
          return { eventState: 'detached', events };
        },
        async close() {},
      };
    },
  };

  const first = await refreshUsage(persistence, Object.create(null));
  assert.deepEqual(opened, ['a', 'b']);
  assert.equal(first.changed, true);
  assert.deepEqual(first.sessions.a.totals, { input: 30, output: 3, cacheRead: 0, cacheWrite: 0 });

  opened.length = 0;
  const second = await refreshUsage(persistence, first.sessions);
  assert.deepEqual(opened, []);
  assert.equal(second.changed, false);

  const third = await refreshUsage(
    { ...persistence, async list() { return [{ header: { id: 'a' }, revision: 'r2' }]; } },
    first.sessions,
  );
  assert.deepEqual(opened, ['a']);
  assert.equal(Object.keys(third.sessions).length, 1);
});

test('migration-required sessions keep their cached total instead of blocking the refresh', async () => {
  const previous = Object.create(null);
  previous.a = { revision: 'r0', totals: { input: 7, output: 1, cacheRead: 0, cacheWrite: 0 }, days: {} };
  const persistence = {
    async list() {
      return [{ header: { id: 'a' }, revision: 'r1', formatStatus: 'migration-required' }];
    },
    async open() {
      throw new Error('must not open migration-required logs');
    },
  };
  const result = await refreshUsage(persistence, previous);
  assert.deepEqual(result.sessions.a.totals, { input: 7, output: 1, cacheRead: 0, cacheWrite: 0 });
});

test('balance projects recharge and bonus wallets per currency', async () => {
  const account = {
    async getState() {
      return { status: 'credential-stored' };
    },
    async getBalance() {
      return {
        status: 'ready',
        value: [{ currency: 'CNY', balance: '10.50' }],
        bonusWallets: [{ currency: 'CNY', balance: '2.00' }, { currency: 'USD', balance: '0.5' }],
      };
    },
  };
  const result = await readBalance(account, { version: 'test', locale: 'zh-CN', timezoneOffsetSeconds: 28800 });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.wallets, [
    { currency: 'CNY', balance: '10.50', bonus: '2.00' },
    { currency: 'USD', balance: '0', bonus: '0.5' },
  ]);
});

test('balance reports signed-out and failed states without inventing a zero', async () => {
  const signedOut = {
    async getState() {
      return { status: 'signed-out' };
    },
    async getBalance() {
      throw new Error('must not read a balance while signed out');
    },
  };
  assert.deepEqual(await readBalance(signedOut, {}), { status: 'signed-out' });

  const failed = {
    async getState() {
      return { status: 'credential-stored' };
    },
    async getBalance() {
      return { status: 'failed' };
    },
  };
  assert.deepEqual(await readBalance(failed, {}), { status: 'failed' });
});