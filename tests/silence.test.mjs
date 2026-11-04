// Unit tests for silence narration bookkeeping: `node --test tests/`.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FIRST_DELAY_MS,
  DEFAULT_REPEAT_MS,
  MAX_TRACKED_JOBS,
  createSilenceNarration,
  normalizeSilenceConfig,
} from '../lib/silence.js';

const T0 = Date.UTC(2026, 10, 3, 0, 0, 0);
const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** A deterministic clock the test advances explicitly. */
function makeClock(start = T0) {
  let current = start;
  return {
    now: () => current,
    set: (value) => {
      current = value;
    },
    advance: (delta) => {
      current += delta;
      return current;
    },
  };
}

/** A `JobView`-shaped projection for one event payload. */
function jobView(id, owner, overrides = {}) {
  return {
    id,
    kind: 'bash',
    label: `job ${id}`,
    owner,
    status: 'running',
    startedAt: T0,
    output: { total: 0, earliest: T0 },
    ...overrides,
  };
}

/** One event payload, defaulting to the registry's `{type, job}` shape. */
const event = (type, view) => ({ type, job: view });

/** Default narration instance on top of one clock. */
function setup(config, clock) {
  return createSilenceNarration({
    config,
    now: clock ? clock.now : () => T0,
  });
}

// ---------------------------------------------------------------------------
// Config normalization and formatting helpers
// ---------------------------------------------------------------------------

test('normalizeSilenceConfig: product defaults and malformed input', () => {
  assert.deepEqual(normalizeSilenceConfig(undefined), {
    enabled: true,
    firstDelayMs: 90_000,
    repeatMs: 180_000,
  });
  assert.deepEqual(normalizeSilenceConfig(null), {
    enabled: true,
    firstDelayMs: 90_000,
    repeatMs: 180_000,
  });
  assert.deepEqual(normalizeSilenceConfig({ enabled: false }), {
    enabled: false,
    firstDelayMs: 90_000,
    repeatMs: 180_000,
  });
  assert.deepEqual(normalizeSilenceConfig({ firstDelayMs: -1, repeatMs: 'soon' }), {
    enabled: true,
    firstDelayMs: 90_000,
    repeatMs: 180_000,
  });
  assert.deepEqual(normalizeSilenceConfig({ enabled: true, firstDelayMs: 0, repeatMs: 500 }), {
    enabled: true,
    firstDelayMs: 0,
    repeatMs: 500,
  });
  assert.equal(DEFAULT_FIRST_DELAY_MS, 90_000);
  assert.equal(DEFAULT_REPEAT_MS, 180_000);
});

// ---------------------------------------------------------------------------
// First report / refresh cadence
// ---------------------------------------------------------------------------

test('first report fires after 90s without output, not before', () => {
  const clock = makeClock();
  const narration = setup(undefined, clock);
  narration.onJobEvent(event('registered', jobView('job-1', 'session-1')));

  clock.set(T0 + 90 * SECOND - 1);
  assert.deepEqual(narration.factsFor('session-1'), []);

  clock.set(T0 + 90 * SECOND);
  assert.deepEqual(narration.factsFor('session-1'), [
    {
      jobId: 'job-1',
      label: 'job job-1',
      elapsedMs: 90 * SECOND,
      silentMs: 90 * SECOND,
      first: true,
    },
  ]);

  // Querying facts is side-effect free: still due until markNarrated runs.
  assert.equal(narration.factsFor('session-1').length, 1);
});

test('after markNarrated the next report waits for the 3 minute refresh', () => {
  const clock = makeClock();
  const narration = setup(undefined, clock);
  narration.onJobEvent(event('registered', jobView('job-1', 'session-1')));

  clock.set(T0 + 90 * SECOND);
  const facts = narration.factsFor('session-1');
  assert.equal(narration.markNarrated('session-1', facts), 1);

  clock.set(T0 + 90 * SECOND + 180 * SECOND - 1);
  assert.deepEqual(narration.factsFor('session-1'), []);

  clock.set(T0 + 90 * SECOND + 180 * SECOND);
  const refreshed = narration.factsFor('session-1');
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].first, false);
  assert.equal(refreshed[0].elapsedMs, 90 * SECOND + 180 * SECOND);
});

test('output events reset the silence clock', () => {
  const clock = makeClock();
  const narration = setup(undefined, clock);
  narration.onJobEvent(event('registered', jobView('job-1', 'session-1')));

  clock.set(T0 + 100 * SECOND);
  narration.onJobEvent(event('output', jobView('job-1', 'session-1')));

  clock.set(T0 + 100 * SECOND + 90 * SECOND - 1);
  assert.deepEqual(narration.factsFor('session-1'), []);
  clock.set(T0 + 100 * SECOND + 90 * SECOND);
  const facts = narration.factsFor('session-1');
  assert.equal(facts.length, 1);
  assert.equal(facts[0].silentMs, 90 * SECOND);
});

