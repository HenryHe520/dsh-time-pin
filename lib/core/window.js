/**
 * Pure time-window model for dsh-time-pin.
 *
 * A window is `[as_of - span, as_of]` at day granularity. `as_of` may be
 * omitted (null = "today", follows the clock) and `span` may be null (= no
 * lower bound). Calendar arithmetic is proleptic Gregorian and explicitly
 * supports BC years: there is no year 0, so 1 BC is astronomical year 0 and
 * 200 BC is astronomical year -199.
 *
 * Every function here is pure and dependency-free so it can be unit tested in
 * plain Node and reused by the Host half.
 *
 * @module dsh-time-pin/core/window
 */

/** Days per month, non-leap and leap, indexed by month - 1. */
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Largest accepted absolute year (CE or BCE). */
export const MAX_YEAR = 9999;

/** @typedef {{ era: 'ce' | 'bce', year: number, month: number, day: number }} AsOf */
/**
 * @typedef {{ unit: 'day' | 'month' | 'year', amount: number }} Span
 * @typedef {{ asOf: AsOf | null, span: Span | null }} Window
 */

/** Whether a proleptic Gregorian year is a leap year (handles negative years). */
export function isLeapYear(astroYear) {
  return astroYear % 4 === 0 && (astroYear % 100 !== 0 || astroYear % 400 === 0);
}

/** Days in one proleptic Gregorian month. */
export function daysInMonth(astroYear, month) {
  if (month === 2) return isLeapYear(astroYear) ? 29 : 28;
  return MONTH_DAYS[month - 1];
}

/** Astronomical year for an era-labelled year (1 BC -> 0, 200 BC -> -199). */
export function astroYearOf({ era, year }) {
  return era === 'ce' ? year : 1 - year;
}

/** Era-labelled year for an astronomical year (0 -> 1 BC, -199 -> 200 BC). */
export function eraYearOf(astroYear) {
  return astroYear >= 1
    ? { era: 'ce', year: astroYear }
    : { era: 'bce', year: 1 - astroYear };
}

/**
 * Days since the proleptic Gregorian epoch (1970-01-01) for one civil date.
 * Howard Hinnant's `days_from_civil`, valid for negative years.
 */
export function toDayNumber({ era, year, month, day }) {
  const astroYear = astroYearOf({ era, year });
  const shifted = month <= 2 ? astroYear - 1 : astroYear;
  const eraShift = Math.floor(shifted / 400);
  const yearOfEra = shifted - eraShift * 400;
  const dayOfYear =
    Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;
  return eraShift * 146097 + dayOfEra - 719468;
}

/** Civil date for a proleptic Gregorian day number. */
export function fromDayNumber(dayNumber) {
  const z = dayNumber + 719468;
  const eraShift = Math.floor(z / 146097);
  const dayOfEra = z - eraShift * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36524) -
      Math.floor(dayOfEra / 146096)) /
      365,
  );
  const dayOfYear =
    dayOfEra -
    (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const mp = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  const astroYear = yearOfEra + eraShift * 400 + (month <= 2 ? 1 : 0);
  return { ...eraYearOf(astroYear), month, day };
}

/** Local calendar date of an epoch-millisecond instant (day granularity). */
export function today(nowMs = Date.now()) {
  const date = new Date(nowMs);
  return {
    era: 'ce',
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  };
}

/** Validate one era-labelled civil date. */
export function validateAsOf(asOf) {
  if (asOf.era !== 'ce' && asOf.era !== 'bce') {
    return { ok: false, code: 'invalid_era', message: 'unknown era' };
  }
  if (asOf.era === 'bce' && asOf.year === 0) {
    return {
      ok: false,
      code: 'bce_zero',
      message: '历史纪年没有公元前 0 年，请改用公元前 1 年或公元 1 年',
    };
  }
  if (!Number.isSafeInteger(asOf.year) || asOf.year < 1 || asOf.year > MAX_YEAR) {
    return {
      ok: false,
      code: 'out_of_range',
      message: `年份必须在 1–${MAX_YEAR} 之间`,
    };
  }
  if (!Number.isSafeInteger(asOf.month) || asOf.month < 1 || asOf.month > 12) {
    return { ok: false, code: 'invalid_month', message: '月份必须在 1–12 之间' };
  }
  const maxDay = daysInMonth(astroYearOf(asOf), asOf.month);
  if (!Number.isSafeInteger(asOf.day) || asOf.day < 1 || asOf.day > maxDay) {
    return {
      ok: false,
      code: 'invalid_day',
      message:
        asOf.era === 'bce'
          ? `日期不存在：公元前 ${asOf.year} 年 ${asOf.month} 月只有 ${maxDay} 天`
          : `日期不存在：${asOf.year} 年 ${asOf.month} 月只有 ${maxDay} 天`,
    };
  }
  return { ok: true };
}

