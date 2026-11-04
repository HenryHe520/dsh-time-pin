/**
 * Deterministic silence narration for dsh-time-pin.
 *
 * The Host subscribes to `ctx.jobs.events` and feeds every payload into
 * {@link createSilenceNarration}'s `onJobEvent`. This module owns only the
 * rolling per-job bookkeeping — never a timer. At an `agent/pre-step` hook the
 * Host asks `factsFor(sessionId)` for the jobs owned by that session that have
 * been silent long enough, injects a deterministic `[TIME FACT]` line for each,
 * then calls `markNarrated` so the same job is not narrated again until the
 * refresh interval elapses.
 *
 * Timing contract (matching the product spec):
 * - first report once a live job has had no output for `firstDelayMs`
 *   (default 90 s, measured from registration or the last output);
 * - refresh every `repeatMs` (default 3 min) while it stays silent;
 * - terminal jobs (`settled` / `removed`) never produce facts again;
 * - state is bounded: ended records are dropped after ~10 minutes and the
 *   table is capped, so a long-lived Host cannot leak memory.
 *
 * The real `@deepseek-ai/dsh-jobs-local` payloads are:
 *   `{type:'registered'|'progress'|'stopping'|'settled'|'removed', job: JobView}`
 *   `{type:'output', id, owner?, total}`  ← no `job` view
 * where `JobView` is `{id, kind, label, owner?, status, startedAt, ...}` and
 * `status` is `'running'|'stopping'|'completed'|'killed'|'failed'`. The parser
 * below accepts both the real `{id, owner}` output payload and a same-shaped
 * `{id, job}` payload so it stays host-independent and unit-testable.
 *
 * No wall-clock read happens here except through the injected `now` function.
 *
 * @module dsh-time-pin/silence
 */

/** Default first-report threshold: 90 seconds without output. */
export const DEFAULT_FIRST_DELAY_MS = 90_000;

/** Default refresh interval between reports: 3 minutes. */
export const DEFAULT_REPEAT_MS = 180_000;

/** How long a terminal job's record is retained before pruning. */
export const ENDED_RETENTION_MS = 10 * 60_000;

/** Hard cap on tracked job records (defensive bound for a long-lived Host). */
export const MAX_TRACKED_JOBS = 256;

/** Job statuses that still produce silence facts. */
const LIVE_STATUSES = new Set(['running', 'stopping']);

/** Event types that count as fresh output for the silence clock. */
const OUTPUT_EVENTS = new Set(['registered', 'progress']);

/** Event types that end a job. */
const TERMINAL_EVENTS = new Set(['settled', 'removed']);

/**
 * Coerce one config value to a non-negative finite number.
 *
 * @param {unknown} value - raw config value.
 * @param {number} fallback - value used when the input is unusable.
 * @returns {number} normalized number.
 */
function nonNegativeNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

/**
 * Normalize the silence settings. Missing / malformed fields fall back to the
 * product defaults; silence narration is ON unless explicitly disabled.
 *
 * @param {{enabled?: boolean, firstDelayMs?: number, repeatMs?: number} | null | undefined} config
 *   raw settings (the Host's `silence.*` config section).
 * @returns {{enabled: boolean, firstDelayMs: number, repeatMs: number}} normalized settings.
 */
export function normalizeSilenceConfig(config) {
  const source = config !== null && typeof config === 'object' ? config : {};
  return {
    enabled: source.enabled !== false,
    firstDelayMs: nonNegativeNumber(source.firstDelayMs, DEFAULT_FIRST_DELAY_MS),
    repeatMs: nonNegativeNumber(source.repeatMs, DEFAULT_REPEAT_MS),
  };
}

/**
 * Per-job silence bookkeeping.
 * @typedef {object} SilenceJobRecord
 * @property {string} id - job id.
 * @property {string} label - human label from `JobView.label`.
 * @property {string | null} owner - owning session id, or `null` for unowned.
 * @property {number} startedAt - job start instant (ms).
 * @property {number} lastOutputAt - last output/registration instant (ms).
 * @property {string} status - last observed job status.
 * @property {number | null} firstReportedAt - first narration instant (ms).
 * @property {number | null} lastNarratedAt - last narration instant (ms).
 * @property {number | null} endedAt - terminal instant (ms), internal only.
 */

/**
 * Fact due for narration.
 * @typedef {object} SilenceFact
 * @property {string} jobId - job id.
 * @property {string} label - human label.
 * @property {number} elapsedMs - running time since the job started.
 * @property {number} silentMs - time since the last output.
 * @property {boolean} first - whether this is the first narration for the job.
 */

