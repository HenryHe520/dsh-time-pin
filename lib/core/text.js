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
  addSpan,
  formatAsOfDate,
  formatAsOfDateEn,
  formatRangeEn,
  formatRangeZh,
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

/** Chinese range description used in the echo line (`前后各10年` / `前10年/后5年`). */
export function echoRangeZh(window) {
  return formatRangeZh(window);
}

/** English range description used in the echo line (`±10 years` / `last 10 years / next 5 years`). */
export function echoRangeEn(window) {
  return formatRangeEn(window);
}

/** The exact echo line the model must reproduce; locale-dependent. */
export function anchorLine(window, locale = 'zh') {
  if (locale === 'en') {
    return `${ANCHOR_MARKER_EN}${window?.asOf == null ? 'default' : formatAsOfDateEn(window.asOf)} · ${echoRangeEn(window)}`;
  }
  return `${ANCHOR_MARKER_ZH}${window?.asOf == null ? '默认' : formatAsOfDate(window.asOf)} · ${echoRangeZh(window)}`;
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

/** Parse one zh range side: `前10年` / `后5年` / `不限`. `undefined` = invalid. */
function parseZhRangeSide(text) {
  const t = text.trim();
  if (t === '不限') return { side: null, span: null };
  const match = /^(前|后)\s*(.*)$/u.exec(t);
  if (match === null) return undefined;
  const rest = match[2].trim();
  if (rest === '') return undefined;
  const parsed = rest === '不限' ? { ok: true, span: null } : parseSpan(rest);
  if (parsed.ok !== true) return undefined;
  return { side: match[1] === '后' ? 'after' : 'before', span: parsed.span };
}

/** Parse one en range side: `last 10 years` / `next 5 years` / `unbounded`. */
function parseEnRangeSide(text) {
  const t = text.trim();
  if (t.toLowerCase() === 'unbounded') return { side: null, span: null };
  const match = /^(last|past|before|next|after|future)\s+(.+)$/i.exec(t);
  if (match === null) return undefined;
  const parsed = parseSpan(match[2].trim());
  if (parsed.ok !== true) return undefined;
  const word = match[1].toLowerCase();
  return {
    side: word === 'next' || word === 'after' || word === 'future' ? 'after' : 'before',
    span: parsed.span,
  };
}

/** Whether two optional spans are the same magnitude (null === unbounded). */
function sameSpan(left, right) {
  if (left === null || right === null) return left === right;
  return left.unit === right.unit && left.amount === right.amount;
}

/**
 * Parse the echo's range segment into `{before, after}`, or `null` when it is
 * not a range the plugin itself would print.
 */
function parseEchoRange(text, locale) {
  const raw = String(text ?? '').trim();
  if (raw === '') return null;
  const normalized = normalizeInput(raw);
  const isEnglish = locale === 'en';
  if (isEnglish) {
    if (normalized.toLowerCase() === 'unlimited') return { before: null, after: null };
    const symmetric = /^[±+\-]{1,2}\s*(.+)$/u.exec(normalized);
    if (symmetric !== null) {
      const parsed = parseSpan(symmetric[1]);
      if (parsed.ok !== true) return null;
      return { before: parsed.span, after: parsed.span };
    }
    const parts = normalized.split('/').map((part) => part.trim());
    if (parts.length !== 2) return null;
    const first = parseEnRangeSide(parts[0]);
    const second = parseEnRangeSide(parts[1]);
    if (first === undefined || second === undefined) return null;
    if (first.side === 'after' && second.side === 'before') {
      return { before: second.span, after: first.span };
    }
    return { before: first.span, after: second.span };
  }
  if (normalized === '不限') return { before: null, after: null };
  const symmetricZh = /^前后各\s*(.+)$/u.exec(normalized);
  if (symmetricZh !== null) {
    const parsed = parseSpan(symmetricZh[1]);
    if (parsed.ok !== true) return null;
    return { before: parsed.span, after: parsed.span };
  }
  const parts = normalized.split('/').map((part) => part.trim());
  if (parts.length !== 2) return null;
  const first = parseZhRangeSide(parts[0]);
  const second = parseZhRangeSide(parts[1]);
  if (first === undefined || second === undefined) return null;
  if (first.side === 'after' && second.side === 'before') {
    return { before: second.span, after: first.span };
  }
  return { before: first.span, after: second.span };
}

/** Whether the echoed range segment confirms the window's before/after sides. */
function echoRangeMatches(text, window, locale) {
  const parsed = parseEchoRange(text, locale);
  if (parsed === null) return false;
  const before = window?.before ?? null;
  const after = window?.after ?? null;
  return sameSpan(parsed.before, before) && sameSpan(parsed.after, after);
}

/**
 * Whether an assistant reply begins with the required echo line.
 *
 * The check is semantic, not a prefix match: the first line must start with the
 * locale marker, carry the window's exact date (or `默认` / `default` when the
 * window follows the clock), and carry the window's exact before/after range.
 * Date forms the `/pin` parser accepts are tolerated (`2000-01-01` /
 * `2000/01/01` / `2000年1月1日`), and so are unknown spacing and full-width
 * punctuation.
 *
 * @param {unknown} text - assistant reply text.
 * @param {{asOf: object | null, before: object | null, after: object | null} | null} window
 *   evidence window.
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
  const rangeText = payload.slice(separator + 1);
  return echoAsOfMatches(dateText, window, at) && echoRangeMatches(rangeText, window, locale);
}

/** Resolved window bounds rendered as two dates (`null` side → unbounded). */
function boundsText(window, nowMs, locale) {
  const base = resolveAsOf(window, nowMs);
  const lowerDate = subtractSpan(base, window?.before ?? null);
  const upperDate = addSpan(base, window?.after ?? null);
  const format = locale === 'en' ? formatAsOfDateEn : formatAsOfDate;
  return {
    lower: lowerDate === null ? null : format(lowerDate),
    upper: upperDate === null ? null : format(upperDate),
  };
}

/** Human range description (`前10年 / 后5年`), with a readable fallback. */
function describeRangeZh(window) {
  if ((window?.before ?? null) === null && (window?.after ?? null) === null) {
    return '不限（两个方向都不设边界）';
  }
  return formatRangeZh(window).replace('/', ' / ');
}

/** Human range description in English. */
function describeRangeEn(window) {
  if ((window?.before ?? null) === null && (window?.after ?? null) === null) {
    return 'unlimited (no boundary in either direction)';
  }
  return formatRangeEn(window);
}

/** Chinese model-facing window block (the main restricted-mode injection). */
export function windowBlockZh(window, nowMs = Date.now(), options = {}) {
  const { lower, upper } = boundsText(window, nowMs, 'zh');
  const lowerText = lower === null ? '不限（不限制往前多久）' : lower;
  const upperText = upper === null ? '不限（不限制往后多久）' : upper;
  const asOfText =
    window?.asOf == null
      ? `默认（本地今天 ${formatAsOfDate(resolveAsOf(window, nowMs))}）`
      : formatAsOfDate(window.asOf);
  const future = isFuture(window, nowMs);
  const lines = [
    '[TIME PIN]',
    `本会话的有效时间（as_of）是 ${asOfText}。`,
    `检索范围：${describeRangeZh(window)}。`,
    `证据窗口：[${lowerText}, ${upperText}]（含端点）。`,
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
        `证据窗口上界是 ${upper === null ? '不限' : upper}，它超出今天；超出今天的部分你不知道真实发生了什么。`,
        '禁止编造未来事件并当作事实；允许基于现有知识做设定内推演，并明确标注“推演/假设”。',
        '窗口内日期晚于今天的来源只能当作假设，不得当作事实。',
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
  const lowerText = lower === null ? 'unbounded (no limit into the past)' : lower;
  const upperText = upper === null ? 'unbounded (no limit into the future)' : upper;
  const asOfText =
    window?.asOf == null
      ? `default (local today, ${formatAsOfDateEn(resolveAsOf(window, nowMs))})`
      : formatAsOfDateEn(window.asOf);
  const future = isFuture(window, nowMs);
  const lines = [
    '[TIME PIN]',
    `The effective time for this conversation (as_of) is ${asOfText}.`,
    `Retrieval range: ${describeRangeEn(window)}.`,
    `Evidence window: [${lowerText}, ${upperText}] (endpoints inclusive).`,
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
        `The window's upper bound is ${upper === null ? 'unbounded' : upper}, which lies after today; you do not know what actually happens beyond today.`,
        'Do not invent future events and present them as facts; in-universe reasoning from existing knowledge is allowed and must be marked as speculation/assumption.',
        'Sources dated after today are assumptions, never facts.',
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
  const { lower, upper } = boundsText(window, nowMs, 'zh');
  return [
    '[TIME PIN · ANCHOR]',
    `上一段回答没有按约定确认时间窗。请先输出一行：${anchorLine(window, 'zh')}`,
    `然后再用窗口 [${lower ?? '不限'}, ${upper ?? '不限'}] 内的带日期证据作答。`,
  ].join('\n');
}

/** One-line English correction when the echo line is missing. */
export function anchorReminderEn(window, nowMs = Date.now()) {
  const { lower, upper } = boundsText(window, nowMs, 'en');
  return [
    '[TIME PIN · ANCHOR]',
    `The previous reply did not confirm the time window. Output this line first: ${anchorLine(window, 'en')}`,
    `Then answer using dated evidence inside [${lower ?? 'unbounded'}, ${upper ?? 'unbounded'}].`,
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
      ? '[TIME PIN] default mode: as_of follows the local clock, range is unlimited, no evidence filtering.'
      : '[TIME PIN] 默认模式：as_of 跟随本地时钟，检索范围不限，不做证据过滤。';
  }
  const { lower, upper } = boundsText(window, nowMs, locale);
  const future = isFuture(window, nowMs);
  if (locale === 'en') {
    return [
      `[TIME PIN] restricted mode: ${anchorLine(window, 'en')}`,
      `Window: [${lower ?? 'unbounded'}, ${upper ?? 'unbounded'}].`,
      future ? 'Future view: the model does not know this period; answers are speculation.' : '',
    ]
      .filter((line) => line !== '')
      .join('\n');
  }
  return [
    `[TIME PIN] 受限模式：${anchorLine(window, 'zh')}`,
    `证据窗口：[${lower ?? '不限'}, ${upper ?? '不限'}]。`,
    future ? '未来视角：模型不知道该时段，回答按设定视角推演。' : '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** Zero-evidence sentence the model should reproduce when the window is empty. */
export function zeroEvidenceText(window, nowMs = Date.now(), locale = 'zh') {
  const label = anchorLine(window, locale).replace(/^[^：:]*[：:]/, '').trim();
  if (locale === 'en') {
    return `No dated, usable evidence was found inside the current time window (${label}). Widen the range, change the time point, or switch the window off.`;
  }
  return `按当前时间窗（${label}）没有找到带日期的可用证据。要不要调整检索范围，或换一个时间点？`;
}

/** `today` helper re-exported for callers that only need date text. */
export { today, formatAsOfDate, formatSpanZh };
