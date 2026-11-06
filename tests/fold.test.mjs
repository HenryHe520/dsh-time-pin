// Projection/injection behaviour tests: `node --test tests/fold.test.mjs`.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyEvent,
  createViewCache,
  initialState,
  planStep,
  stateSignature,
  windowFromState,
} from '../lib/core/fold.js';

const NOW = Date.UTC(2026, 10, 3, 12, 0, 0); // 2026-11-03

const run = (args, { id = 'c1', time = 1_000 } = {}) => ({
  type: 'command/run',
  time,
  data: { name: 'pin', commandId: id, args },
});
const done = ({ id = 'c1', time = 1_001, kind = 'success' } = {}) => ({
  type: 'command/done',
  time,
  data: { commandId: id, kind },
});
const header = (time = 1_002) => ({ type: 'request/header', time, data: {} });
const assistant = (text, time = 1_003) => ({
  type: 'assistant/message',
  time,
  data: { message: { content: [{ type: 'text', text }] } },
});
const toolResult = (time = 1_004) => ({ type: 'tool/result', time, data: {} });

const fold = (events, state = initialState(), options = {}) =>
  events.reduce((current, event) => applyEvent(current, event, options), state);

const pin = (args, options = {}) => fold([run(args), done(options)]);

const step = (state, extra = {}) => planStep({ state, nowMs: NOW, promptLocale: 'zh', ...extra });

test('default mode injects nothing', () => {
  const state = initialState();
  assert.deepEqual(step(state, { turnStart: true }), []);
  assert.equal(windowFromState(state), null);
  assert.equal(stateSignature(state, NOW), 'default');
});

test('/pin sets the window and injects the block exactly once', () => {
  const state = pin('2000-01-01 10年');
  assert.equal(state.restricted, true);
  assert.equal(state.asOf, 'ce:2000-01-01');
  assert.equal(state.before, '10y');
  assert.equal(state.after, '10y');
  assert.equal(state.anchorPending, true);

  const first = step(state, { turnStart: true });
  assert.equal(first.length, 1);
  assert.equal(first[0].form, 'snapshot');
  assert.match(first[0].text, /\[TIME PIN\]/);
  assert.match(first[0].text, /\[1990-01-01, 2010-01-01\]/);
  assert.match(first[0].text, /时间窗：2000-01-01 · 前后各10年/);

  // The request header records the watermark: no second injection, no reminder
  // before the model has had a turn to echo.
  const told = applyEvent(state, header(1_002));
  assert.deepEqual(step(told, { turnStart: true }), []);
  assert.deepEqual(step(told, { turnStart: false }), []);
});

test('anchor echo clears the pending flag; a missing echo earns at most two corrections', () => {
  const told = applyEvent(pin('2000-01-01 10年'), header());
  const echoed = applyEvent(told, assistant('时间窗：2000-01-01 · 前后各10年\n这是回答。'));
  assert.equal(echoed.anchorPending, false);
  assert.equal(echoed.lastOutputAt, 1_003);
  assert.deepEqual(step(echoed, { turnStart: true, canRemind: () => true }), []);

  const missed = applyEvent(told, assistant('直接回答了，没有确认。'));
  assert.equal(missed.anchorPending, true);
  const budget = { used: 0 };
  const canRemind = () => {
    if (budget.used >= 2) return false;
    budget.used += 1;
    return true;
  };
  const firstReminder = step(missed, { turnStart: true, canRemind });
  assert.equal(firstReminder.length, 1);
  assert.match(firstReminder[0].text, /\[TIME PIN · ANCHOR\]/);
  assert.match(firstReminder[0].text, /时间窗：2000-01-01 · 前后各10年/);
  step(missed, { turnStart: true, canRemind });
  assert.deepEqual(step(missed, { turnStart: true, canRemind }), []);
  // Reminders are only offered at turn start.
  assert.equal(step(missed, { turnStart: false, canRemind: () => true }).length, 0);
});

