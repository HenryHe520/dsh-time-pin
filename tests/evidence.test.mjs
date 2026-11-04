// Unit tests for the restricted-mode evidence filter: `node --test tests/`.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createEvidencePostExecute,
  filterWebSearchValue,
  parsePublishedAt,
} from '../lib/evidence.js';
import {
  subtractSpan,
  today,
  toDayNumber,
} from '../lib/core/window.js';

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0); // 2026-11-03 12:00 UTC

const CE = (year, month = 1, day = 1) => ({ era: 'ce', year, month, day });
const BCE = (year, month = 1, day = 1) => ({ era: 'bce', year, month, day });

/** Epoch ms of 00:00 UTC for one civil CE date, matching parsePublishedAt. */
const dayOf = (year, month = 1, day = 1) => toDayNumber(CE(year, month, day)) * DAY_MS;

/** Epoch ms of the local civil date of one instant, matching the parser. */
const localDayOf = (instant) => toDayNumber(today(instant)) * DAY_MS;

/** One `web_search` source. */
const source = (publishedAt, slug) => {
  const item = { url: `https://example.test/${slug ?? publishedAt ?? 'undated'}` };
  if (publishedAt !== undefined) item.publishedAt = publishedAt;
  return item;
};

/** A canonical `web_search` output value. */
const webValue = (sources, content) => ({
  ...(content !== undefined ? { content } : {}),
  sources,
  truncated: false,
});

/** The window [1990-01-01, 2000-01-01]. */
const PINNED_1990_2000 = { asOf: CE(2000, 1, 1), span: { unit: 'year', amount: 10 } };

// ---------------------------------------------------------------------------
// parsePublishedAt
// ---------------------------------------------------------------------------

test('parsePublishedAt: absolute ISO forms resolve to the civil day', () => {
  const expected = dayOf(2024, 5, 3);
  for (const text of [
    '2024-05-03',
    '2024-5-3',
    '2024/05/03',
    '2024/5/3',
    '2024-05-03T10:20:30Z',
    '2024-05-03 10:20:30+08:00',
    '2024-05-03T10:20:30.123Z',
    '2024-05-03T00:00',
    '  2024-05-03  ',
    '2024-05-03.',
  ]) {
    assert.equal(parsePublishedAt(text, NOW), expected, text);
  }
});

test('parsePublishedAt: coarse forms default to the start of the period', () => {
  assert.equal(parsePublishedAt('2024-05', NOW), dayOf(2024, 5, 1));
  assert.equal(parsePublishedAt('2024/5', NOW), dayOf(2024, 5, 1));
  assert.equal(parsePublishedAt('2024', NOW), dayOf(2024, 1, 1));
  assert.equal(parsePublishedAt('1999', NOW), dayOf(1999, 1, 1));
});

test('parsePublishedAt: today and yesterday follow the injected clock', () => {
  const todayMs = localDayOf(NOW);
  assert.equal(parsePublishedAt('today', NOW), todayMs);
  assert.equal(parsePublishedAt('Today', NOW), todayMs);
  assert.equal(parsePublishedAt('TODAY', NOW), todayMs);
  assert.equal(
    parsePublishedAt('yesterday', NOW),
    toDayNumber(subtractSpan(today(NOW), { unit: 'day', amount: 1 })) * DAY_MS,
  );
  assert.equal(
    parsePublishedAt('yesterday', NOW + 5 * DAY_MS),
    toDayNumber(subtractSpan(today(NOW + 5 * DAY_MS), { unit: 'day', amount: 1 })) * DAY_MS,
  );
});

test('parsePublishedAt: English relative ages use calendar arithmetic', () => {
  const base = today(NOW);
  const cases = [
    ['0 days ago', subtractSpan(base, { unit: 'day', amount: 0 })],
    ['3 days ago', subtractSpan(base, { unit: 'day', amount: 3 })],
    ['2 weeks ago', subtractSpan(base, { unit: 'day', amount: 14 })],
    ['1 month ago', subtractSpan(base, { unit: 'month', amount: 1 })],
    ['6 months ago', subtractSpan(base, { unit: 'month', amount: 6 })],
    ['2 years ago', subtractSpan(base, { unit: 'year', amount: 2 })],
    ['one day ago', subtractSpan(base, { unit: 'day', amount: 1 })],
    ['a day ago', subtractSpan(base, { unit: 'day', amount: 1 })],
    ['an hour ago', today(NOW - 3_600_000)],
    ['a minute ago', today(NOW - 60_000)],
    ['5 hours ago', today(NOW - 5 * 3_600_000)],
    ['90 minutes ago', today(NOW - 90 * 60_000)],
  ];
  for (const [text, civil] of cases) {
    assert.equal(parsePublishedAt(text, NOW), toDayNumber(civil) * DAY_MS, text);
  }
});

