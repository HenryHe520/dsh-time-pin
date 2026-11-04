/**
 * Restricted-mode evidence filtering for dsh-time-pin.
 *
 * Two halves:
 *
 * 1. Pure functions, dependency-free apart from `lib/core/window.js`:
 *    - {@link parsePublishedAt} turns the `publishedAt` string a web provider
 *      reports (ISO date/time, `YYYY/MM/DD`, `YYYY-MM`, `YYYY`, `today`,
 *      `yesterday`, `N days ago`) into a civil-day instant.
 *    - {@link filterWebSearchValue} drops every source whose date is outside
 *      the inclusive evidence window `[as_of - span, as_of]`, drops undated
 *      sources (untrusted in restricted mode by design), and appends one
 *      byte-stable Chinese note explaining the exclusions.
 *
 * 2. The Host hook factory {@link createEvidencePostExecute}: a
 *    `tools/post-execute` waterfall listener that replaces the `web_search`
 *    result value with the filtered value. The canonical web_search value is
 *    `{ content?, sources: [{ url, title?, snippet?, publishedAt? }], truncated }`
 *    (see `@deepseek-ai/dsh-tool-web`); the replacement re-enters the tool's
 *    output schema validation and render, so it must keep that exact shape.
 *
 * No wall-clock read happens here except through an injected `now` function
 * (pure functions accept an explicit `nowMs`; the default only exists for
 * convenience outside the Harness).
 *
 * @module dsh-time-pin/evidence
 */

import {
  dayInWindow,
  formatAsOfDate,
  isRestricted,
  resolveAsOf,
  subtractSpan,
  today,
  toDayNumber,
  validateAsOf,
} from './core/window.js';

/** Milliseconds in one civil day. */
const DAY_MS = 86_400_000;

/** Milliseconds per relative-age unit that needs instant arithmetic. */
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** Inclusive upper bound on a relative age we accept, in whole days. */
const MAX_RELATIVE_DAYS = 10_000_000;

/** `today` / `yesterday`, already lowercased and trimmed. */
const DAY_WORDS = /^(?:today|yesterday)$/;

/** `3 days ago`, `1 hour ago`, `a minute ago`, ... */
const RELATIVE_AGE = /^(\d+|a|an|one)\s*(minute|hour|day|week|month|year)s?\s+ago$/;

/** Full ISO timestamp, optional time/zone (the time part is not used for the day). */
const TIMESTAMP =
  /^(\d{4})-(\d{1,2})-(\d{1,2})[t ]\d{1,2}:\d{1,2}(?::\d{1,2}(?:\.\d{1,9})?)?(?:\s*(?:z|utc|gmt|[+-]\d{2}:?\d{2}))?$/;

/** ISO date only, dash or slash separated. */
const DATE_ONLY = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/;

/** Year + month, interpreted as the first day of that month. */
const YEAR_MONTH = /^(\d{4})[-/](\d{1,2})$/;

/** Bare four-digit year, interpreted as January 1 of that year. */
const YEAR_ONLY = /^(\d{4})$/;

/**
 * Normalize a provider date string for matching: string-only, trimmed,
 * lowercased, trailing sentence punctuation removed. Anything non-string
 * normalizes to `''` (undated).
 *
 * @param {unknown} text - raw `publishedAt` value.
 * @returns {string} normalized text.
 */
function normalizePublishedAtText(text) {
  if (typeof text !== 'string') return '';
  return text
    .trim()
    .replace(/[.,;!?。，；！？]+$/u, '')
    .trim()
    .toLowerCase();
}

/**
 * Whether a proleptic Gregorian CE civil date exists.
 *
 * @param {number} year - CE year (1–9999).
 * @param {number} month - month (1–12).
 * @param {number} day - day of month.
 * @returns {boolean} whether the date is valid.
 */
function isCivilCeDate(year, month, day) {
  return validateAsOf({ era: 'ce', year, month, day }).ok;
}

/**
 * Day number (days since 1970-01-01) for a CE civil date, or `null`.
 *
 * @param {number} year - CE year.
 * @param {number} month - month.
 * @param {number} day - day.
 * @returns {number | null} day number or `null` when the date does not exist.
 */