test('a tool call alone does not satisfy the echo but does update last output', () => {
  const told = applyEvent(pin('2000-01-01 10年'), header());
  const withTool = applyEvent(told, toolResult(2_000));
  assert.equal(withTool.anchorPending, true);
  assert.equal(withTool.lastOutputAt, 2_000);
});

test('changing the window re-injects with an update summary', () => {
  const told = applyEvent(pin('2000-01-01 10年'), header(1_100));
  const changed = fold([run('3000-01-01', { id: 'c2', time: 2_000 }), done({ id: 'c2', time: 2_001 })], told);
  assert.equal(changed.asOf, 'ce:3000-01-01');
  assert.equal(changed.before, '10y');
  assert.equal(changed.after, '10y');
  assert.equal(changed.anchorPending, true);
  const messages = step(changed, { turnStart: true });
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /受限模式/);
  assert.match(messages[0].text, /\[FUTURE VIEW\]/);
  assert.match(messages[0].text, /3000-01-01/);
});

test('an as-of-only pin keeps the current range', () => {
  const withRange = pin('2000-01-01 10年');
  const asOfOnly = fold([run('2000-06-01', { id: 'c2' }), done({ id: 'c2' })], withRange);
  assert.equal(asOfOnly.asOf, 'ce:2000-06-01');
  assert.equal(asOfOnly.before, '10y');
  assert.equal(asOfOnly.after, '10y');
});

test('/pin off returns to default mode and the clear notice is injected once', () => {
  const told = applyEvent(pin('2000-01-01 10年'), header(1_100));
  const cleared = fold([run('off', { id: 'c3', time: 2_000 }), done({ id: 'c3', time: 2_001 })], told);
  assert.equal(cleared.restricted, false);
  assert.equal(windowFromState(cleared), null);
  const notice = step(cleared, { turnStart: true });
  assert.equal(notice.length, 1);
  assert.match(notice[0].text, /时间窗已清空/);
  const toldDefault = applyEvent(cleared, header(2_002));
  assert.deepEqual(step(toldDefault, { turnStart: true }), []);
});

test('BCE windows render era labels and BC bounds', () => {
  const state = pin('公元前200年 前20年');
  assert.equal(state.asOf, 'bce:200-01-01');
  const [message] = step(state, { turnStart: true });
  assert.match(message.text, /有效时间（as_of）是 公元前200年/);
  assert.match(message.text, /公元前220年/);
  assert.match(message.text, /公元前180年/);
  assert.match(message.text, /时间窗：公元前200年 · 前后各20年/);
});

test('a bare year is January 1; a range alone restricts the window', () => {
  const state = pin('2000');
  assert.equal(state.asOf, 'ce:2000-01-01');
  assert.equal(state.before, null);
  assert.equal(state.after, null);
  const [message] = step(state, { turnStart: true });
  assert.match(message.text, /证据窗口：\[不限（不限制往前多久）, 不限（不限制往后多久）\]/);

  const recent = pin('7天');
  assert.equal(recent.restricted, true);
  assert.equal(recent.asOf, null);
  assert.equal(recent.before, '7d');
  assert.equal(recent.after, '7d');
  assert.equal(stateSignature(recent, NOW), 'today:ce:2026-11-03|7d|7d');
  const [recentMessage] = step(recent, { turnStart: true });
  assert.match(recentMessage.text, /默认（本地今天 2026-11-03）/);
  assert.match(recentMessage.text, /\[2026-10-27, 2026-11-10\]/);

  // `/pin 不限` clears the range again (both sides empty -> default).
  const cleared = fold([run('不限', { id: 'c9b' }), done({ id: 'c9b' })], recent);
  assert.equal(cleared.restricted, false);
});

