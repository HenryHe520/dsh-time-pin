// Projection schema validation with the REAL zod/schemastery modules.
//
// This is the regression test for the 0.1.0 crash: the Client wire view schema
// used `zod.union(['default', ...])` (schemastery syntax) instead of
// `zod.enum([...])`. zod accepts that call, but its internal `.run` throws when
// the value is validated — and the Session projection registry validates EVERY
// view before publishing it, so every conversation that loaded the projection
// snapshot failed. Module-load smoke tests never call `.parse()`, so they missed
// it; this file does call it.
//
// Like `host-wiring.test.mjs`, it runs only where the Harness packages resolve
// (installed profile or a sandbox that links them); otherwise every case is
// skipped rather than failed.
import test from 'node:test';
import assert from 'node:assert/strict';

const loaded = await import('./lib/index.js')
  .then((module) => ({ ok: true, module }))
  .catch((error) => ({ ok: false, error }));
const skip = loaded.ok ? false : `Harness packages not resolvable here (${loaded.error?.code ?? 'import failed'})`;

/** Build a fake Cordis context that keeps the registered projection definition. */
function captureProjection(env = {}) {
  const captured = {};
  const context = {
    logger: { warn: () => {} },
    effect: (callback) => {
      const disposer = callback();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    on: () => () => {},
    inject: (services, callback) => {
      const child = {
        ...context,
        commands: { register: () => {} },
        tools: { register: () => {} },
        jobs: { events: { subscribe: () => () => {} } },
      };
      child.inject = (names, cb) => cb(child);
      callback(child);
      return () => {};
    },
    sessionProjections: {
      register: (definition) => {
        captured.projection = definition;
        return () => {};
      },
      stateOf: () => undefined,
    },
  };
  loaded.module.apply(context, env);
  return captured.projection;
}

/** Build a fake Cordis context that records commands and event listeners. */
function createWiringContext() {
  const captured = { onEvents: [], commands: [], tools: [] };
  const context = {
    logger: { warn: () => {} },
    effect: (callback) => {
      const disposer = callback();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    on: (event, handler, options) => {
      captured.onEvents.push({ event, handler, options });
      return () => {};
    },
    inject: (services, callback) => {
      const child = {
        ...context,
        commands: { register: (definition) => captured.commands.push(definition) },
        tools: { register: (definition) => captured.tools.push(definition) },
        jobs: { events: { subscribe: () => () => {} } },
      };
      child.inject = (names, cb) => cb(child);
      callback(child);
      return () => {};
    },
    sessionProjections: {
      register: () => () => {},
      stateOf: () => undefined,
    },
  };
  return { ctx: context, captured };
}

/** Fold a `/pin` command into a projection state. */
function pinState(projection, args, extraEvents = []) {
  let state = projection.init({}, 0);
  state = projection.apply(state, {
    type: 'command/run',
    time: 1_000,
    data: { name: 'pin', commandId: 'c1', args },
  });
  state = projection.apply(state, { type: 'command/done', time: 1_001, data: { commandId: 'c1', kind: 'success' } });
  for (const event of extraEvents) state = projection.apply(state, event);
  return state;
}

const header = (time) => ({ type: 'request/header', time, data: {} });
const assistant = (text, time) => ({
  type: 'assistant/message',
  time,
  data: { message: { content: [{ type: 'text', text }] } },
});

/** Every projection state shape the plugin can produce, as (name, state) pairs. */
function representativeStates(projection) {
  return [
    ['default', projection.init({}, 0)],
    ['pinned past', pinState(projection, '2000-01-01 10年')],
    ['pinned as-of only', pinState(projection, '2000-01-01')],
    ['recent (span only)', pinState(projection, '7天')],
    ['pinned future', pinState(projection, '3000-01-01')],
    ['pinned BCE', pinState(projection, '公元前200年 前20年')],
    [
      'echo confirmed',
      pinState(projection, '2000-01-01 10年', [
        header(1_002),
        assistant('时间窗：2000-01-01 · 前10年\n回答。', 1_003),
      ]),
    ],
    [
      'anchor pending + tool output',
      pinState(projection, '2000-01-01 10年', [
        header(1_002),
        { type: 'tool/result', time: 1_004, data: {} },
      ]),
    ],
    [
      'running turn',
      pinState(projection, '2000-01-01 10年', [
        { type: 'turn/start', time: 1_100, data: { turn: 1 } },
        { type: 'assistant/message', time: 1_200, data: { message: { content: [] } } },
        { type: 'turn/end', time: 1_300, data: { turn: 1, reason: { kind: 'completed' } } },
      ]),
    ],
    [
      'cleared after pin',
      (() => {
        let state = pinState(projection, '2000-01-01 10年', [header(1_002)]);
        state = projection.apply(state, { type: 'command/run', time: 2_000, data: { name: 'pin', commandId: 'c2', args: 'off' } });
        state = projection.apply(state, { type: 'command/done', time: 2_001, data: { commandId: 'c2', kind: 'success' } });
        return state;
      })(),
    ],
  ];
}

test('the projection state schema validates every state the fold can produce', { skip }, () => {
  const projection = captureProjection();
  assert.equal(typeof projection.stateSchema.parse, 'function', 'stateSchema must be a zod schema');
  for (const [label, state] of representativeStates(projection)) {
    const parsed = projection.stateSchema.parse(state);
    assert.equal(parsed.restricted, state.restricted, label);
    assert.equal(parsed.asOf, state.asOf, label);
    assert.equal(parsed.span, state.span, label);
  }
});

test('the Client wire view schema validates every view the cache can produce', { skip }, () => {
  const projection = captureProjection();
  assert.equal(typeof projection.wire.viewSchema.parse, 'function', 'viewSchema must be a zod schema');
  for (const [label, state] of representativeStates(projection)) {
    const view = projection.wire.view(state);
    assert.equal(typeof view, 'object', label);
    const parsed = projection.wire.viewSchema.parse(view);
    assert.equal(parsed.chipLabel, view.chipLabel, label);
    assert.equal(parsed.modeBase, view.modeBase, label);
    assert.ok(['default', 'recent', 'pinned'].includes(parsed.modeBase), label);
    assert.equal(parsed.version, view.version, label);
  }
});

test('the view schema rejects a malformed view (the schema is load-bearing)', { skip }, () => {
  const projection = captureProjection();
  assert.throws(() => projection.wire.viewSchema.parse({ restricted: 'yes' }));
  assert.throws(() => projection.wire.viewSchema.parse({ modeBase: 'unknown' }));
  assert.throws(() => projection.wire.viewSchema.parse({}));
});

test('the en prompt locale produces schema-valid views too', { skip }, () => {
  const projection = captureProjection({ promptLocale: 'en' });
  for (const [label, state] of representativeStates(projection)) {
    const view = projection.wire.view(state);
    projection.wire.viewSchema.parse(view);
    if (state.restricted) {
      const text = projection.wire;
      void text;
    }
    assert.ok(view, label);
  }
});

/** Read a validated config value that may be a live volatile ref (`{get}`). */
function readValue(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function'
    ? value.get()
    : value;
}

test('the plugin Config schema resolves its defaults', { skip }, () => {
  const { Config } = loaded.module;
  assert.equal(typeof Config, 'function');
  const resolved = Config({});
  assert.equal(readValue(resolved.promptLocale), 'zh');
  const silence = readValue(resolved.silence);
  assert.equal(silence.enabled, true);
  assert.equal(silence.firstDelayMs, 90_000);
  assert.equal(silence.repeatMs, 180_000);
  const custom = Config({ promptLocale: 'en', silence: { enabled: false } });
  assert.equal(readValue(custom.promptLocale), 'en');
  assert.equal(readValue(custom.silence).enabled, false);
});

test('the Config exposes a settings form (volatile subtrees) without nested-volatile errors', { skip }, () => {
  const { Config } = loaded.module;
  // The Harness settings service only offers a form for schema subtrees with a
  // volatile field (`volatileForm(schema)` returns undefined otherwise), and a
  // config whose fields are all ordinary is excluded from `settings.describe()`
  // entirely — which is exactly why the plugins UI showed no configure control.
  const dict = Config.dict ?? {};
  assert.ok(dict.promptLocale, 'promptLocale field exists');
  assert.ok(dict.silence, 'silence field exists');
  assert.equal(dict.promptLocale.meta?.volatile, true, 'promptLocale is volatile');
  assert.equal(dict.silence.meta?.volatile, true, 'silence is volatile');
  // A volatile field may not sit inside another volatile field; validation of a
  // full config must succeed (a violation would throw here).
  const validated = Config({
    promptLocale: 'en',
    silence: { enabled: false, firstDelayMs: 5_000, repeatMs: 10_000 },
  });
  assert.equal(readValue(validated.promptLocale), 'en');
  const silence = readValue(validated.silence);
  assert.equal(silence.enabled, false);
  assert.equal(silence.firstDelayMs, 5_000);
  assert.equal(silence.repeatMs, 10_000);
});

test('a volatile config edit is re-read without remounting the plugin', { skip }, async () => {
  const { apply, Config } = loaded.module;
  const { ctx, captured } = createWiringContext();
  const config = Config({ promptLocale: 'zh', silence: { enabled: true, firstDelayMs: 90_000, repeatMs: 180_000 } });
  apply(ctx, config);
  const handler = captured.commands[0].handler;
  const agent = { id: 's1', session: { id: 's1' } };
  const call = () => handler({ agent, rawInput: 'off', attachments: [], commandId: 'c', signal: undefined });
  // zh first, then a live settings edit commits through the volatile ref (the
  // runtime does this with the shared write symbol) and emits the loader event;
  // the next command reply is English.
  assert.match(call().text, /时间窗已清空/);
  const write = Symbol.for('cosmokit.volatile.write');
  assert.equal(typeof config.promptLocale[write], 'function', 'config field is a live volatile ref');
  config.promptLocale[write]('en');
  const volatileListeners = captured.onEvents.filter((entry) => entry.event === 'loader/volatile-update');
  assert.equal(volatileListeners.length, 1, 'plugin listens for loader/volatile-update');
  volatileListeners[0].handler([]);
  assert.match(call().text, /Time window cleared/);
});