/** Normalize full-width digits and common full-width punctuation. */
export function normalizeInput(text) {
  return String(text ?? '')
    .replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\uFF0F]/g, '/')
    .replace(/[\uFF0D\u2212\u2013\u2014]/g, '-')
    .replace(/[\uFF1A]/g, ':')
    .trim();
}

const YEAR_MONTH_DAY = /^(\d{1,4})\s*[年\-\/.]\s*(\d{1,2})\s*(?:月\s*(\d{1,2})\s*日?|[\-\/.]\s*(\d{1,2})\s*日?)$/;
const YEAR_ONLY = /^(\d{1,4})\s*年?$/;
const BCE_CH = /^公元前\s*(\d{1,4})\s*年?(?:\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日?)?)?$/;
const BCE_SHORT = /^前\s*(\d{1,4})\s*年?(?:\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日?)?)?$/;
const BCE_LATIN = /^(?:BC|BCE)\.?\s*(\d{1,4})(?:\s*-\s*(\d{1,2})(?:\s*-\s*(\d{1,2}))?)?$/i;
const CE_CH = /^公元\s*(\d{1,4})\s*年?(?:\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日?)?)?$/;

/** Build one validated as-of value, or an error result. */
function makeAsOf(era, year, month = 1, day = 1) {
  const asOf = { era, year: Number(year), month: Number(month), day: Number(day) };
  const checked = validateAsOf(asOf);
  return checked.ok ? { ok: true, asOf } : checked;
}

/**
 * Parse a user-entered as-of time point.
 *
 * Accepted forms: `YYYY`, `YYYY-MM-DD`, `YYYY-M-D`, `YYYY/MM/DD`,
 * `YYYY年M月D日`, `公元YYYY年`, `公元前YYYY年`, `前YYYY年`, `BC YYYY`.
 * Missing month/day default to January 1. A bare year means January 1 00:00.
 */
export function parseAsOf(input) {
  const text = normalizeInput(input);
  if (text === '') {
    return { ok: false, code: 'empty', message: '时间点不能为空；清空请点“清空回默认”' };
  }
  let match = BCE_CH.exec(text) ?? BCE_SHORT.exec(text);
  if (match !== null) {
    return makeAsOf('bce', match[1], match[2] ?? 1, match[3] ?? 1);
  }
  match = BCE_LATIN.exec(text);
  if (match !== null) {
    return makeAsOf('bce', match[1], match[2] ?? 1, match[3] ?? 1);
  }
  match = CE_CH.exec(text);
  if (match !== null) {
    return makeAsOf('ce', match[1], match[2] ?? 1, match[3] ?? 1);
  }
  match = YEAR_MONTH_DAY.exec(text);
  if (match !== null) {
    return makeAsOf('ce', match[1], match[2], match[3] ?? match[4]);
  }
  match = YEAR_ONLY.exec(text);
  if (match !== null) {
    return makeAsOf('ce', match[1]);
  }
  if (/^\d{4,}\s*年?$/.test(text)) {
    return {
      ok: false,
      code: 'out_of_range',
      message: `年份必须在 1–${MAX_YEAR} 之间`,
    };
  }
  return {
    ok: false,
    code: 'invalid_format',
    message:
      '无法识别，请用 2000-01-01、2000年1月1日、2000 或 公元前200年 等格式',
  };
}

/** Maximum accepted span magnitudes per unit (keeps arithmetic well inside safe integers). */
const SPAN_LIMITS = { day: 3650000, month: 120000, year: 10000 };