/**
 * Create the silence-narration bookkeeper.
 *
 * @param {object} [options] - factory options.
 * @param {{enabled?: boolean, firstDelayMs?: number, repeatMs?: number} | null} [options.config]
 *   silence settings (defaults: enabled, 90 s, 3 min).
 * @param {() => number} [options.now] - injected clock in milliseconds; every
 *   timestamp read goes through it so tests are deterministic.
 * @returns {{
 *   onJobEvent: (event: object) => void,
 *   factsFor: (sessionId: string) => SilenceFact[],
 *   markNarrated: (sessionId: string, facts: SilenceFact[]) => number,
 *   snapshot: () => {enabled: boolean, firstDelayMs: number, repeatMs: number, jobs: SilenceJobRecord[]},
 *   dispose: () => void,
 * }} the narration bookkeeper. It owns no timers.
 */
export function createSilenceNarration({ config, now = () => Date.now() } = {}) {
  const settings = normalizeSilenceConfig(config);
  /** @type {Map<string, SilenceJobRecord>} */
  const jobs = new Map();
  let disposed = false;

  /** Read the injected clock, falling back safely when the provider is unusable. */
  const readNow = () => {
    const value = typeof now === 'function' ? now() : Number.NaN;
    return Number.isFinite(value) ? value : Date.now();
  };

  /**
   * Create one record from an optional `JobView`.
   *
   * @param {string} id - job id.
   * @param {object | null} view - `JobView` when the payload carried one.
   * @param {number} at - current instant.
   * @returns {SilenceJobRecord} new record.
   */
  function makeRecord(id, view, at) {
    const startedAt =
      typeof view?.startedAt === 'number' && Number.isFinite(view.startedAt)
        ? view.startedAt
        : at;
    const owner = typeof view?.owner === 'string' ? view.owner : null;
    const label =
      typeof view?.label === 'string' && view.label !== '' ? view.label : id;
    const status = typeof view?.status === 'string' ? view.status : 'running';
    return {
      id,
      label,
      owner,
      startedAt,
      lastOutputAt: startedAt,
      status,
      firstReportedAt: null,
      lastNarratedAt: null,
      endedAt: null,
    };
  }

  /**
   * Fold the mutable fields of a `JobView` into one record.
   *
   * @param {SilenceJobRecord} record - record to update.
   * @param {object | null} view - `JobView` when present.
   * @returns {void}
   */
  function applyView(record, view) {
    if (view === null || typeof view !== 'object') return;
    if (typeof view.label === 'string' && view.label !== '') record.label = view.label;
    if (typeof view.owner === 'string') record.owner = view.owner;
    else if (view.owner === null) record.owner = null;
    if (typeof view.status === 'string') record.status = view.status;
    if (typeof view.startedAt === 'number' && Number.isFinite(view.startedAt)) {
      record.startedAt = view.startedAt;
    }
  }

  /**
   * Drop ended records past retention, then enforce the hard cap.
   *
   * @param {number} at - current instant.
   * @returns {void}
   */
  function prune(at) {
    for (const [id, record] of jobs) {
      if (record.endedAt !== null && at - record.endedAt > ENDED_RETENTION_MS) {
        jobs.delete(id);
      }
    }
    if (jobs.size <= MAX_TRACKED_JOBS) return;
    let overflow = jobs.size - MAX_TRACKED_JOBS;
    for (const [id, record] of jobs) {
      if (overflow <= 0) break;
      if (record.endedAt !== null) {
        jobs.delete(id);
        overflow -= 1;
      }
    }
    for (const id of jobs.keys()) {
      if (overflow <= 0) break;
      jobs.delete(id);
      overflow -= 1;
    }
  }

  /**
   * Fold one `ctx.jobs.events` payload into the bookkeeping. Unknown/malformed
   * payloads and anything arriving after `dispose()` are ignored.
   *
   * @param {{type?: string, job?: object, id?: string, owner?: string}} event
   *   one job event payload.
   * @returns {void}
   */
  function onJobEvent(event) {
    if (disposed || !settings.enabled) return;
    if (event === null || typeof event !== 'object') return;
    const type = typeof event.type === 'string' ? event.type : '';
    if (type === '') return;
    const view =
      event.job !== null && typeof event.job === 'object' ? event.job : null;
    const rawId = view?.id ?? event.id;
    if (typeof rawId !== 'string' || rawId === '') return;
    const at = readNow();
    const existing = jobs.get(rawId);

    if (TERMINAL_EVENTS.has(type)) {
      const record = existing ?? makeRecord(rawId, view, at);
      applyView(record, view);
      record.endedAt = at;
      if (record.status === 'running' || record.status === 'stopping') {
        record.status = 'completed';
      }
      jobs.set(rawId, record);
      prune(at);
      return;
    }

    if (type === 'output') {
      if (existing !== undefined) {
        // The registry announces `settled` and then one trailing `output`; that
        // late output must not revive a finished job.
        if (existing.endedAt !== null) return;
        applyView(existing, view);
        existing.lastOutputAt = at;
        return;
      }
      // The Host subscribed after this job registered; track it from first sight.
      const owner = typeof event.owner === 'string' ? event.owner : null;
      const record = makeRecord(
        rawId,
        { label: rawId, owner, status: 'running', startedAt: at },
        at,
      );
      record.lastOutputAt = at;
      jobs.set(rawId, record);
      prune(at);
      return;
    }

    if (type === 'registered' || type === 'progress' || type === 'stopping') {
      const record = existing ?? makeRecord(rawId, view, at);
      if (record.endedAt !== null) return;
      applyView(record, view);
      if (OUTPUT_EVENTS.has(type)) record.lastOutputAt = at;
      jobs.set(rawId, record);
      prune(at);
      return;
    }
  }

  /**
   * Facts due for narration right now for one session, in registration order.
   * A job is due when it is owned by the session, still live, silent for at
   * least `firstDelayMs`, and either never narrated or last narrated at least
   * `repeatMs` ago. `factsFor` never mutates narration state; call
   * {@link markNarrated} once the facts have actually been injected.
   *
   * @param {string | null | undefined} sessionId - owning session id.
   * @returns {SilenceFact[]} due facts (`[]` when disabled/disposed).
   */
  function factsFor(sessionId) {
    if (disposed || !settings.enabled) return [];
    if (typeof sessionId !== 'string' || sessionId === '') return [];
    const at = readNow();
    prune(at);
    /** @type {SilenceFact[]} */
    const facts = [];
    for (const record of jobs.values()) {
      if (record.owner !== sessionId) continue;
      if (record.endedAt !== null) continue;
      if (!LIVE_STATUSES.has(record.status)) continue;
      const silentMs = at - record.lastOutputAt;
      if (silentMs < settings.firstDelayMs) continue;
      if (
        record.lastNarratedAt !== null &&
        at - record.lastNarratedAt < settings.repeatMs
      ) {
        continue;
      }
      facts.push({
        jobId: record.id,
        label: record.label,
        elapsedMs: Math.max(0, at - record.startedAt),
        silentMs: Math.max(0, silentMs),
        first: record.lastNarratedAt === null,
      });
    }
    return facts;
  }

  /**
   * Record that the given facts were narrated now: the next report for each
   * live job is not due until `repeatMs` has elapsed. Facts are only marked
   * when they still belong to `sessionId` and the job is still live, so a
   * stale array cannot move another session's clock.
   *
   * @param {string} sessionId - owning session id.
   * @param {Array<{jobId?: string} | string>} facts - facts previously returned
   *   by {@link factsFor} (bare job-id strings are accepted too).
   * @returns {number} how many records were marked.
   */
  function markNarrated(sessionId, facts) {
    if (disposed || !settings.enabled) return 0;
    if (!Array.isArray(facts) || facts.length === 0) return 0;
    const at = readNow();
    let marked = 0;
    for (const fact of facts) {
      const id =
        typeof fact === 'string'
          ? fact
          : fact !== null && typeof fact === 'object' && typeof fact.jobId === 'string'
            ? fact.jobId
            : '';
      if (id === '') continue;
      const record = jobs.get(id);
      if (record === undefined) continue;
      if (record.owner !== sessionId) continue;
      if (record.endedAt !== null) continue;
      record.lastNarratedAt = at;
      if (record.firstReportedAt === null) record.firstReportedAt = at;
      marked += 1;
    }
    return marked;
  }

  /**
   * Diagnostic copy of the narration state (settings plus one entry per tracked
   * job). Safe to log/serialize — it never exposes internal mutable records.
   *
   * @returns {{enabled: boolean, firstDelayMs: number, repeatMs: number, jobs: SilenceJobRecord[]}} the snapshot.
   */
  function snapshot() {
    return {
      enabled: settings.enabled,
      firstDelayMs: settings.firstDelayMs,
      repeatMs: settings.repeatMs,
      jobs: [...jobs.values()].map((record) => ({
        id: record.id,
        label: record.label,
        owner: record.owner,
        startedAt: record.startedAt,
        lastOutputAt: record.lastOutputAt,
        status: record.status,
        firstReportedAt: record.firstReportedAt,
        lastNarratedAt: record.lastNarratedAt,
      })),
    };
  }

  /** Drop every tracked job; the instance becomes inert. */
  function dispose() {
    disposed = true;
    jobs.clear();
  }

  return { onJobEvent, factsFor, markNarrated, snapshot, dispose };
}