function ceDayNumber(year, month, day) {
  if (!isCivilCeDate(year, month, day)) return null;
  return toDayNumber({ era: 'ce', year, month, day });
}

/**
 * Day number for an English relative age such as `3 days ago`, evaluated
 * against `nowMs`. Day/week/month/year arithmetic reuses the window model's
 * calendar helpers so month and year lengths stay calendar-correct.
 *
 * @param {string} amountText - digit string, or `a` / `an` / `one`.
 * @param {string} unit - minute | hour | day | week | month | year.
 * @param {number} nowMs - reference instant.
 * @returns {number | null} day number, or `null` when invalid.
 */
function relativeDayNumber(amountText, unit, nowMs) {
  const amount =
    amountText === 'a' || amountText === 'an' || amountText === 'one'
      ? 1
      : Number(amountText);
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_RELATIVE_DAYS) {
    return null;
  }
  const base = today(nowMs);
  switch (unit) {
    case 'minute':
      return toDayNumber(today(nowMs - amount * MINUTE_MS));
    case 'hour':
      return toDayNumber(today(nowMs - amount * HOUR_MS));
    case 'day':
      return toDayNumber(subtractSpan(base, { unit: 'day', amount }));
    case 'week':
      return toDayNumber(subtractSpan(base, { unit: 'day', amount: amount * 7 }));
    case 'month':
      return toDayNumber(subtractSpan(base, { unit: 'month', amount }));
    case 'year':
      return toDayNumber(subtractSpan(base, { unit: 'year', amount }));
    default:
      return null;
  }
}

/**
 * Parse a provider `publishedAt` string into a civil-day instant.
 *
 * Accepted forms (case-insensitive, surrounding whitespace ignored):
 * `today`, `yesterday`, `N minute(s) ago`, `N hour(s) ago`, `N day(s) ago`,
 * `N week(s) ago`, `N month(s) ago`, `N year(s) ago`, full ISO timestamps
 * (`2024-05-03T10:00:00Z`; the time-of-day and zone are not used for the
 * day), `YYYY-MM-DD`, `YYYY-M-D`, `YYYY/MM/DD`, `YYYY-MM`, `YYYY`.
 *
 * The result is the instant of 00:00 UTC of the evidence's civil day, i.e.
 * `dayNumber * 86400000`, matching `toDayNumber()` in `lib/core/window.js`.
 * Anything else — including an incomplete date, a date that does not exist
 * (`2026-02-30`) or a year outside 1–9999 — is undated and yields `null`.
 *
 * @param {unknown} text - raw `publishedAt` value.
 * @param {number} [nowMs] - reference instant for relative ages.
 * @returns {number | null} epoch milliseconds of the civil day, or `null`.
 */
export function parsePublishedAt(text, nowMs = Date.now()) {
  const normalized = normalizePublishedAtText(text);
  if (normalized === '') return null;
  const at = Number.isFinite(nowMs) ? nowMs : Date.now();

  if (DAY_WORDS.test(normalized)) {
    const base = today(at);
    const civil =
      normalized === 'today'
        ? base
        : subtractSpan(base, { unit: 'day', amount: 1 });
    return toDayNumber(civil) * DAY_MS;
  }

  const relative = RELATIVE_AGE.exec(normalized);
  if (relative !== null) {
    const dayNumber = relativeDayNumber(relative[1], relative[2], at);
    return dayNumber === null ? null : dayNumber * DAY_MS;
  }

  let match = TIMESTAMP.exec(normalized);
  if (match !== null) {
    const dayNumber = ceDayNumber(Number(match[1]), Number(match[2]), Number(match[3]));
    return dayNumber === null ? null : dayNumber * DAY_MS;
  }

  match = DATE_ONLY.exec(normalized);
  if (match !== null) {
    const dayNumber = ceDayNumber(Number(match[1]), Number(match[2]), Number(match[3]));
    return dayNumber === null ? null : dayNumber * DAY_MS;
  }

  match = YEAR_MONTH.exec(normalized);
  if (match !== null) {
    const dayNumber = ceDayNumber(Number(match[1]), Number(match[2]), 1);
    return dayNumber === null ? null : dayNumber * DAY_MS;
  }

  match = YEAR_ONLY.exec(normalized);
  if (match !== null) {
    const dayNumber = ceDayNumber(Number(match[1]), 1, 1);
    return dayNumber === null ? null : dayNumber * DAY_MS;
  }

  return null;
}