const SPAN_NONE = /^(?:不限|无限制|全部|无限|无|all|any|unlimited|none|off|-|—)$/i;
const SPAN_DAY = /^(?:前|近|last|past)?\s*(\d+)\s*(?:天|日|d|day|days)$/i;
const SPAN_MONTH = /^(?:前|近|last|past)?\s*(\d+)\s*(?:个月|月|mo|mos|month|months)$/i;
const SPAN_YEAR = /^(?:前|近|last|past)?\s*(\d+)\s*(?:年|y|yr|yrs|year|years)$/i;

/**
 * Parse a lookback span. `null` means "unlimited".
 * @returns {{ok: true, span: Span | null} | {ok: false, code: string, message: string}}
 */
export function parseSpan(input) {
  const text = normalizeInput(input);
  if (text === '' || SPAN_NONE.test(text)) return { ok: true, span: null };
  if (text.startsWith('-')) {
    return { ok: false, code: 'negative', message: '范围不能是负数' };
  }
  // Zero needs no unit: it means "no expansion on this side", so the window
  // boundary sits exactly on the as-of day. Any unit spelling of zero is the
  // same instant and is accepted for convenience.
  if (/^0\s*(?:天|日|d|day|days|个月|月|mo|mos|month|months|年|y|yr|yrs|year|years)?$/iu.test(text)) {
    return { ok: true, span: { unit: 'day', amount: 0 } };
  }
  const units = [
    ['day', SPAN_DAY, '天数'],
    ['month', SPAN_MONTH, '月数'],
    ['year', SPAN_YEAR, '年数'],
  ];
  for (const [unit, pattern, label] of units) {
    const match = pattern.exec(text);
    if (match === null) continue;
    const amount = Number(match[1]);
    if (!Number.isSafeInteger(amount) || amount < 0) {
      return {
        ok: false,
        code: 'out_of_range',
        message: `${label}必须是 ≥ 0 的整数`,
      };
    }
    if (amount > SPAN_LIMITS[unit]) {
      return {
        ok: false,
        code: 'out_of_range',
        message: `${label}不能超过 ${SPAN_LIMITS[unit]}`,
      };
    }
    return { ok: true, span: { unit, amount } };
  }
  if (/^\d+\s*\S*$/u.test(text)) {
    return {
      ok: false,
      code: 'invalid_unit',
      message: '无法识别范围单位，请用 7天、6个月、10年 或不限',
    };
  }
  return {
    ok: false,
    code: 'invalid_format',
    message: '无法识别范围，请用 7天、30天、6个月、10年、100年 或 不限',
  };
}

/** Subtract a span from an as-of date with calendar semantics (clamping the day). */
export function subtractSpan(asOf, span) {
  if (span === null) return null;
  if (span.unit === 'day') {
    return fromDayNumber(toDayNumber(asOf) - span.amount);
  }
  if (span.unit === 'month') {
    const astroYear = astroYearOf(asOf);
    const totalMonths = astroYear * 12 + (asOf.month - 1) - span.amount;
    const nextAstroYear = Math.floor(totalMonths / 12);
    const nextMonth = totalMonths - nextAstroYear * 12 + 1;
    const { era, year } = eraYearOf(nextAstroYear);
    const day = Math.min(asOf.day, daysInMonth(nextAstroYear, nextMonth));
    return { era, year, month: nextMonth, day };
  }
  const astroYear = astroYearOf(asOf) - span.amount;
  const { era, year } = eraYearOf(astroYear);
  const day = Math.min(asOf.day, daysInMonth(astroYear, asOf.month));
  return { era, year, month: asOf.month, day };
}

