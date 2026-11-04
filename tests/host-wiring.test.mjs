// Host wiring test: activates `lib/index.js` against stubbed Cordis services and
// (when the Harness packages are resolvable) the real `@deepseek-ai/*` modules.
//
// `npm test` runs it in a plain checkout, where the Harness packages are not
// resolvable: every case is reported as skipped, not failed. To exercise the
// real modules, run it from a sandbox whose `node_modules` links the installed
// Harness packages (see the Development section of README.md), e.g.
//   node --test tests/host-wiring.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

const loaded = await import('./lib/index.js')
  .then((module) => ({ ok: true, module }))
  .catch((error) => ({ ok: false, error }));
const skip = loaded.ok ? false : `Harness packages not resolvable here (${loaded.error?.code ?? 'import failed'})`;

function createContext() {
  const captured = {
    effectLabels: [],
    onEvents: [],
    projection: null,
    commands: [],
    tools: [],
    jobFilters: [],
    injects: [],
  };
  const context = {
    logger: { warn: () => {} },
    effect: (callback, label) => {
      captured.effectLabels.push(label);
      const disposer = callback();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    on: (event, handler, options) => {
      captured.onEvents.push({ event, handler, options });
      return () => {};
    },
    inject: (services, callback) => {
      captured.injects.push(services.join(','));
      const child = {
        ...context,
        commands: { register: (definition) => captured.commands.push(definition) },
        tools: { register: (definition) => captured.tools.push(definition) },
        jobs: {
          events: {
            subscribe: (filter, listener) => {
              captured.jobFilters.push({ filter, listener });
              return () => {};
            },
          },
        },
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
  return { ctx: context, captured };
}

test('the Host half activates and wires every extension point', { skip }, () => {
  const { apply, Config, inject, name } = loaded.module;
  const { ctx, captured } = createContext();
  apply(ctx, {});
  assert.equal(name, 'dsh-time-pin');
  assert.deepEqual(inject, ['sessionProjections']);
  assert.ok(Config);

  assert.ok(captured.projection);
  assert.equal(captured.projection.key, 'timePin');
  assert.equal(captured.projection.stateVersion, 2);
  assert.equal(typeof captured.projection.init, 'function');
  assert.equal(typeof captured.projection.apply, 'function');
  assert.equal(typeof captured.projection.wire.view, 'function');
  assert.equal(typeof captured.projection.wire.viewSchema, 'object');

  assert.equal(captured.commands.length, 1);
  assert.equal(captured.commands[0].name, 'pin');
  assert.equal(typeof captured.commands[0].handler, 'function');

  assert.equal(captured.tools.length, 1);
  assert.equal(captured.tools[0].name, 'time_pin_status');
  assert.equal(typeof captured.tools[0].execute, 'function');

  const preStep = captured.onEvents.find((entry) => entry.event === 'agent/pre-step');
  assert.ok(preStep);
  assert.deepEqual(preStep.options, { prepend: true });
  assert.ok(captured.onEvents.find((entry) => entry.event === 'tools/post-execute'));

  assert.equal(captured.jobFilters.length, 1);
  assert.deepEqual(captured.jobFilters[0].filter, { owners: 'all' });
  assert.equal(typeof captured.jobFilters[0].listener, 'function');
});

test('the projection folds a /pin turn into an injectable window', { skip }, () => {
  const { apply } = loaded.module;
  const { ctx, captured } = createContext();
  apply(ctx, {});
  const projection = captured.projection;
  let state = projection.init({}, 0);
  const run = (args, id, time) => ({
    type: 'command/run',
    time,
    data: { name: 'pin', commandId: id, args },
  });
  const done = (id, time, kind = 'success') => ({
    type: 'command/done',
    time,
    data: { commandId: id, kind },
  });
  state = projection.apply(state, run('2000-01-01 10年', 'c1', 100));
  state = projection.apply(state, done('c1', 101));
  assert.equal(state.restricted, true);
  assert.equal(state.asOf, 'ce:2000-01-01');
  assert.equal(state.span, '10y');
  state = projection.apply(state, { type: 'request/header', time: 102, data: {} });
  state = projection.apply(state, {
    type: 'assistant/message',
    time: 103,
    data: { message: { content: [{ type: 'text', text: '时间窗：2000-01-01 · 前10年\n回答。' }] } },
  });
  assert.equal(state.anchorPending, false);
  const view = projection.wire.view(state);
  assert.equal(view.chipLabel, '2000-01-01 · 前10年');
  assert.equal(view.modeBase, 'pinned');
  assert.equal(typeof view.asOfDay, 'number');
});

test('the command handler validates and reports', { skip }, () => {
  const { apply } = loaded.module;
  const { ctx, captured } = createContext();
  apply(ctx, {});
  const handler = captured.commands[0].handler;
  const agent = { id: 'session-1', session: { id: 'session-1' } };
  const call = (rawInput) => handler({ agent, rawInput, attachments: [], commandId: 'c', signal: undefined });
  assert.equal(call('2000-01-01 10年').kind, 'success');
  assert.match(call('2000-01-01 10年').text, /时间窗已更新/);
  assert.match(call('off').text, /清空/);
  assert.match(call('7天').text, /默认/);
  assert.equal(call('2026-02-30').kind, 'error');
  assert.match(call('').text, /默认模式/);
});

test('the status tool reports default mode without a window', { skip }, async () => {
  const { apply } = loaded.module;
  const { ctx, captured } = createContext();
  apply(ctx, {});
  const tool = captured.tools[0];
  const value = await tool.execute({}, { agent: { session: { id: 's1' } } });
  assert.equal(value.restricted, false);
  assert.equal(value.mode, 'default');
  assert.match(value.nowIso, /^\d{4}-\d{2}-\d{2}T/);
});

test('pre-step appends one window message and then stays silent', { skip }, async () => {
  const { apply } = loaded.module;
  const { ctx, captured } = createContext();
  apply(ctx, {});
  const projection = captured.projection;
  const session = { id: 's1' };
  let state = projection.init({}, 0);
  state = projection.apply(state, {
    type: 'command/run',
    time: 100,
    data: { name: 'pin', commandId: 'c1', args: '2000-01-01 10年' },
  });
  state = projection.apply(state, {
    type: 'command/done',
    time: 101,
    data: { commandId: 'c1', kind: 'success' },
  });
  ctx.sessionProjections.stateOf = (target, key) =>
    target === session && key === 'timePin' ? state : undefined;
  const preStep = captured.onEvents.find((entry) => entry.event === 'agent/pre-step').handler;
  const payload = { agent: { id: 's1', session }, signal: { aborted: false }, step: 1, turn: 1 };
  const next = async () => ({ kind: 'enter', messages: [] });
  const decision = await preStep(payload, next);
  assert.equal(decision.messages.length, 1);
  assert.match(decision.messages[0].content[0].text, /\[TIME PIN\]/);
  assert.equal(decision.messages[0].source.kind, 'time-pin');
  state = projection.apply(state, { type: 'request/header', time: 102, data: {} });
  assert.deepEqual((await preStep(payload, next)).messages, []);
});