/**
 * Chinese label for a window's inclusive bounds, e.g. `1990-01-01 至 2000-01-01`
 * or `不限 至 2000-01-01`. Byte-stable for one window and one day.
 *
 * @param {{asOf: object | null, span: object | null}} window - evidence window.
 * @param {number} nowMs - reference instant (window with `asOf: null`).
 * @returns {string} range label.
 */
function formatWindowRangeZh(window, nowMs) {
  const asOf = resolveAsOf(window, nowMs);
  const lowerAsOf = subtractSpan(asOf, window?.span ?? null);
  const lower = lowerAsOf === null ? '不限' : formatAsOfDate(lowerAsOf);
  return `${lower} 至 ${formatAsOfDate(asOf)}`;
}

/**
 * Append one note line to existing provider content, replacing it entirely
 * when absent. Idempotent for a byte-identical note (never doubles the line).
 *
 * @param {unknown} content - existing provider content.
 * @param {string} note - note line to append.
 * @returns {string} new content.
 */
function appendNote(content, note) {
  const base = typeof content === 'string' ? content.trimEnd() : '';
  if (base === '' || base === note) return note;
  if (base.endsWith(note)) return base;
  return `${base}\n${note}`;
}

/**
 * Content for the zero-evidence case: no dated source survives the window.
 *
 * @param {string} range - window range label.
 * @param {number} excludedUndated - undated sources dropped.
 * @param {number} excludedOutside - out-of-window sources dropped.
 * @returns {string} replacement content.
 */
function zeroEvidenceContent(range, excludedUndated, excludedOutside) {
  return `[TIME PIN] 按当前时间窗没有带日期的可用证据（时间窗 ${range}）：已排除 ${excludedUndated} 条无日期来源、${excludedOutside} 条窗口外来源。建议扩大检索范围或换一个时间点。`;
}

/**
 * Filter a `web_search` structured value down to dated sources inside the
 * inclusive evidence window, in restricted mode only.
 *
 * - A source with a `publishedAt` inside `[as_of - span, as_of]` is kept.
 * - A source outside the window is dropped (`excludedOutside`).
 * - A source whose `publishedAt` is missing or unparseable is dropped
 *   (`excludedUndated`); restricted mode treats undated sources as untrusted.
 * - When nothing is dropped the SAME `value` object is returned, so the
 *   caller can detect "no change" by identity and leave the tool result alone.
 * - When something is dropped a NEW value object is returned whose
 *   `content` carries one byte-stable Chinese `[TIME PIN]` note line. No dated
 *   source left → `content` is the explicit zero-evidence note instead.
 *
 * @param {{content?: string, sources?: Array<{url: string, title?: string, snippet?: string, publishedAt?: string}>, truncated?: boolean}} value
 *   the canonical `web_search` output value.
 * @param {{asOf: object | null, span: object | null} | null} window
 *   the session's evidence window; `null` or unrestricted returns `value`.
 * @param {number} [nowMs] - reference instant for relative ages and an
 *   `asOf: null` window.
 * @returns {{value: object, kept: number, excludedUndated: number, excludedOutside: number}}
 *   the (possibly replaced) value plus kept/excluded counts. `kept` is the
 *   number of sources retained.
 */