/** Add a span to an as-of date with calendar semantics (clamping the day). */
export function addSpan(asOf, span) {
  if (span === null) return null;
  if (span.unit === 'day') {
    return fromDayNumber(toDayNumber(asOf) + span.amount);
  }
  if (span.unit === 'month') {
    const astroYear = astroYearOf(asOf);
    const totalMonths = astroYear * 12 + (asOf.month - 1) + span.amount;
    const nextAstroYear = Math.floor(totalMonths / 12);
    const nextMonth = totalMonths - nextAstroYear * 12 + 1;
    const { era, year } = eraYearOf(nextAstroYear);
    const day = Math.min(asOf.day, daysInMonth(nextAstroYear, nextMonth));
    return { era, year, month: nextMonth, day };
  }
  const astroYear = astroYearOf(asOf) + span.amount;
  const { era, year } = eraYearOf(astroYear);
  const day = Math.min(asOf.day, daysInMonth(astroYear, asOf.month));
  return { era, year, month: asOf.month, day };
}

/** Resolve the effective as-of date (today when the window follows the clock). */
export function resolveAsOf(window, nowMs = Date.now()) {
  if (window?.asOf != null) return window.asOf;
  return today(nowMs);
}

/** Stable storage key for an as-of date. */
export function asOfKey(asOf) {
  return `${asOf.era}:${asOf.year}-${String(asOf.month).padStart(2, '0')}-${String(asOf.day).padStart(2, '0')}`;
}

/** Parse a storage key produced by {@link asOfKey}. */
export function asOfFromKey(key) {
  const match = /^(ce|bce):(\d{1,4})-(\d{1,2})-(\d{1,2})$/.exec(String(key ?? ''));
  if (match === null) return null;
  return {
    era: match[1],
    year: Number(match[2]),
    month: Number(match[3]),
    day: Number(match[4]),
  };
}

/** Stable storage key for a span ('' when unlimited). */
export function spanKey(span) {
  return span === null ? '' : `${span.amount}${span.unit[0]}`;
}

/** Parse a storage key produced by {@link spanKey}. */
export function spanFromKey(key) {
  const text = String(key ?? '');
  if (text === '') return null;
  const match = /^(\d{1,7})([dmy])$/.exec(text);
  if (match === null) return null;
  const unit = { d: 'day', m: 'month', y: 'year' }[match[2]];
  return { unit, amount: Number(match[1]) };
}

/** One-line human label for an as-of date (CE ISO, BC Chinese era). */
export function formatAsOfDate(asOf) {
  if (asOf == null) return '默认';
  if (asOf.era === 'ce') {
    return `${String(asOf.year).padStart(4, '0')}-${String(asOf.month).padStart(2, '0')}-${String(asOf.day).padStart(2, '0')}`;
  }
  const month = asOf.month === 1 && asOf.day === 1 ? '' : `${asOf.month}月${asOf.day}日`;
  return `公元前${asOf.year}年${month}`;
}

/** English human label for an as-of date. */
export function formatAsOfDateEn(asOf) {
  if (asOf == null) return 'default';
  if (asOf.era === 'ce') {
    return `${String(asOf.year).padStart(4, '0')}-${String(asOf.month).padStart(2, '0')}-${String(asOf.day).padStart(2, '0')}`;
  }
  const md = asOf.month === 1 && asOf.day === 1 ? '' : `-${asOf.month}-${asOf.day}`;
  return `BC ${asOf.year}${md}`;
}

const UNIT_ZH = { day: '天', month: '个月', year: '年' };
const UNIT_EN = { day: 'day', month: 'month', year: 'year' };

/** Chinese label for one side of the range (`前10年` / `后5年` / `0` / `前不限`). */
function sideLabelZh(side, span) {
  const prefix = side === 'after' ? '后' : '前';
  if (span === null) return `${prefix}不限`;
  if (span.amount === 0) return `${prefix}0`;
  return `${prefix}${span.amount}${UNIT_ZH[span.unit]}`;
}

/** English label for one side of the range (`last 10 years` / `next 0` / …). */
function sideLabelEn(side, span) {
  if (span === null) return 'unbounded';
  if (span.amount === 0) return `${side === 'after' ? 'next' : 'last'} 0`;
  const unit = UNIT_EN[span.unit];
  return `${side === 'after' ? 'next' : 'last'} ${span.amount} ${unit}${span.amount === 1 ? '' : 's'}`;
}