test('parsePublishedAt: anything unparseable is undated (null)', () => {
  for (const text of [
    undefined,
    null,
    '',
    '   ',
    'abc',
    '3 days',
    'days ago',
    'May 3, 2024',
    '2024-02-30',
    '2026-13-01',
    '2026-01-32',
    '0000',
    '12345',
    '2024-05-03T10:20:30+0800 extra',
    'yesterday at noon',
    '3 fortnights ago',
    20240503,
    {},
    [],
  ]) {
    assert.equal(parsePublishedAt(text, NOW), null, String(text));
  }
});

test('parsePublishedAt: result is always a whole civil day instant', () => {
  for (const text of ['2024-05-03', '2024', 'today', 'yesterday', '3 days ago']) {
    const value = parsePublishedAt(text, NOW);
    assert.equal(typeof value, 'number', text);
    assert.equal(Number.isInteger(value / DAY_MS), true, text);
    assert.equal(((value % DAY_MS) + DAY_MS) % DAY_MS, 0, text);
  }
});

// ---------------------------------------------------------------------------
// filterWebSearchValue
// ---------------------------------------------------------------------------

test('filterWebSearchValue: endpoints are inclusive and the value stays identical', () => {
  const value = webValue(
    [source('1990-01-01', 'lower'), source('1995-06-01', 'middle'), source('2000-01-01', 'upper')],
    'three dated sources',
  );
  const result = filterWebSearchValue(value, PINNED_1990_2000, NOW);
  assert.equal(result.value, value, 'identity must be preserved when nothing is filtered');
  assert.equal(result.kept, 3);
  assert.equal(result.excludedUndated, 0);
  assert.equal(result.excludedOutside, 0);
});

test('filterWebSearchValue: drops out-of-window and undated sources with an exact note', () => {
  const value = webValue(
    [
      source('1989-12-31', 'too-old'),
      source('2000-01-02', 'too-new'),
      source(undefined, 'undated'),
      source('not a date', 'garbage'),
      source('1995-06-01', 'kept'),
    ],
    'Provider answer.',
  );
  const result = filterWebSearchValue(value, PINNED_1990_2000, NOW);
  assert.notEqual(result.value, value);
  assert.equal(result.kept, 1);
  assert.equal(result.excludedUndated, 2);
  assert.equal(result.excludedOutside, 2);
  assert.equal(result.value.sources.length, 1);
  assert.equal(result.value.sources[0].url, 'https://example.test/kept');
  assert.equal(result.value.truncated, false);
  assert.equal(
    result.value.content,
    'Provider answer.\n[TIME PIN] 已排除 2 条无日期来源、2 条窗口外来源（时间窗 1990-01-01 至 2000-01-01）。',
  );
});

test('filterWebSearchValue: creates content when the provider answer is absent', () => {
  const value = webValue([source('2020-01-01', 'outside'), source('1995-01-01', 'kept')]);
  const result = filterWebSearchValue(value, PINNED_1990_2000, NOW);
  assert.equal(
    result.value.content,
    '[TIME PIN] 已排除 0 条无日期来源、1 条窗口外来源（时间窗 1990-01-01 至 2000-01-01）。',
  );
});

test('filterWebSearchValue: zero usable evidence gets the explicit note', () => {
  const value = webValue(
    [source(undefined, 'undated'), source('2020-01-01', 'outside')],
    'Provider answer that must not be trusted.',
  );
  const result = filterWebSearchValue(value, PINNED_1990_2000, NOW);
  assert.equal(result.kept, 0);
  assert.deepEqual(result.value.sources, []);
  assert.equal(typeof result.value.content, 'string');
  assert.match(result.value.content, /按当前时间窗没有带日期的可用证据/);
  assert.match(result.value.content, /已排除 1 条无日期来源、1 条窗口外来源/);
  assert.match(result.value.content, /1990-01-01 至 2000-01-01/);
  assert.doesNotMatch(result.value.content, /Provider answer/);
});

test('filterWebSearchValue: is byte-stable across repeated calls', () => {
  const value = webValue(
    [source('1980-01-01', 'outside'), source('1995-01-01', 'kept'), source(undefined, 'undated')],
    'Answer.',
  );
  const first = filterWebSearchValue(value, PINNED_1990_2000, NOW);
  const second = filterWebSearchValue(value, PINNED_1990_2000, NOW);
  assert.deepEqual(first, second);
  assert.equal(first.value.content, second.value.content);
  // Filtering the already-filtered value again changes nothing.
  const third = filterWebSearchValue(first.value, PINNED_1990_2000, NOW);
  assert.equal(third.value, first.value);
});