test('turn boundaries drive the client run clock', () => {
  const started = fold([{ type: 'turn/start', time: 5_000, data: { turn: 1 } }]);
  assert.equal(started.runStartedAt, 5_000);
  assert.equal(applyEvent(started, { type: 'turn/end', time: 6_000, data: { turn: 1, reason: { kind: 'completed' } } }).runStartedAt, null);
  const viewOf = createViewCache();
  const view = viewOf(Object.assign(pin('2000-01-01 10年'), { runStartedAt: 5_000, lastOutputAt: 5_500 }));
  assert.equal(view.runStartedAt, 5_000);
  assert.equal(view.lastOutputAt, 5_500);
  assert.equal(view.modeBase, 'pinned');
  assert.equal(typeof view.asOfDay, 'number');
  assert.equal(viewOf(initialState()).modeBase, 'default');
  assert.equal(viewOf(pin('7天')).modeBase, 'recent');
});

test('invalid and failed commands never change the window', () => {
  const started = pin('2000-01-01 10年');
  const failed = fold([run('2026-02-30', { id: 'c4' }), done({ id: 'c4', kind: 'error' })], started);
  assert.equal(failed.asOf, 'ce:2000-01-01');
  assert.equal(failed.before, '10y');
  const invalid = fold([run('2026-02-30', { id: 'c5' }), done({ id: 'c5' })], started);
  assert.equal(invalid.asOf, 'ce:2000-01-01');
  assert.equal(invalid.before, '10y');
});

test('unrelated commands and events return the same reference', () => {
  const state = pin('2000-01-01 10年');
  assert.equal(applyEvent(state, { type: 'command/run', time: 5, data: { name: 'plan', commandId: 'x', args: 'x' } }), state);
  assert.equal(applyEvent(state, { type: 'user/message', time: 6, data: {} }), state);
  assert.equal(applyEvent(state, { type: 'step/start', time: 7, data: {} }), state);
});

test('the wire view is stable for an unchanged state and labels every mode', () => {
  const viewOf = createViewCache();
  const defaultState = initialState();
  const defaultView = viewOf(defaultState);
  assert.equal(viewOf(defaultState), defaultView);
  assert.equal(defaultView.chipLabel, '默认 · 不限');
  assert.equal(defaultView.restricted, false);
  assert.equal(defaultView.asOfInput, '');

  const pastView = viewOf(pin('2000-01-01 10年'));
  assert.equal(pastView.chipLabel, '2000-01-01 · 前后各10年');
  assert.equal(pastView.rangeLabel, '前后各10年');
  assert.equal(pastView.asOfInput, '2000-01-01');
  assert.equal(pastView.beforeInput, '10年');
  assert.equal(pastView.afterInput, '10年');
  assert.equal(pastView.restricted, true);

  const recentView = viewOf(fold([run('30天', { id: 'c1' }), done({ id: 'c1' })], initialState()));
  assert.equal(recentView.restricted, true);
  assert.equal(recentView.modeBase, 'recent');
  assert.equal(recentView.chipLabel, '默认 · 前后各30天');
  assert.equal(recentView.asOfInput, '');
  assert.equal(recentView.beforeInput, '30天');
  assert.equal(recentView.afterInput, '30天');

  const bceView = viewOf(pin('公元前200年 前20年'));
  assert.equal(bceView.chipLabel, '公元前200年 · 前后各20年');
  assert.equal(bceView.asOfInput, '公元前200年');

  const futureView = viewOf(pin('3000'));
  assert.equal(futureView.chipLabel, '3000-01-01 · 不限');
});

test('silence text is appended as its own notice', () => {
  const state = pin('2000-01-01 10年');
  const messages = step(state, {
    turnStart: true,
    silenceText: '[TIME FACT]\n后台任务 build（bash-1）已运行 4m12s。',
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[1].form, 'notice');
  assert.match(messages[1].text, /TIME FACT/);
});

test('en prompt locale produces English blocks and markers', () => {
  const state = pin('2000-01-01 10年');
  const [message] = planStep({ state, nowMs: NOW, promptLocale: 'en', turnStart: true });
  assert.match(message.text, /Evidence window:/);
  assert.match(message.text, /Time window: 2000-01-01 · ±10 years/);
});