/** Chinese one-line range label: `不限`, `前后各10年`, `前10年/后5年`. */
export function formatRangeZh(window) {
  const before = window?.before ?? null;
  const after = window?.after ?? null;
  if (before === null && after === null) return '不限';
  if (
    before !== null &&
    after !== null &&
    before.unit === after.unit &&
    before.amount === after.amount
  ) {
    return before.amount === 0 ? '前后各0' : `前后各${before.amount}${UNIT_ZH[before.unit]}`;
  }
  return `${sideLabelZh('before', before)}/${sideLabelZh('after', after)}`;
}

/** English one-line range label: `unlimited`, `±10 years`, `last 10 years / next 5 years`. */
export function formatRangeEn(window) {
  const before = window?.before ?? null;
  const after = window?.after ?? null;
  if (before === null && after === null) return 'unlimited';
  if (
    before !== null &&
    after !== null &&
    before.unit === after.unit &&
    before.amount === after.amount
  ) {
    if (before.amount === 0) return '±0';
    const unit = UNIT_EN[before.unit];
    return `±${before.amount} ${unit}${before.amount === 1 ? '' : 's'}`;
  }
  return `${sideLabelEn('before', before)} / ${sideLabelEn('after', after)}`;
}

/** Chinese label for a plain lookback span (kept for older callers). */
export function formatSpanZh(span) {
  return span === null ? '不限' : sideLabelZh('before', span);
}

/** English label for a plain lookback span (kept for older callers). */
export function formatSpanEn(span) {
  return sideLabelEn('before', span ?? null);
}

/** Whether a window is in restricted mode (a pinned as-of or a finite range side). */
export function isRestricted(window) {
  return window != null && (window.asOf != null || window.before != null || window.after != null);
}

/** Whether any date the window admits lies after today (the model cannot know it). */
export function isFuture(window, nowMs = Date.now()) {
  if (window == null) return false;
  const todayDay = toDayNumber(today(nowMs));
  const { upper } = windowBounds(window, nowMs);
  if (upper !== null) return upper > todayDay;
  // An unbounded upper side admits future dates too.
  return isRestricted(window);
}

/** Whether every date the window admits is strictly before today. */
export function isPast(window, nowMs = Date.now()) {
  if (window == null) return false;
  const todayDay = toDayNumber(today(nowMs));
  const { upper } = windowBounds(window, nowMs);
  return upper !== null && upper < todayDay;
}

/** Inclusive day-number bounds: a null before/after side means unbounded there. */
export function windowBounds(window, nowMs = Date.now()) {
  const base = resolveAsOf(window, nowMs);
  const lowerAsOf = subtractSpan(base, window?.before ?? null);
  const upperAsOf = addSpan(base, window?.after ?? null);
  return {
    lower: lowerAsOf === null ? null : toDayNumber(lowerAsOf),
    upper: upperAsOf === null ? null : toDayNumber(upperAsOf),
  };
}

/** Whether one epoch-free day number falls inside a window (endpoints inclusive). */
export function dayInWindow(dayNumber, window, nowMs = Date.now()) {
  const { lower, upper } = windowBounds(window, nowMs);
  return (lower === null || dayNumber >= lower) && (upper === null || dayNumber <= upper);
}

/** Stable dedupe signature: identical windows produce byte-identical injections. */
export function windowSignature(window, nowMs = Date.now()) {
  if (window == null) return 'default';
  const asOf = window.asOf == null ? `today:${asOfKey(today(nowMs))}` : asOfKey(window.asOf);
  return `${asOf}|${spanKey(window.before ?? null)}|${spanKey(window.after ?? null)}`;
}

/** Chinese one-line window label used by the title-bar control. */
export function formatWindowLabelZh(window, nowMs = Date.now()) {
  if (window == null || !isRestricted(window)) return '默认 · 不限';
  const asOfLabel = window.asOf == null ? '默认' : formatAsOfDate(window.asOf);
  return `${asOfLabel} · ${formatRangeZh(window)}`;
}

/** English one-line window label used by the title-bar control. */
export function formatWindowLabelEn(window, nowMs = Date.now()) {
  if (window == null || !isRestricted(window)) return 'Default · Unlimited';
  const asOfLabel = window.asOf == null ? 'Default' : formatAsOfDateEn(window.asOf);
  return `${asOfLabel} · ${formatRangeEn(window)}`;
}