test('filterWebSearchValue: unrestricted windows leave the value untouched', () => {
  const value = webValue([source(undefined, 'undated'), source('2020-01-01', 'outside')]);
  assert.equal(filterWebSearchValue(value, null, NOW).value, value);
  assert.equal(filterWebSearchValue(value, { asOf: null, span: null }, NOW).value, value);
  assert.equal(filterWebSearchValue(value, undefined, NOW).value, value);
});

test('filterWebSearchValue: malformed values are returned unchanged', () => {
  for (const value of [null, undefined, 'text', 42, {}, { sources: 'nope' }]) {
    const result = filterWebSearchValue(value, PINNED_1990_2000, NOW);
    assert.equal(result.value, value);
    assert.equal(result.excludedUndated, 0);
    assert.equal(result.excludedOutside, 0);
  }
});

test('filterWebSearchValue: relative dates resolve against the injected clock', () => {
  const relativeWindow = { asOf: today(NOW), span: { unit: 'day', amount: 7 } };
  const value = webValue([
    source('3 days ago', 'three-days'),
    source('7 days ago', 'seven-days'),
    source('8 days ago', 'eight-days'),
  ]);
  const result = filterWebSearchValue(value, relativeWindow, NOW);
  assert.equal(result.kept, 2);
  assert.equal(result.excludedOutside, 1);
  assert.deepEqual(
    result.value.sources.map((entry) => entry.url),
    ['https://example.test/three-days', 'https://example.test/seven-days'],
  );
  assert.match(result.value.content, /已排除 0 条无日期来源、1 条窗口外来源/);
});

test('filterWebSearchValue: a past pin without a span drops only later evidence', () => {
  const value = webValue([
    source('1900-01-01', 'old-but-allowed'),
    source('1999-12-31', 'in'),
    source('2001-01-01', 'future'),
  ]);
  const result = filterWebSearchValue(value, { asOf: CE(2000, 1, 1), span: null }, NOW);
  assert.deepEqual(
    result.value.sources.map((entry) => entry.url),
    ['https://example.test/old-but-allowed', 'https://example.test/in'],
  );
  assert.equal(
    result.value.content,
    '[TIME PIN] 已排除 0 条无日期来源、1 条窗口外来源（时间窗 不限 至 2000-01-01）。',
  );
});

test('filterWebSearchValue: BCE windows label their range correctly', () => {
  const value = webValue([source('1995-01-01', 'ce-source')]);
  const result = filterWebSearchValue(
    value,
    { asOf: BCE(200, 1, 1), span: { unit: 'year', amount: 20 } },
    NOW,
  );
  assert.equal(result.kept, 0);
  assert.match(result.value.content, /公元前220年 至 公元前200年/);
});

test('filterWebSearchValue: future as-of still enforces the upper bound', () => {
  const value = webValue([
    source('2026-01-01', 'before-the-lookback'),
    source('2995-01-01', 'inside-future-window'),
    source('3001-01-01', 'beyond-as-of'),
  ]);
  const result = filterWebSearchValue(
    value,
    { asOf: CE(3000, 1, 1), span: { unit: 'year', amount: 10 } },
    NOW,
  );
  assert.equal(result.kept, 1);
  assert.equal(result.excludedOutside, 2);
  assert.equal(result.value.sources[0].url, 'https://example.test/inside-future-window');
});

// ---------------------------------------------------------------------------
// createEvidencePostExecute
// ---------------------------------------------------------------------------

/** Build the listener plus a shared call log. */
function makeListener(getWindow, now = () => NOW) {
  const calls = [];
  const listener = createEvidencePostExecute({ getWindow, now });
  return { listener, calls };
}

/** A successful web_search result object. */
function searchResult(value) {
  return { isError: false, value, content: [{ type: 'text', text: 'rendered' }] };
}

test('createEvidencePostExecute: requires getWindow', () => {
  assert.throws(() => createEvidencePostExecute(), TypeError);
  assert.throws(() => createEvidencePostExecute({}), TypeError);
});

test('createEvidencePostExecute: calls next() before inspecting anything', async () => {
  const order = [];
  const listener = createEvidencePostExecute({
    getWindow: () => {
      order.push('getWindow');
      return PINNED_1990_2000;
    },
    now: () => NOW,
  });
  const exec = { name: 'web_search', agent: { id: 'session-1' } };
  const result = searchResult(webValue([source(undefined, 'undated')]));
  const decision = await listener(exec, result, async () => {
    order.push('next');
    return { kind: 'accept' };
  });
  assert.deepEqual(order, ['next', 'getWindow']);
  assert.equal(decision.kind, 'accept');
  assert.deepEqual(decision.value.sources, []);
});