test('progress and registered count as output; stopping keeps the silent clock', () => {
  const clock = makeClock();
  const narration = setup(undefined, clock);
  narration.onJobEvent(event('registered', jobView('job-1', 'session-1')));

  clock.set(T0 + 60 * SECOND);
  narration.onJobEvent(event('progress', jobView('job-1', 'session-1', { progress: '50%' })));
  clock.set(T0 + 60 * SECOND + 90 * SECOND - 1);
  assert.deepEqual(narration.factsFor('session-1'), []);

  clock.set(T0 + 60 * SECOND + 90 * SECOND);
  assert.equal(narration.factsFor('session-1').length, 1);

  // `stopping` is still a live state that deserves narration.
  narration.onJobEvent(event('stopping', jobView('job-1', 'session-1', { status: 'stopping' })));
  assert.equal(narration.factsFor('session-1').length, 1);
  assert.equal(narration.snapshot().jobs[0].status, 'stopping');
});

test('real registry output payloads ({id, owner}) update the clock', () => {
  const clock = makeClock();
  const narration = setup(undefined, clock);
  narration.onJobEvent(event('registered', jobView('job-1', 'session-1')));

  clock.set(T0 + 30 * SECOND);
  // The real payload has no `job` view: `{type:'output', id, owner?, total}`.
  narration.onJobEvent({ type: 'output', id: 'job-1', owner: 'session-1', total: 42 });
  clock.set(T0 + 30 * SECOND + 90 * SECOND - 1);
  assert.deepEqual(narration.factsFor('session-1'), []);
  clock.set(T0 + 30 * SECOND + 90 * SECOND);
  assert.equal(narration.factsFor('session-1').length, 1);
});

// ---------------------------------------------------------------------------
// Terminal jobs and session scoping
// ---------------------------------------------------------------------------

test('a settled job never produces facts again', () => {
  const clock = makeClock();
  const narration = setup(undefined, clock);
  narration.onJobEvent(event('registered', jobView('job-1', 'session-1')));

  clock.set(T0 + 90 * SECOND);
  assert.equal(narration.factsFor('session-1').length, 1);

  clock.set(T0 + 95 * SECOND);
  narration.onJobEvent(
    event('settled', jobView('job-1', 'session-1', { status: 'completed', finishedAt: T0 + 95 * SECOND })),
  );
  clock.set(T0 + 200 * SECOND);
  assert.deepEqual(narration.factsFor('session-1'), []);
  assert.equal(narration.snapshot().jobs[0].status, 'completed');
});

test('the trailing output event after settled does not revive the job', () => {
  const clock = makeClock();
  const narration = setup(undefined, clock);
  narration.onJobEvent(event('registered', jobView('job-1', 'session-1')));
  clock.set(T0 + 10 * SECOND);
  narration.onJobEvent(
    event('settled', jobView('job-1', 'session-1', { status: 'failed' })),
  );
  // `settle()` announces `settled` then one more `output` for the ring.
  narration.onJobEvent({ type: 'output', id: 'job-1', owner: 'session-1', total: 10 });
  clock.set(T0 + 200 * SECOND);
  assert.deepEqual(narration.factsFor('session-1'), []);
});

test('removed jobs are dropped from facts', () => {
  const clock = makeClock();
  const narration = setup(undefined, clock);
  narration.onJobEvent(event('registered', jobView('job-1', 'session-1')));
  narration.onJobEvent(
    event('removed', jobView('job-1', 'session-1', { status: 'killed' })),
  );
  clock.set(T0 + 5 * MINUTE);
  assert.deepEqual(narration.factsFor('session-1'), []);
});

test('facts are isolated per owning session', () => {
  const clock = makeClock();
  const narration = setup(undefined, clock);
  narration.onJobEvent(event('registered', jobView('job-a', 'session-1')));
  narration.onJobEvent(event('registered', jobView('job-b', 'session-2')));
  narration.onJobEvent(event('registered', jobView('job-unowned', undefined)));

  clock.set(T0 + 90 * SECOND);
  assert.deepEqual(narration.factsFor('session-1').map((fact) => fact.jobId), ['job-a']);
  assert.deepEqual(narration.factsFor('session-2').map((fact) => fact.jobId), ['job-b']);
  assert.deepEqual(narration.factsFor('session-3'), []);
  assert.deepEqual(narration.factsFor(undefined), []);
});