/** Machine enum for the title-bar control glyph. */
export function windowMode(window, nowMs = Date.now()) {
  if (!isRestricted(window)) return 'default';
  if (isFuture(window, nowMs)) return 'future';
  if (window.asOf != null) return 'past';
  return 'recent';
}

const PIN_OFF = /^(?:off|关闭|解除|取消|clear|reset|default|默认|清空)$/i;
const PIN_STATUS = /^(?:status|状态|\?|help|帮助)$/i;

/**
 * Parse one range token, honouring an optional side prefix.
 *
 * Accepted prefixes: `前` / `近` / `后` (zh), `last` / `past` / `before` /
 * `next` / `after` / `future` (en, case-insensitive). The rest is parsed with
 * {@link parseSpan}, so `不限` stays a valid explicit "unbounded" token.
 *
 * @param {unknown} text - one raw token.
 * @returns {{side: 'before'|'after'|null, span: Span|null} | null} parsed token,
 *   or `null` when the token is not a range.
 */
function parseSideRange(text) {
  const t = normalizeInput(text).trim();
  if (t === '') return null;
  if (SPAN_NONE.test(t)) return { side: null, span: null };
  let side = null;
  let rest = t;
  const zh = /^(前|近|后)\s*(.*)$/u.exec(t);
  if (zh !== null) {
    side = zh[1] === '后' ? 'after' : 'before';
    rest = zh[2].trim();
  } else {
    const en = /^(last|past|before|next|after|future)\s+(.+)$/i.exec(t);
    if (en !== null) {
      const word = en[1].toLowerCase();
      side = word === 'next' || word === 'after' || word === 'future' ? 'after' : 'before';
      rest = en[2].trim();
    }
  }
  if (rest === '') return { side, span: null };
  const parsed = parseSpan(rest);
  if (!parsed.ok) return null;
  return { side, span: parsed.span };
}

/**
 * Resolve one or two range tokens into `{before, after}` with the mirror rule:
 * a single supplied side is applied to both sides; two supplied tokens are
 * positional (`before after`) unless their side prefixes say otherwise.
 *
 * @param {Array<{side: 'before'|'after'|null, span: Span|null}>} tokens - 1–2 tokens.
 * @returns {{before: Span|null, after: Span|null}} resolved range sides.
 */
function resolveRangeTokens(tokens) {
  if (tokens.length === 1) {
    const only = tokens[0];
    return { before: only.span, after: only.span };
  }
  const [first, second] = tokens;
  if (first.side === 'after' && second.side === 'before') {
    return { before: second.span, after: first.span };
  }
  if (first.side === null && second.side === 'before') {
    return { before: second.span, after: first.span };
  }
  return { before: first.span, after: second.span };
}

/**
 * Parse the range part of a `/pin` argument string (everything after the as-of).
 *
 * Accepted shapes: one token (`10年`, `前10年`, `后5年`, `不限`), two tokens
 * (`前10年 后5年`, `10年 5年`), or a slash-separated pair (`前10年/后5年`).
 *
 * @param {unknown} text - range part.
 * @returns {{ok: true, tokens: Array<object>} | {ok: false}} parse result.
 */
function parseRangesText(text) {
  const t = normalizeInput(text).trim();
  if (t === '') return { ok: true, tokens: [] };
  if (t.includes('/')) {
    const parts = t.split('/').map((part) => part.trim());
    if (parts.length !== 2 || parts.some((part) => part === '')) return { ok: false };
    const first = parseSideRange(parts[0]);
    const second = parseSideRange(parts[1]);
    if (first === null || second === null) return { ok: false };
    return { ok: true, tokens: [first, second] };
  }
  const single = parseSideRange(t);
  if (single !== null) return { ok: true, tokens: [single] };
  const positions = [];
  for (const match of t.matchAll(/\s+/g)) positions.push(match.index);
  for (const index of positions) {
    const head = t.slice(0, index).trim();
    const tail = t.slice(index).trim();
    if (head === '' || tail === '') continue;
    const first = parseSideRange(head);
    const second = parseSideRange(tail);
    if (first !== null && second !== null) return { ok: true, tokens: [first, second] };
  }
  return { ok: false };
}