test('createEvidencePostExecute: passes every non-web_search call through', async () => {
  const { listener } = makeListener(() => PINNED_1990_2000);
  const nextDecision = { kind: 'accept', additionalContexts: [] };
  const result = searchResult(webValue([source('2020-01-01', 'outside')]));
  for (const exec of [
    { name: 'web_fetch', agent: { id: 's' } },
    { name: 'web_search' }, // no agent
    null,
    {},
  ]) {
    const decision = await listener(exec, result, async () => nextDecision);
    assert.equal(decision, nextDecision);
  }
});

test('createEvidencePostExecute: unrestricted sessions keep the next decision', async () => {
  const { listener, calls } = makeListener((agent) => {
    calls.push(agent);
    return null;
  });
  const exec = { name: 'web_search', agent: { id: 'session-1' } };
  const result = searchResult(webValue([source(undefined, 'undated')]));
  const nextDecision = { kind: 'accept' };
  const decision = await listener(exec, result, async () => nextDecision);
  assert.equal(decision, nextDecision);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], exec.agent, 'getWindow receives the exec agent');
});

test('createEvidencePostExecute: an unchanged value keeps the next decision', async () => {
  const { listener } = makeListener(() => PINNED_1990_2000);
  const nextDecision = { kind: 'accept' };
  const result = searchResult(webValue([source('1995-01-01', 'kept')]));
  const decision = await listener(
    { name: 'web_search', agent: { id: 's' } },
    result,
    async () => nextDecision,
  );
  assert.equal(decision, nextDecision);
});

test('createEvidencePostExecute: restricted sessions get the filtered value', async () => {
  const { listener } = makeListener(() => PINNED_1990_2000);
  const value = webValue([
    source('1995-01-01', 'kept'),
    source('2020-01-01', 'outside'),
    source(undefined, 'undated'),
  ]);
  const exec = { name: 'web_search', agent: { id: 'session-1' } };
  const decision = await listener(exec, searchResult(value), async () => ({ kind: 'accept' }));
  assert.equal(decision.kind, 'accept');
  assert.notEqual(decision.value, value);
  assert.deepEqual(
    decision.value.sources.map((entry) => entry.url),
    ['https://example.test/kept'],
  );
  assert.equal(decision.value.truncated, false);
  assert.match(decision.value.content, /\[TIME PIN\]/);
});

test('createEvidencePostExecute: passes through failed results and block decisions', async () => {
  const { listener } = makeListener(() => PINNED_1990_2000);
  const exec = { name: 'web_search', agent: { id: 'session-1' } };
  const value = webValue([source(undefined, 'undated')]);

  const failed = { isError: true, value: undefined, content: [{ type: 'text', text: 'boom' }] };
  const passthrough = await listener(exec, failed, async () => ({ kind: 'accept' }));
  assert.equal(passthrough.kind, 'accept');

  const blocked = { kind: 'block', feedback: [{ type: 'text', text: 'denied' }] };
  const blockedDecision = await listener(exec, searchResult(value), async () => blocked);
  assert.equal(blockedDecision, blocked);

  const contentReplaced = {
    kind: 'accept',
    content: [{ type: 'text', text: 'replaced by another policy' }],
  };
  const respected = await listener(exec, searchResult(value), async () => contentReplaced);
  assert.equal(respected, contentReplaced);
});

test('createEvidencePostExecute: carries additionalContexts from the next decision', async () => {
  const { listener } = makeListener(() => PINNED_1990_2000);
  const context = { role: 'user', content: 'pending question' };
  const decision = await listener(
    { name: 'web_search', agent: { id: 's' } },
    searchResult(webValue([source(undefined, 'undated')])),
    async () => ({ kind: 'accept', additionalContexts: [context] }),
  );
  assert.equal(decision.kind, 'accept');
  assert.deepEqual(decision.additionalContexts, [context]);
  assert.deepEqual(decision.value.sources, []);
});

test('createEvidencePostExecute: a throwing getWindow never breaks the search', async () => {
  const { listener } = makeListener(() => {
    throw new Error('projection unavailable');
  });
  const nextDecision = { kind: 'accept' };
  const decision = await listener(
    { name: 'web_search', agent: { id: 's' } },
    searchResult(webValue([source(undefined, 'undated')])),
    async () => nextDecision,
  );
  assert.equal(decision, nextDecision);
});

test('createEvidencePostExecute: malformed exec/result payloads pass through', async () => {
  const { listener } = makeListener(() => PINNED_1990_2000);
  const nextDecision = { kind: 'accept' };
  for (const [exec, result] of [
    [{ name: 'web_search', agent: { id: 's' } }, null],
    [{ name: 'web_search', agent: { id: 's' } }, { isError: false, value: 'text' }],
    [{ name: 'web_search', agent: { id: 's' } }, { isError: false, value: { sources: null } }],
  ]) {
    const decision = await listener(exec, result, async () => nextDecision);
    assert.equal(decision, nextDecision);
  }
});
