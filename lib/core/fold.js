/**
 * Pure projection state machine and step-planner for dsh-time-pin.
 *
 * Kept free of Harness imports so it can be exercised in plain Node: the Host
 * entry only adapts Cordis services to these functions. All functions are pure
 * except {@link createViewCache}, which memoizes by state reference exactly as
 * the projection `wire.view` contract requires.
 *
 * @module dsh-time-pin/core/fold
 */

import {
  asOfFromKey,
  asOfKey,
  formatAsOfDate,
  formatRangeZh,
  isRestricted,
  parsePinArgs,
  spanFromKey,
  spanKey,
  toDayNumber,
  today,
} from './window.js';
import {
  anchorReminder,
  hasAnchorEcho,
  statusSummary,
  windowBlock,
} from './text.js';

/** Projection key (also the Client `useProjection` key). */
export const PROJECTION_KEY = 'timePin';
/** Bump when the fold semantics or fields change. */
export const STATE_VERSION = 3;
/** Source attribution kind for every message this plugin appends. */
export const SOURCE_KIND = 'time-pin';
/** Unit label used by the Client-facing view. */
const UNIT_LABEL_ZH = { day: '天', month: '个月', year: '年' };

/** Fresh projection state (default mode). */
export function initialState() {
  return {
    restricted: false,
    asOf: null,
    before: null,
    after: null,
    injectedSig: null,
    anchorPending: false,
    lastOutputAt: null,
    runStartedAt: null,
    updatedAt: null,
    running: null,
  };
}

/** Resolve a window object (`{asOf, before, after}`) from projection state, or null. */
export function windowFromState(state) {
  if (state == null || state.restricted !== true) return null;
  const asOf = state.asOf == null ? null : asOfFromKey(state.asOf);
  const before = state.before == null ? null : spanFromKey(state.before);
  const after = state.after == null ? null : spanFromKey(state.after);
  if (state.asOf != null && asOf == null) return null;
  if (state.before != null && before == null) return null;
  if (state.after != null && after == null) return null;
  if (asOf == null && before == null && after == null) return null;
  return { asOf, before, after };
}

/** Encode a window into projection fields (`null` window = default mode). */
export function windowFields(window) {
  if (window == null || (window.asOf == null && window.before == null && window.after == null)) {
    return { restricted: false, asOf: null, before: null, after: null };
  }
  return {
    restricted: true,
    asOf: window.asOf == null ? null : asOfKey(window.asOf),
    before: window.before == null ? null : spanKey(window.before),
    after: window.after == null ? null : spanKey(window.after),
  };
}

/**
 * Stable signature of the stored window. This is the dedupe key: identical
 * windows yield identical injection text, and the projection remembers the
 * signature the model was last told about.
 */
export function stateSignature(state, nowMs = Date.now()) {
  if (state?.restricted !== true) return 'default';
  const asOf = state.asOf ?? `today:${asOfKey(today(nowMs))}`;
  return `${asOf}|${state.before ?? ''}|${state.after ?? ''}`;
}

/** Concatenate the text blocks of an assistant message. */
export function assistantText(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
  }
  return text;
}

/**
 * Apply one `/pin` argument string to the current projection state.
 * Returns the next `{restricted, asOf, before, after}` fields, or `null` for
 * "no change" (status query or unparseable input; the command already replied).
 */
export function nextWindowFields(args, state) {
  const parsed = parsePinArgs(args);
  if (parsed.kind === 'status' || parsed.kind === 'invalid') return null;
  if (parsed.kind === 'off') return windowFields(null);
  if (parsed.kind === 'asOf') {
    const kept = windowFromState(state);
    return windowFields({
      asOf: parsed.asOf,
      before: kept?.before ?? null,
      after: kept?.after ?? null,
    });
  }
  if (parsed.kind === 'ranges') {
    return windowFields({ asOf: null, before: parsed.before, after: parsed.after });
  }
  return windowFields({ asOf: parsed.asOf, before: parsed.before, after: parsed.after });
}

/**
 * Fold one committed session event into projection state.
 *
 * Only standard events are used: `/pin` shows up as `command/run` +
 * `command/done`, the "already told the model" watermark as `request/header`,
 * and the echo confirmation plus last-output time as `assistant/message` and
 * `tool/result`. Unknown events return the same reference.
 */
export function applyEvent(state, event, options = {}) {
  const promptLocale = options.promptLocale === 'en' ? 'en' : 'zh';
  if (event?.type === 'command/run') {
    if (event.data?.name !== 'pin') return state;
    const args = typeof event.data.args === 'string' ? event.data.args : '';
    return { ...state, running: { commandId: String(event.data.commandId), args } };
  }
  if (event?.type === 'command/done') {
    const running = state.running;
    if (running == null || String(event.data?.commandId) !== running.commandId) return state;
    if (event.data.kind !== 'success') return { ...state, running: null };
    const next = nextWindowFields(running.args, state);
    if (next === null) return { ...state, running: null };
    const unchanged =
      next.restricted === state.restricted &&
      next.asOf === state.asOf &&
      next.before === state.before &&
      next.after === state.after;
    if (unchanged) return { ...state, running: null };
    return {
      ...state,
      ...next,
      running: null,
      // A new restriction always asks for one anchor confirmation.
      anchorPending: next.restricted,
      // `injectedSig` keeps the previous window on purpose: a different
      // signature already forces the injection, and a non-null value tells the
      // planner this is an update rather than the first description.
      updatedAt: event.time,
    };
  }
  if (event?.type === 'request/header') {
    const signature = stateSignature(state, event.time);
    return state.injectedSig === signature ? state : { ...state, injectedSig: signature };
  }
  if (event?.type === 'assistant/message') {
    const window = windowFromState(state);
    const echoed =
      state.anchorPending === true &&
      window != null &&
      hasAnchorEcho(assistantText(event.data?.message), window, promptLocale, event.time);
    if (state.lastOutputAt === event.time && !echoed) return state;
    return {
      ...state,
      lastOutputAt: event.time,
      ...(echoed ? { anchorPending: false } : {}),
    };
  }
  if (event?.type === 'tool/result') {
    return state.lastOutputAt === event.time ? state : { ...state, lastOutputAt: event.time };
  }
  if (event?.type === 'turn/start') {
    return { ...state, runStartedAt: event.time };
  }
  if (event?.type === 'turn/end') {
    return state.runStartedAt === null ? state : { ...state, runStartedAt: null };
  }
  return state;
}

