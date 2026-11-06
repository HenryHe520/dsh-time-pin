/**
 * Model-facing and human-facing text for dsh-time-pin.
 *
 * All builders are pure: the text is a function of the window (and, for time
 * facts, of the injected facts) only, so one window always produces
 * byte-identical injection text. That byte stability is what keeps the
 * runtime-context snapshot dedupe intact.
 *
 * @module dsh-time-pin/core/text
 */

import {
  formatAsOfDate,
  formatAsOfDateEn,
  formatSpanZh,
  isFuture,
  normalizeInput,
  parseAsOf,
  parseSpan,
  resolveAsOf,
  subtractSpan,
  toDayNumber,
  today,
} from './window.js';

/** The Chinese echo marker the model must start its first reply with. */
export const ANCHOR_MARKER_ZH = '时间窗：';
/** The English echo marker used when `promptLocale` is `en`. */
export const ANCHOR_MARKER_EN = 'Time window: ';

/** Compact whole-unit duration such as `1m30s` or `2h05m`. */
export function formatDuration(elapsedMs) {
  const seconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (days > 0) return `${days}d${hours > 0 ? ` ${hours}h` : ''}`;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m${String(rest).padStart(2, '0')}s`;
  return `${rest}s`;
}

/** Human span description used in the echo line (`前10年` / `last 10 years`). */
export function echoSpanZh(window) {
  return formatSpanZh(window?.span ?? null);
}

/** English human span description used in the echo line. */
export function echoSpanEn(window) {
  if (window?.span == null) return 'unlimited lookback';
  const { amount, unit } = window.span;
  return `last ${amount} ${unit}${amount === 1 ? '' : 's'}`;
}

/** The exact echo line the model must reproduce; locale-dependent. */
export function anchorLine(window, locale = 'zh') {
  if (locale === 'en') {
    return `${ANCHOR_MARKER_EN}${window?.asOf == null ? 'default' : formatAsOfDateEn(window.asOf)} · ${echoSpanEn(window)}`;
  }
  return `${ANCHOR_MARKER_ZH}${window?.asOf == null ? '默认' : formatAsOfDate(window.asOf)} · ${echoSpanZh(window)}`;
}

/**
 * Whether one echo line confirms the pinned date. A clock-following window
 * (`asOf: null`) accepts `默认` / `default`; the effective today date is also
 * accepted, so a model that expands the placeholder still counts.
 */
function echoAsOfMatches(dateText, window, nowMs) {
  const text = String(dateText ?? '').trim();
  const expected = window?.asOf ?? null;
  if (expected == null) {
    if (/^(?:默认|default)$/iu.test(text)) return true;
    const parsed = parseAsOf(text);
    if (parsed.ok !== true) return false;
    return toDayNumber(parsed.asOf) === toDayNumber(today(nowMs));
  }
  const parsed = parseAsOf(text);
  if (parsed.ok !== true) return false;
  return toDayNumber(parsed.asOf) === toDayNumber(expected);
}

/** Whether one echo line confirms the pinned lookback span. */
function echoSpanMatches(spanText, window) {
  const parsed = parseSpan(String(spanText ?? '').trim());
  if (parsed.ok !== true) return false;
  const expected = window?.span ?? null;
  if (expected == null) return parsed.span == null;
  if (parsed.span == null) return false;
  return parsed.span.unit === expected.unit && parsed.span.amount === expected.amount;
}

/**
 * Whether an assistant reply begins with the required echo line.
 *
 * The check is semantic, not a prefix match: the first line must start with the
 * locale marker, carry the window's exact date (or `默认` / `default` when the
 * window follows the clock), and carry the window's exact span. Date forms the
 * `/pin` parser accepts are tolerated (`2000-01-01` / `2000/01/01` /
 * `2000年1月1日`), and so are unknown spacing and full-width punctuation.
 *
 * @param {unknown} text - assistant reply text.
 * @param {{asOf: object | null, span: object | null} | null} window - evidence window.
 * @param {string} [locale] - `zh` (default) or `en`.
 * @param {number} [nowMs] - reference instant for a clock-following window.
 * @returns {boolean} whether the reply opens with a correct echo.
 */
export function hasAnchorEcho(text, window, locale = 'zh', nowMs = Date.now()) {
  const source = String(text ?? '').trimStart();
  if (source === '') return false;
  const at = Number.isFinite(nowMs) ? nowMs : Date.now();
  const line = normalizeInput(source.split('\n', 1)[0]);
  const marker = locale === 'en' ? 'Time window:' : '时间窗:';
  if (!line.toLowerCase().startsWith(marker.toLowerCase())) return false;
  const payload = line.slice(marker.length).trim();
  const separator = payload.indexOf('·');
  if (separator < 0) return false;
  const dateText = payload.slice(0, separator);
  const spanText = payload.slice(separator + 1);
  return echoAsOfMatches(dateText, window, at) && echoSpanMatches(spanText, window);
}

/** Resolved window bounds rendered as two dates (`null` lower bound → `不限`). */
function boundsText(window, nowMs, locale) {
  const asOf = resolveAsOf(window, nowMs);
  const lower = subtractSpan(asOf, window?.span ?? null);
  const format = locale === 'en' ? formatAsOfDateEn : formatAsOfDate;
  return { lower: lower === null ? null : format(lower), upper: format(asOf) };
}

const UNIT_LABEL_ZH = { day: '天', month: '个月', year: '年' };
const UNIT_LABEL_EN = { day: 'day', month: 'month', year: 'year' };

/** Chinese model-facing window block (the main restricted-mode injection). */
export function windowBlockZh(window, nowMs = Date.now(), options = {}) {
  const { lower, upper } = boundsText(window, nowMs, 'zh');
  const lowerText = lower === null ? '不限（不限制往前多久）' : lower;
  const asOfText = window?.asOf == null ? `默认（本地今天 ${upper}）` : upper;
  const future = isFuture(window, nowMs);
  const spanText =
    window?.span == null ? '不限' : `前${window.span.amount}${UNIT_LABEL_ZH[window.span.unit]}`;
  const lines = [
    '[TIME PIN]',
    `本会话的有效时间（as_of）是 ${asOfText}。`,
    `证据窗口：[${lowerText}, ${upper}]（含端点）。`,
    '规则：',
    '1. 只使用窗口内可获得的事实；来源必须有日期，无日期来源一律视为不可信并排除。',
    '2. 窗口外（更早或更晚）的信息视为未知，不得用来补充结论。',
    '3. 关键结论附来源日期；窗口内没有可用证据时，直接说明，不得编造。',
    `4. 回答开头用一行确认：${anchorLine(window, 'zh')}`,
  ];
  const result = [lines.join('\n')];
  if (future) {
    result.push(
      [
        '[FUTURE VIEW]',
        `as_of 位于未来（${upper}）。你不知道 ${upper} 之后真实发生了什么。`,
        '禁止编造未来事件并当作事实；允许基于现有知识做设定内推演，并明确标注“推演/假设”。',
        `证据窗口仍为 [${lowerText}, ${upper}]；窗口内不存在可验证的来源，任何具体事件都必须标注为假设。`,
      ].join('\n'),
    );
  }
  if (options.anchorReminder === true) {
    result.push(anchorReminderZh(window, nowMs));
  }
  return result.join('\n\n');
}

/** English model-facing window block. */
export function windowBlockEn(window, nowMs = Date.now(), options = {}) {
  const { lower, upper } = boundsText(window, nowMs, 'en');
  const lowerText = lower === null ? 'unbounded' : lower;
  const asOfText = window?.asOf == null ? `default (local today, ${upper})` : upper;
  const future = isFuture(window, nowMs);
  const spanText =
    window?.span == null ? 'unlimited' : `last ${window.span.amount} ${UNIT_LABEL_EN[window.span.unit]}${window.span.amount === 1 ? '' : 's'}`;
  const lines = [
    '[TIME PIN]',
    `The effective time for this conversation (as_of) is ${asOfText}.`,
    `Evidence window: [${lowerText}, ${upper}] (endpoints inclusive).`,
    'Rules:',
    '1. Use only facts obtainable inside the window; a source must carry a date. Undated sources are untrustworthy and are excluded.',
    '2. Information outside the window (earlier or later) is unknown; do not use it to complete a conclusion.',
    '3. Cite source dates for key conclusions; when no usable evidence exists inside the window, say so plainly instead of inventing it.',
    `4. Start your reply with this confirmation line: ${anchorLine(window, 'en')}`,
  ];
  const result = [lines.join('\n')];
  if (future) {
    result.push(
      [
        '[FUTURE VIEW]',
        `as_of lies in the future (${upper}). You do not know what actually happened after ${upper}.`,
        'Do not invent future events and present them as facts; in-universe reasoning from existing knowledge is allowed and must be marked as speculation/assumption.',
        `The evidence window stays [${lowerText}, ${upper}]; it contains no verifiable sources, so every concrete event must be marked as an assumption.`,
      ].join('\n'),
    );
  }
  if (options.anchorReminder === true) {
    result.push(anchorReminderEn(window, nowMs));
  }
  return result.join('\n\n');
}

/** One-line Chinese correction when the echo line is missing. */
export function anchorReminderZh(window, nowMs = Date.now()) {
  const { upper, lower } = boundsText(window, nowMs, 'zh');
  return [
    '[TIME PIN · ANCHOR]',
    `上一段回答没有按约定确认时间窗。请先输出一行：${anchorLine(window, 'zh')}`,
    `然后再用窗口 [${lower ?? '不限'}, ${upper}] 内的带日期证据作答。`,
  ].join('\n');
}

/** One-line English correction when the echo line is missing. */
export function anchorReminderEn(window, nowMs = Date.now()) {
  const { upper, lower } = boundsText(window, nowMs, 'en');
  return [
    '[TIME PIN · ANCHOR]',
    `The previous reply did not confirm the time window. Output this line first: ${anchorLine(window, 'en')}`,
    `Then answer using dated evidence inside [${lower ?? 'unbounded'}, ${upper}].`,
  ].join('\n');
}

/** Chinese `[TIME FACT]` block for background jobs that went quiet. */
export function timeFactBlockZh(facts, nowMs = Date.now()) {
  const lines = ['[TIME FACT]'];
  for (const fact of facts) {
    const silence = fact.silentMs == null ? null : formatDuration(fact.silentMs);
    const total = formatDuration(fact.elapsedMs);
    const label = fact.label === undefined || fact.label === '' ? '后台任务' : `后台任务 ${fact.label}`;
    lines.push(
      `${label}（${fact.jobId}）已运行 ${total}，最后输出在${silence === null ? '任务开始时' : ` ${silence} 前`}，当前仍无新输出。`,
    );
  }
  lines.push('你可以用一句话向用户播报状态；这不是必须的。');
  return lines.join('\n');
}

/** English `[TIME FACT]` block for background jobs that went quiet. */
export function timeFactBlockEn(facts) {
  const lines = ['[TIME FACT]'];
  for (const fact of facts) {
    const silence = fact.silentMs == null ? null : formatDuration(fact.silentMs);
    const total = formatDuration(fact.elapsedMs);
    const label = fact.label === undefined || fact.label === '' ? 'background job' : `background job ${fact.label}`;
    lines.push(
      `${label} (${fact.jobId}) has run for ${total}; its last output was ${silence === null ? 'at start' : `${silence} ago`}; it is still producing nothing.`,
    );
  }
  lines.push('You may report the status to the user in one sentence; this is not mandatory.');
  return lines.join('\n');
}

/** Localized window block for the configured prompt locale. */
export function windowBlock(window, nowMs, locale, options) {
  return locale === 'en'
    ? windowBlockEn(window, nowMs, options)
    : windowBlockZh(window, nowMs, options);
}

/** Localized anchor correction. */
export function anchorReminder(window, nowMs, locale) {
  return locale === 'en' ? anchorReminderEn(window, nowMs) : anchorReminderZh(window, nowMs);
}

/** Localized time-fact block. */
export function timeFactBlock(facts, nowMs, locale) {
  return locale === 'en' ? timeFactBlockEn(facts) : timeFactBlockZh(facts, nowMs);
}

/** Localized one-paragraph status for `/pin` with no arguments and the status tool. */
export function statusSummary(window, nowMs = Date.now(), locale = 'zh') {
  if (window == null) {
    return locale === 'en'
      ? '[TIME PIN] default mode: as_of follows the local clock, lookback is unlimited, no evidence filtering.'
      : '[TIME PIN] 默认模式：as_of 跟随本地时钟，检索范围不限，不做证据过滤。';
  }
  const { lower, upper } = boundsText(window, nowMs, locale);
  const future = isFuture(window, nowMs);
  if (locale === 'en') {
    return [
      `[TIME PIN] restricted mode: ${anchorLine(window, 'en')}`,
      `Window: [${lower ?? 'unbounded'}, ${upper}].`,
      future ? 'Future view: the model does not know this period; answers are speculation.' : '',
    ]
      .filter((line) => line !== '')
      .join('\n');
  }
  return [
    `[TIME PIN] 受限模式：${anchorLine(window, 'zh')}`,
    `证据窗口：[${lower ?? '不限'}, ${upper}]。`,
    future ? '未来视角：模型不知道该时段，回答按设定视角推演。' : '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** Zero-evidence sentence the model should reproduce when the window is empty. */
export function zeroEvidenceText(window, nowMs = Date.now(), locale = 'zh') {
  const label = anchorLine(window, locale).replace(/^[^：:]*[：:]/, '').trim();
  if (locale === 'en') {
    return `No dated, usable evidence was found inside the current time window (${label}). Widen the lookback, change the time point, or switch the window off.`;
  }
  return `按当前时间窗（${label}）没有找到带日期的可用证据。要不要扩大检索范围，或换一个时间点？`;
}

/** `today` helper re-exported for callers that only need date text. */
export { today, formatAsOfDate, formatSpanZh };
