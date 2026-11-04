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
  const units = [
    ['day', SPAN_DAY, '天数'],
    ['month', SPAN_MONTH, '月数'],
    ['year', SPAN_YEAR, '年数'],
  ];
  for (const [unit, pattern, label] of units) {
    const match = pattern.exec(text);
    if (match === null) continue;
    const amount = Number(match[1]);
    if (!Number.isSafeInteger(amount) || amount < 1) {
      return {
        ok: false,
        code: 'out_of_range',
        message: `${label}必须是 ≥ 1 的整数`,
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

/** Chinese label for a span. */
export function formatSpanZh(span) {
  return span === null ? '不限' : `前${span.amount}${UNIT_ZH[span.unit]}`;
}

/** English label for a span. */
export function formatSpanEn(span) {
  if (span === null) return 'unlimited';
  return `last ${span.amount} ${UNIT_EN[span.unit]}${span.amount === 1 ? '' : 's'}`;
}

/** Whether a window is in restricted mode (a pin or a finite span). */
export function isRestricted(window) {
  return window != null && (window.asOf != null || window.span != null);
}

/** Whether the effective as-of is in the future relative to now. */
export function isFuture(window, nowMs = Date.now()) {
  return toDayNumber(resolveAsOf(window, nowMs)) > toDayNumber(today(nowMs));
}

/** Whether the effective as-of is strictly before today. */
export function isPast(window, nowMs = Date.now()) {
  return toDayNumber(resolveAsOf(window, nowMs)) < toDayNumber(today(nowMs));
}

/** Inclusive day-number bounds of a window: lower is null when unlimited. */
export function windowBounds(window, nowMs = Date.now()) {
  const upper = toDayNumber(resolveAsOf(window, nowMs));
  const lowerAsOf = subtractSpan(resolveAsOf(window, nowMs), window?.span ?? null);
  return { lower: lowerAsOf === null ? null : toDayNumber(lowerAsOf), upper };
}

/** Whether one epoch-free day number falls inside a window (endpoints inclusive). */
export function dayInWindow(dayNumber, window, nowMs = Date.now()) {
  const { lower, upper } = windowBounds(window, nowMs);
  return (lower === null || dayNumber >= lower) && dayNumber <= upper;
}

/** Stable dedupe signature: identical windows produce byte-identical injections. */
export function windowSignature(window, nowMs = Date.now()) {
  if (window == null) return 'default';
  const asOf = window.asOf == null ? `today:${asOfKey(today(nowMs))}` : asOfKey(window.asOf);
  return `${asOf}|${spanKey(window.span)}`;
}

/** Chinese one-line window label used by the title-bar control. */
export function formatWindowLabelZh(window, nowMs = Date.now()) {
  if (window == null) return '默认 · 不限';
  const asOfLabel = window.asOf == null ? '默认' : formatAsOfDate(window.asOf);
  if (window.span == null) return `${asOfLabel} · 不限`;
  const prefix = window.asOf == null ? '近' : '前';
  return `${asOfLabel} · ${prefix}${window.span.amount}${UNIT_ZH[window.span.unit]}`;
}

/** English one-line window label used by the title-bar control. */
export function formatWindowLabelEn(window, nowMs = Date.now()) {
  if (window == null) return 'Default · Unlimited';
  const asOfLabel = window.asOf == null ? 'Default' : formatAsOfDateEn(window.asOf);
  return `${asOfLabel} · ${formatSpanEn(window.span)}`;
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
 * Parse the argument string of the `/pin` command.
 *
 * Grammar: `<as-of>` (keeps the current span), `<as-of> <span>`,
 * `off` (clear the window), or an empty string (status query). A span token may
 * itself be multi-word for Latin input (`BC 200 20 years` handles `BC 200` as
 * the as-of token first, then falls back to whole-string splits).
 *
 * @returns {{kind:'status'} |
 *   {kind:'off'} |
 *   {kind:'asOf', asOf: AsOf} |
 *   {kind:'window', asOf: AsOf, span: Span|null} |
 *   {kind:'invalid', message: string}}
 */
export function parsePinArgs(args) {
  const text = normalizeInput(args);
  if (text === '' || PIN_STATUS.test(text)) return { kind: 'status' };
  if (PIN_OFF.test(text)) return { kind: 'off' };
  const asOfOnly = parseAsOf(text);
  if (asOfOnly.ok) return { kind: 'asOf', asOf: asOfOnly.asOf };
  // A span with no as-of pins the clock to "today" and keeps a finite lookback
  // (`/pin 7天` -> default time point, last 7 days).
  const spanOnly = parseSpan(text);
  if (spanOnly.ok) return { kind: 'span', span: spanOnly.span };
  const splits = [];
  for (const match of text.matchAll(/\s+/g)) splits.push(match.index);
  for (const index of splits) {
    const head = text.slice(0, index).trim();
    const tail = text.slice(index).trim();
    if (head === '' || tail === '') continue;
    const asOf = parseAsOf(head);
    if (!asOf.ok) continue;
    const span = parseSpan(tail);
    if (span.ok) return { kind: 'window', asOf: asOf.asOf, span: span.span };
    return { kind: 'invalid', message: `${span.message}（范围部分：“${tail}”）` };
  }
  return { kind: 'invalid', message: asOfOnly.message };
}

/** Compose a window from raw user inputs; the first failure names the field. */
export function windowFromInput(asOfText, spanText) {
  const asOf = parseAsOf(asOfText);
  if (!asOf.ok) return { ok: false, field: 'asOf', ...asOf };
  const span = parseSpan(spanText);
  if (!span.ok) return { ok: false, field: 'span', ...span };
  return { ok: true, window: { asOf: asOf.asOf, span: span.span } };
}