/**
 * Build the projection's Client wire view with reference stability: an
 * unchanged state object returns the previous view object, which suppresses
 * publication. The view never reads the clock, so it can be a pure function of
 * state (the Client decides "future" against its own local today).
 */
export function createViewCache() {
  let lastState = null;
  let lastView = null;
  let version = 0;
  return (state) => {
    if (state === lastState && lastView !== null) return lastView;
    const window = windowFromState(state);
    const asOfLabel = window?.asOf == null ? '默认' : formatAsOfDate(window.asOf);
    const rangeLabel = formatRangeZh(window);
    const inputOf = (span) => (span == null ? '' : `${span.amount}${UNIT_LABEL_ZH[span.unit]}`);
    const asOfInput =
      window?.asOf == null
        ? ''
        : window.asOf.era === 'ce'
          ? `${String(window.asOf.year).padStart(4, '0')}-${String(window.asOf.month).padStart(2, '0')}-${String(window.asOf.day).padStart(2, '0')}`
          : formatAsOfDate(window.asOf);
    version += 1;
    lastState = state;
    lastView = {
      restricted: isRestricted(window),
      asOf: state.asOf,
      before: state.before,
      after: state.after,
      asOfLabel,
      rangeLabel,
      chipLabel: `${asOfLabel} · ${rangeLabel}`,
      asOfInput,
      beforeInput: inputOf(window?.before ?? null),
      afterInput: inputOf(window?.after ?? null),
      // `modeBase` is clock-free: 'pinned' means the Client must compare
      // `asOfDay` with its own local today to decide past vs future.
      modeBase: !isRestricted(window) ? 'default' : window.asOf == null ? 'recent' : 'pinned',
      asOfDay: window?.asOf == null ? null : toDayNumber(window.asOf),
      anchorPending: state.anchorPending === true,
      lastOutputAt: state.lastOutputAt ?? null,
      runStartedAt: state.runStartedAt ?? null,
      updatedAt: state.updatedAt ?? null,
      version,
    };
    return lastView;
  };
}

const CLEAR_NOTICE = {
  zh: '[TIME PIN] 时间窗已清空，回到默认模式：不再做日期过滤，可正常使用当前来源。',
  en: '[TIME PIN] The evidence window was cleared. Default mode is active: no date filtering, use current sources normally.',
};

/**
 * Decide which messages one `agent/pre-step` should append.
 *
 * @param {object} input
 * @param {object} input.state - current projection state.
 * @param {number} input.nowMs - wall clock for this step.
 * @param {'zh'|'en'} input.promptLocale - model-facing text locale.
 * @param {(signature: string) => boolean} [input.canRemind] - anchor reminder
 *   budget; returning false degrades instead of repeating the correction.
 * @param {boolean} [input.turnStart] - true on the first step of a turn; the
 *   anchor correction is only offered there, never between two tool calls of
 *   the same turn.
 * @param {string} [input.silenceText] - pre-rendered `[TIME FACT]` block.
 * @returns {Array<{text: string, form: 'snapshot'|'notice'}>} messages to append.
 */
export function planStep(input) {
  const {
    state,
    nowMs = Date.now(),
    promptLocale = 'zh',
    canRemind,
    turnStart = false,
    silenceText,
  } = input;
  const messages = [];
  const window = windowFromState(state);
  if (window != null && isRestricted(window)) {
    const signature = stateSignature(state, nowMs);
    if (state.injectedSig !== signature) {
      const block = windowBlock(window, nowMs, promptLocale);
      const text =
        state.injectedSig != null ? `${statusSummary(window, nowMs, promptLocale)}\n\n${block}` : block;
      messages.push({ text, form: 'snapshot' });
    } else if (
      state.anchorPending === true &&
      turnStart === true &&
      // Only after the model actually produced a turn-end reply since the
      // window change; a tool call alone (or a step before any reply) must not
      // trigger the correction.
      state.lastOutputAt != null &&
      (state.updatedAt == null || state.lastOutputAt > state.updatedAt) &&
      (canRemind === undefined || canRemind(signature) === true)
    ) {
      messages.push({ text: anchorReminder(window, nowMs, promptLocale), form: 'notice' });
    }
  } else if (window == null && state.injectedSig != null && state.injectedSig !== 'default') {
    messages.push({ text: CLEAR_NOTICE[promptLocale], form: 'notice' });
  }
  if (typeof silenceText === 'string' && silenceText !== '') {
    messages.push({ text: silenceText, form: 'notice' });
  }
  return messages;
}