/**
 * Parse the argument string of the `/pin` command.
 *
 * Grammar: `<as-of>` (keeps the current range), `<as-of> <range…>`,
 * `<range…>` (clock-following as-of), `off` (clear the window), or an empty
 * string (status query). `<range…>` is either one side (`前10年`, `后5年`,
 * `10年`, `不限`) which mirrors to both sides, or two sides (`前10年 后5年`).
 *
 * @returns {{kind:'status'} |
 *   {kind:'off'} |
 *   {kind:'asOf', asOf: AsOf} |
 *   {kind:'ranges', before: Span|null, after: Span|null} |
 *   {kind:'window', asOf: AsOf, before: Span|null, after: Span|null} |
 *   {kind:'invalid', message: string}}
 */
export function parsePinArgs(args) {
  const text = normalizeInput(args);
  if (text === '' || PIN_STATUS.test(text)) return { kind: 'status' };
  if (PIN_OFF.test(text)) return { kind: 'off' };
  const asOfOnly = parseAsOf(text);
  if (asOfOnly.ok) return { kind: 'asOf', asOf: asOfOnly.asOf };
  const rangesOnly = parseRangesText(text);
  if (rangesOnly.ok) {
    const { before, after } = resolveRangeTokens(rangesOnly.tokens);
    return { kind: 'ranges', before, after };
  }
  const positions = [];
  for (const match of text.matchAll(/\s+/g)) positions.push(match.index);
  for (const index of positions) {
    const head = text.slice(0, index).trim();
    const tail = text.slice(index).trim();
    if (head === '' || tail === '') continue;
    const asOf = parseAsOf(head);
    if (!asOf.ok) continue;
    const ranges = parseRangesText(tail);
    if (!ranges.ok) {
      return {
        kind: 'invalid',
        message: `无法识别范围部分：“${tail}”，请用 前7天、后6个月、10年、前10年 后5年 或 不限`,
      };
    }
    const { before, after } = resolveRangeTokens(ranges.tokens);
    return { kind: 'window', asOf: asOf.asOf, before, after };
  }
  return { kind: 'invalid', message: asOfOnly.message };
}

/**
 * Compose a window from the panel's raw inputs; the first failure names the
 * field. `beforeText` / `afterText` may be empty: one empty side mirrors the
 * other, both empty means an unbounded range on both sides.
 */
export function windowFromInput(asOfText, beforeText, afterText) {
  const asOfRaw = normalizeInput(asOfText ?? '').trim();
  let asOf = null;
  if (asOfRaw !== '') {
    const parsed = parseAsOf(asOfRaw);
    if (!parsed.ok) return { ok: false, field: 'asOf', ...parsed };
    asOf = parsed.asOf;
  }
  /** Read one side: absent (`undefined`), explicit unbounded (`null`) or a span. */
  const readSide = (text) => {
    const t = normalizeInput(text ?? '').trim();
    if (t === '') return { ok: true, span: undefined };
    const parsed = parseSideRange(t);
    if (parsed === null) return { ok: false };
    return { ok: true, span: parsed.span };
  };
  const before = readSide(beforeText);
  if (!before.ok) {
    return { ok: false, field: 'before', code: 'invalid_format', message: '无法识别前置范围，请用 7天、6个月、10年 或 不限' };
  }
  const after = readSide(afterText);
  if (!after.ok) {
    return { ok: false, field: 'after', code: 'invalid_format', message: '无法识别后置范围，请用 7天、6个月、10年 或 不限' };
  }
  let resolvedBefore = null;
  let resolvedAfter = null;
  if (before.span === undefined && after.span === undefined) {
    resolvedBefore = null;
    resolvedAfter = null;
  } else if (before.span === undefined) {
    resolvedBefore = after.span;
    resolvedAfter = after.span;
  } else {
    resolvedBefore = before.span;
    resolvedAfter = after.span === undefined ? before.span : after.span;
  }
  return { ok: true, window: { asOf, before: resolvedBefore, after: resolvedAfter } };
}