test('markNarrated ignores facts for another session or a finished job', () => {
  const clock = makeClock();
  const narration = setup(undefined, clock);
  narration.onJobEvent(event('registered', jobView('job-1', 'session-1')));
  clock.set(T0 + 90 * SECOND);
  const facts = narration.factsFor('session-1');

  assert.equal(narration.markNarrated('session-2', facts), 0);
  narration.onJobEvent(event('settled', jobView('job-1', 'session-1', { status: 'completed' })));
  assert.equal(narration.markNarrated('session-1', facts), 0);
  assert.equal(narration.markNarrated('session-1', ['unknown-job']), 0);
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

test('disabled narration tracks nothing and returns no facts', () => {
  const clock = makeClock();
  const narration = setup({ enabled: false }, clock);
  narration.onJobEvent(event('registered', jobView('job-1', 'session-1')));
  clock.set(T0 + 10 * MINUTE);
  assert.deepEqual(narration.factsFor('session-1'), []);
  assert.deepEqual(narration.snapshot().jobs, []);
  assert.equal(narration.markNarrated('session-1', ['job-1']), 0);
});

test('custom thresholds are honored', () => {
  const clock = makeClock();
  const narration = setup({ firstDelayMs: 500, repeatMs: 1000 }, clock);
  narration.onJobEvent(event('registered', jobView('job-1', 'session-1')));

  clock.set(T0 + 499);
  assert.deepEqual(narration.factsFor('session-1'), []);
  clock.set(T0 + 500);
  const facts = narration.factsFor('session-1');
  assert.equal(facts.length, 1);
  narration.markNarrated('session-1', facts);
  clock.set(T0 + 1499);
  assert.deepEqual(narration.factsFor('session-1'), []);
  clock.set(T0 + 1500);
  assert.equal(narration.factsFor('session-1').length, 1);
});

// ---------------------------------------------------------------------------
// Memory bounds, lifecycle, and defensive behavior
// ---------------------------------------------------------------------------

test('ended records are pruned after the ~10 minute retention window', () => {
  const clock = makeClock();
  const narration = setup(undefined, clock);
  narration.onJobEvent(event('registered', jobView('job-1', 'session-1')));
  clock.set(T0 + 10 * SECOND);
  narration.onJobEvent(event('settled', jobView('job-1', 'session-1', { status: 'completed' })));

  clock.set(T0 + 10 * SECOND + 10 * MINUTE);
  assert.equal(narration.snapshot().jobs.length, 1, 'retention is inclusive at the boundary');
  clock.set(T0 + 10 * SECOND + 10 * MINUTE + 1);
  narration.factsFor('session-1'); // any query prunes
  assert.deepEqual(narration.snapshot().jobs, []);
});

test('tracked jobs are hard-capped to bound memory', () => {
  const clock = makeClock();
  const narration = setup(undefined, clock);
  const count = MAX_TRACKED_JOBS + 50;
  for (let index = 0; index < count; index += 1) {
    narration.onJobEvent(event('registered', jobView(`job-${index}`, 'session-1')));
  }
  assert.equal(narration.snapshot().jobs.length, MAX_TRACKED_JOBS);
});

test('snapshot is a defensive copy', () => {
  const clock = makeClock();
  const narration = setup(undefined, clock);
  narration.onJobEvent(event('registered', jobView('job-1', 'session-1')));
  const first = narration.snapshot();
  assert.deepEqual(Object.keys(first.jobs[0]).sort(), [
    'firstReportedAt',
    'id',
    'label',
    'lastNarratedAt',
    'lastOutputAt',
    'owner',
    'startedAt',
    'status',
  ]);
  first.jobs[0].label = 'mutated';
  first.jobs.push({ id: 'fake' });
  assert.notEqual(narration.snapshot().jobs[0].label, 'mutated');
  assert.equal(narration.snapshot().jobs.length, 1);
});

test('dispose clears state and makes the instance inert', () => {
  const clock = makeClock();
  const narration = setup(undefined, clock);
  narration.onJobEvent(event('registered', jobView('job-1', 'session-1')));
  narration.dispose();
  assert.deepEqual(narration.snapshot().jobs, []);
  narration.onJobEvent(event('registered', jobView('job-2', 'session-1')));
  assert.deepEqual(narration.factsFor('session-1'), []);
  assert.deepEqual(narration.snapshot().jobs, []);
});

test('malformed and unknown events are ignored', () => {
  const clock = makeClock();
  const narration = setup(undefined, clock);
  for (const payload of [
    undefined,
    null,
    'registered',
    {},
    { type: 'registered' },
    { type: 'registered', job: null },
    { type: 'registered', job: { owner: 'session-1' } }, // no id
    { type: 'weird', job: jobView('job-x', 'session-1') },
    { type: 'output' }, // no id
  ]) {
    assert.doesNotThrow(() => narration.onJobEvent(payload));
  }
  clock.set(T0 + 10 * MINUTE);
  assert.deepEqual(narration.factsFor('session-1'), []);
  assert.deepEqual(narration.snapshot().jobs, []);
});

test('a job first seen through an output event is still narrated', () => {
  const clock = makeClock();
  const narration = setup(undefined, clock);
  // Simulates a subscriber that attached after the job registered.
  narration.onJobEvent({ type: 'output', id: 'job-late', owner: 'session-1', total: 5 });
  clock.set(T0 + 90 * SECOND);
  const facts = narration.factsFor('session-1');
  assert.equal(facts.length, 1);
  assert.equal(facts[0].jobId, 'job-late');
  assert.equal(facts[0].elapsedMs, 90 * SECOND);
});