export function filterWebSearchValue(value, window, nowMs = Date.now()) {
  const at = Number.isFinite(nowMs) ? nowMs : Date.now();
  const sources =
    value !== null && typeof value === 'object' && Array.isArray(value.sources)
      ? value.sources
      : null;
  if (sources === null || !isRestricted(window)) {
    return {
      value,
      kept: sources === null ? 0 : sources.length,
      excludedUndated: 0,
      excludedOutside: 0,
    };
  }

  const keptSources = [];
  let excludedUndated = 0;
  let excludedOutside = 0;
  for (const source of sources) {
    const publishedAt =
      source !== null && typeof source === 'object' ? source.publishedAt : undefined;
    const published = parsePublishedAt(publishedAt, at);
    if (published === null) {
      excludedUndated += 1;
      continue;
    }
    const dayNumber = Math.round(published / DAY_MS);
    if (dayInWindow(dayNumber, window, at)) keptSources.push(source);
    else excludedOutside += 1;
  }

  const excluded = excludedUndated + excludedOutside;
  if (excluded === 0) {
    return {
      value,
      kept: keptSources.length,
      excludedUndated,
      excludedOutside,
    };
  }

  const range = formatWindowRangeZh(window, at);
  const content =
    keptSources.length > 0
      ? appendNote(
          value.content,
          `[TIME PIN] 已排除 ${excludedUndated} 条无日期来源、${excludedOutside} 条窗口外来源（时间窗 ${range}）。`,
        )
      : zeroEvidenceContent(range, excludedUndated, excludedOutside);

  return {
    value: {
      content,
      sources: keptSources,
      truncated: value.truncated === true,
    },
    kept: keptSources.length,
    excludedUndated,
    excludedOutside,
  };
}

/**
 * Build the `tools/post-execute` listener that applies evidence filtering to
 * `web_search` results in restricted mode.
 *
 * The listener calls `next()` first (the waterfall contract) and otherwise
 * leaves every other call and every non-`accept` decision untouched. When the
 * window is unrestricted, the call failed, the value shape is not a
 * web_search value, or nothing was dropped, the next decision is returned
 * unchanged. Otherwise it returns `{kind: 'accept', value: filteredValue}`,
 * carrying along any `additionalContexts` the next decision attached.
 *
 * Errors inside this listener are contained (the original decision is
 * returned) so a status helper can never turn a successful search into a
 * failed tool result.
 *
 * @param {object} options - factory options.
 * @param {(agent: unknown) => {asOf: object | null, span: object | null} | null | undefined} options.getWindow
 *   resolves the calling agent's window; `getWindow(exec.agent)` is called with
 *   the tool call's agent (it may return `null` when the agent has no pin).
 * @param {() => number} [options.now] - injected clock (milliseconds).
 * @returns {(exec: object, result: object, next: () => Promise<object>) => Promise<object>}
 *   async `tools/post-execute` waterfall listener.
 */
export function createEvidencePostExecute({ getWindow, now = () => Date.now() } = {}) {
  if (typeof getWindow !== 'function') {
    throw new TypeError('createEvidencePostExecute requires getWindow(agent)');
  }
  const readNow = () => {
    const value = typeof now === 'function' ? now() : Number.NaN;
    return Number.isFinite(value) ? value : Date.now();
  };

  return async function evidencePostExecute(exec, result, next) {
    const decision = await next();
    try {
      if (exec === null || typeof exec !== 'object' || exec.name !== 'web_search') {
        return decision;
      }
      if (decision === null || typeof decision !== 'object' || decision.kind !== 'accept') {
        return decision;
      }
      // An earlier policy already replaced the model-facing content; do not
      // overwrite a replacement we did not make.
      if (Object.hasOwn(decision, 'content')) return decision;
      if (result === null || typeof result !== 'object' || result.isError === true) {
        return decision;
      }
      const agent = exec.agent;
      if (agent === null || agent === undefined) return decision;
      const window = getWindow(agent);
      if (!isRestricted(window)) return decision;
      const value = result.value;
      if (value === null || typeof value !== 'object' || !Array.isArray(value.sources)) {
        return decision;
      }
      const filtered = filterWebSearchValue(value, window, readNow());
      if (filtered.value === value) return decision;
      return {
        kind: 'accept',
        value: filtered.value,
        ...(decision.additionalContexts !== undefined
          ? { additionalContexts: decision.additionalContexts }
          : {}),
      };
    } catch (error) {
      return decision;
    }
  };
}
