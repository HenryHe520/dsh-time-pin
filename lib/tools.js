/**
 * Read-only `time_pin_status` tool for dsh-time-pin.
 *
 * The model can call this to inspect which evidence window the current
 * conversation is under: whether the session is in restricted mode, which mode
 * (`default` / `past` / `future` / `recent`), the as-of and span labels, the
 * inclusive window bounds, the timezone, the current time, and whether the
 * future-view and anchor-echo states are active. It never mutates state — the
 * only mutation path is the human `/pin` command.
 *
 * The output contract is a flat JSON object of strings and booleans (see
 * {@link STATUS_OUTPUT_SCHEMA}) so the tool stays locale-neutral: the Host
 * supplies the labels (already localized according to `promptLocale`).
 *
 * `defineTool` is the only runtime import this module needs; it is a peer
 * dependency supplied by the Harness. Pure helpers (`normalizeStatusState`,
 * `formatStatusSummary`, `statusContentBlocks`) are exported separately so the
 * formatting logic can be reused and tested without a Harness.
 *
 * @module dsh-time-pin/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

/**
 * The canonical state keys the tool reports, in display order.
 * The Host's `getState(agent)` supplies them.
 */
export const STATUS_STATE_KEYS = Object.freeze([
  'restricted',
  'mode',
  'asOfLabel',
  'rangeLabel',
  'windowLowerLabel',
  'windowUpperLabel',
  'timezone',
  'nowIso',
  'future',
  'anchorPending',
]);

/** Fallback labels used when the Host leaves a string field empty. */
const LABEL_FALLBACKS = Object.freeze({
  mode: 'default',
  asOfLabel: 'default',
  rangeLabel: 'unlimited',
  windowLowerLabel: 'unbounded',
  windowUpperLabel: 'unknown',
  timezone: 'local',
  nowIso: 'unknown',
});

/**
 * Coerce one state value to a non-empty display string.
 *
 * @param {unknown} value - raw value from the Host.
 * @param {string} fallback - value used for `undefined`, `null`, or `''`.
 * @returns {string} display string.
 */
function toDisplayString(value, fallback) {
  if (typeof value === 'string') return value === '' ? fallback : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return fallback;
}

/**
 * Normalize whatever the Host's `getState(agent)` returned into the tool's
 * output shape. Every missing field gets a safe label; booleans are strict
 * (`true` only). A non-object return is a programming error and throws so the
 * model gets an actionable tool error instead of a half-empty report.
 *
 * @param {unknown} raw - value returned by `getState(agent)`.
 * @returns {{restricted: boolean, mode: string, asOfLabel: string, rangeLabel: string, windowLowerLabel: string, windowUpperLabel: string, timezone: string, nowIso: string, future: boolean, anchorPending: boolean}}
 *   normalized status state (exactly the {@link STATUS_STATE_KEYS} fields).
 * @throws {TypeError} when `raw` is not an object.
 */
export function normalizeStatusState(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError(
      'time_pin_status requires getState(agent) to return a status object',
    );
  }
  return {
    restricted: raw.restricted === true,
    mode: toDisplayString(raw.mode, LABEL_FALLBACKS.mode),
    asOfLabel: toDisplayString(raw.asOfLabel, LABEL_FALLBACKS.asOfLabel),
    rangeLabel: toDisplayString(raw.rangeLabel, LABEL_FALLBACKS.rangeLabel),
    windowLowerLabel: toDisplayString(
      raw.windowLowerLabel,
      LABEL_FALLBACKS.windowLowerLabel,
    ),
    windowUpperLabel: toDisplayString(
      raw.windowUpperLabel,
      LABEL_FALLBACKS.windowUpperLabel,
    ),
    timezone: toDisplayString(raw.timezone, LABEL_FALLBACKS.timezone),
    nowIso: toDisplayString(raw.nowIso, LABEL_FALLBACKS.nowIso),
    future: raw.future === true,
    anchorPending: raw.anchorPending === true,
  };
}

/**
 * One-line, model-facing summary of the current time-pin state.
 *
 * @param {unknown} state - raw or already-normalized status state.
 * @returns {string} one-line summary.
 */
export function formatStatusSummary(state) {
  const normalized = normalizeStatusState(state);
  const flags = [normalized.restricted ? 'restricted' : 'unrestricted'];
  if (normalized.future) flags.push('future view');
  if (normalized.anchorPending) flags.push('anchor echo pending');
  return [
    `Time Anchor · ${flags.join(', ')}`,
    `mode=${normalized.mode}`,
    `window [${normalized.windowLowerLabel}, ${normalized.windowUpperLabel}]`,
    `as_of ${normalized.asOfLabel}`,
    `range ${normalized.rangeLabel}`,
    `now ${normalized.nowIso} (${normalized.timezone})`,
  ].join(' · ');
}

/**
 * The rendered content blocks for a status state. This is the shape
 * `output.render` must return (a `ContentBlock[]`), and the one-line summary
 * the task contract calls for.
 *
 * @param {unknown} state - raw or already-normalized status state.
 * @returns {Array<{type: 'text', text: string}>} one text block.
 */
export function statusContentBlocks(state) {
  return [{ type: 'text', text: formatStatusSummary(state) }];
}

/**
 * The `defineTool` output schema: a flat object whose ten fields mirror
 * {@link STATUS_STATE_KEYS}. All labels are strings; all flags are booleans.
 */
const STATUS_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    restricted: {
      type: 'boolean',
      required: true,
      description: 'Whether the session is in restricted (evidence-filtering) mode.',
    },
    mode: {
      type: 'string',
      required: true,
      description: "Window mode: 'default', 'past', 'future', or 'recent'.",
    },
    asOfLabel: {
      type: 'string',
      required: true,
      description: 'Human label for the effective as-of time point.',
    },
    rangeLabel: {
      type: 'string',
      required: true,
      description: 'Human label for the retrieval range around as_of (before/after), e.g. ±10 years or last 10 years / next 5 years.',
    },
    windowLowerLabel: {
      type: 'string',
      required: true,
      description: 'Human label for the inclusive lower window bound.',
    },
    windowUpperLabel: {
      type: 'string',
      required: true,
      description: 'Human label for the inclusive upper window bound (the as-of date).',
    },
    timezone: {
      type: 'string',
      required: true,
      description: 'Local timezone in which the window is interpreted.',
    },
    nowIso: {
      type: 'string',
      required: true,
      description: 'Current local time in ISO 8601 form.',
    },
    future: {
      type: 'boolean',
      required: true,
      description: 'Whether the as-of point lies in the future (future-view mode).',
    },
    anchorPending: {
      type: 'boolean',
      required: true,
      description: 'Whether the model still owes the window anchor-echo confirmation line.',
    },
  },
};

/**
 * Build the read-only `time_pin_status` tool definition.
 *
 * Register it as `ctx.tools.register(createStatusTool({ getState }))`.
 *
 * @param {object} options - factory options.
 * @param {(agent: unknown) => object | Promise<object>} options.getState
 *   resolves the calling agent's status state; called as
 *   `getState(exec.agent)`. It may be async. It must return the
 *   {@link STATUS_STATE_KEYS} object (labels already localized by the Host) or
 *   throw when no state is available for the session.
 * @returns {object} a registry-ready `ToolDefinition` named `time_pin_status`.
 * @throws {TypeError} when `getState` is not a function.
 */
export function createStatusTool({ getState } = {}) {
  if (typeof getState !== 'function') {
    throw new TypeError('createStatusTool requires getState(agent)');
  }

  return defineTool({
    name: 'time_pin_status',
    description:
      'Read-only self-inspection of the current Time Anchor evidence window. Returns the session mode (default/past/future/recent), whether evidence filtering is active, the as-of point, the retrieval range (how far before and after as_of evidence may come from), the inclusive window bounds, the timezone and current time, plus the future-view and anchor-echo flags. Use it when you need to know which time window this conversation is under; it changes nothing — only the human /pin command can change the window.',
    parameters: {},
    // Read-only inspection: safe to run alongside other tool calls.
    isConcurrencySafe: () => true,
    output: {
      schema: STATUS_OUTPUT_SCHEMA,
      render: (_args, value) => statusContentBlocks(value),
    },
    async execute(_args, exec) {
      const raw = await getState(exec?.agent);
      return normalizeStatusState(raw);
    },
    // Host-local presentation descriptor (the Web Client derives its own card
    // from the tool result, so this is only for CLI/TUI consumers). A
    // ToolResultView wraps the same one-line summary text block.
    presentResult: (_args, result) => {
      if (result?.isError === true) return undefined;
      const content = Array.isArray(result?.content) ? result.content : [];
      return content.length > 0
        ? { card: 'generic', title: 'Time Anchor status', content }
        : { card: 'generic', title: 'Time Anchor status' };
    },
  });
}
