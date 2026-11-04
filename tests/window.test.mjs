// Unit tests for the pure window model: `node --test tests/*.test.mjs`.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  asOfFromKey,
  asOfKey,
  daysInMonth,
  dayInWindow,
  formatAsOfDate,
  formatSpanZh,
  formatWindowLabelZh,
  fromDayNumber,
  isFuture,
  isRestricted,
  parseAsOf,
  parsePinArgs,
  parseSpan,
  resolveAsOf,
  spanFromKey,
  spanKey,
  subtractSpan,
  toDayNumber,
  today,
  windowFromInput,
  windowMode,
  windowSignature,
} from '../lib/core/window.js';

const CE = (year, month = 1, day = 1) => ({ era: 'ce', year, month, day });
const BCE = (year, month = 1, day = 1) => ({ era: 'bce', year, month, day });
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0); // 2026-11-03

test('day numbers: epoch and round trip', () => {
  assert.equal(toDayNumber(CE(1970, 1, 1)), 0);
  for (const date of [CE(1, 1, 1), CE(2000, 2, 29), CE(2026, 11, 3), BCE(1), BCE(200), BCE(9999, 12, 31)]) {
    assert.deepEqual(fromDayNumber(toDayNumber(date)), date, JSON.stringify(date));
  }
});

test('leap years and month lengths are proleptic Gregorian', () => {
  assert.equal(daysInMonth(2000, 2), 29);
  assert.equal(daysInMonth(1900, 2), 28);
  assert.equal(daysInMonth(2024, 2), 29);
  assert.equal(daysInMonth(0, 2), 29); // 1 BC = astronomical year 0
  assert.equal(daysInMonth(-4, 2), 29); // 5 BC = astronomical year -4
  assert.equal(daysInMonth(-3, 2), 28); // 4 BC = astronomical year -3
});

test('parseAsOf accepts every documented format', () => {
  const cases = [
    ['2000', CE(2000)],
    ['2000-01-01', CE(2000)],
    ['2000-1-1', CE(2000)],
    ['2000/01/01', CE(2000)],
    ['2000年1月1日', CE(2000)],
    ['2000年1月1', CE(2000)],
    ['公元2000年', CE(2000)],
    ['３０００', CE(3000)],
    ['公元前200年', BCE(200)],
    ['前200年', BCE(200)],
    ['BC 200', BCE(200)],
    ['公元前200年3月5日', BCE(200, 3, 5)],
  ];
  for (const [input, expected] of cases) {
    const result = parseAsOf(input);
    assert.equal(result.ok, true, input);
    assert.deepEqual(result.asOf, expected, input);
  }
});

test('parseAsOf rejects invalid dates with actionable codes', () => {
  for (const [input, code] of [
    ['2026-02-30', 'invalid_day'],
    ['2026-13-01', 'invalid_month'],
    ['2026-01-32', 'invalid_day'],
    ['公元前0年', 'bce_zero'],
    ['abc', 'invalid_format'],
    ['', 'empty'],
    ['10000', 'out_of_range'],
  ]) {
    const result = parseAsOf(input);
    assert.equal(result.ok, false, input);
    assert.equal(result.code, code, input);
  }
});

test('parseSpan covers day/month/year and unlimited', () => {
  assert.deepEqual(parseSpan('不限'), { ok: true, span: null });
  assert.deepEqual(parseSpan(''), { ok: true, span: null });
  assert.deepEqual(parseSpan('-'), { ok: true, span: null });
  assert.deepEqual(parseSpan('7天'), { ok: true, span: { unit: 'day', amount: 7 } });
  assert.deepEqual(parseSpan('30 天'), { ok: true, span: { unit: 'day', amount: 30 } });
  assert.deepEqual(parseSpan('6个月'), { ok: true, span: { unit: 'month', amount: 6 } });
  assert.deepEqual(parseSpan('10年'), { ok: true, span: { unit: 'year', amount: 10 } });
  assert.deepEqual(parseSpan('100年'), { ok: true, span: { unit: 'year', amount: 100 } });
  assert.deepEqual(parseSpan('7d'), { ok: true, span: { unit: 'day', amount: 7 } });
  for (const bad of ['0天', '-1年', '10光年', 'abc']) {
    assert.equal(parseSpan(bad).ok, false, bad);
  }
});

test('subtractSpan uses calendar months and years', () => {
  assert.deepEqual(subtractSpan(CE(2000), { unit: 'year', amount: 10 }), CE(1990));
  assert.deepEqual(subtractSpan(CE(2000, 3, 31), { unit: 'month', amount: 1 }), CE(2000, 2, 29));
  assert.deepEqual(subtractSpan(CE(2000), { unit: 'day', amount: 1 }), CE(1999, 12, 31));
  assert.deepEqual(subtractSpan(BCE(200), { unit: 'year', amount: 20 }), BCE(220));
  assert.deepEqual(subtractSpan(BCE(1), { unit: 'year', amount: 1 }), BCE(2));
  assert.deepEqual(subtractSpan(CE(1), { unit: 'year', amount: 1 }), BCE(1));
  assert.equal(subtractSpan(CE(2000), null), null);
});

test('window bounds are inclusive at both ends', () => {
  const window = { asOf: CE(2000), span: { unit: 'year', amount: 10 } };
  assert.equal(dayInWindow(toDayNumber(CE(1990)), window, NOW), true);
  assert.equal(dayInWindow(toDayNumber(CE(2000)), window, NOW), true);
  assert.equal(dayInWindow(toDayNumber(CE(1989, 12, 31)), window, NOW), false);
  assert.equal(dayInWindow(toDayNumber(CE(2000, 1, 2)), window, NOW), false);
});

test('default window follows the clock and stays unrestricted', () => {
  assert.equal(isRestricted(null), false);
  assert.deepEqual(resolveAsOf(null, NOW), today(NOW));
  assert.equal(windowSignature(null, NOW), 'default');
  assert.equal(windowMode(null, NOW), 'default');
  assert.equal(formatWindowLabelZh(null, NOW), '默认 · 不限');
});

test('signature is stable for one window and changes only with the window', () => {
  const window = { asOf: CE(2000), span: { unit: 'year', amount: 10 } };
  assert.equal(windowSignature(window, NOW), windowSignature(structuredClone(window), NOW));
  assert.equal(windowSignature(window, NOW), 'ce:2000-01-01|10y');
  const todayWindow = { asOf: null, span: { unit: 'day', amount: 7 } };
  assert.equal(windowSignature(todayWindow, NOW), 'today:ce:2026-11-03|7d');
  assert.equal(isRestricted(todayWindow), true);
  assert.equal(formatWindowLabelZh(todayWindow, NOW), '默认 · 近7天');
});

test('future, past and label modes', () => {
  const future = { asOf: CE(3000), span: null };
  assert.equal(isFuture(future, NOW), true);
  assert.equal(windowMode(future, NOW), 'future');
  assert.equal(formatWindowLabelZh(future, NOW), '3000-01-01 · 不限');
  const past = { asOf: CE(2000), span: { unit: 'year', amount: 10 } };
  assert.equal(windowMode(past, NOW), 'past');
  assert.equal(formatWindowLabelZh(past, NOW), '2000-01-01 · 前10年');
});

test('BCE labels and window math', () => {
  assert.equal(formatAsOfDate(BCE(200)), '公元前200年');
  assert.equal(formatAsOfDate(BCE(200, 3, 5)), '公元前200年3月5日');
  assert.equal(formatSpanZh({ unit: 'year', amount: 20 }), '前20年');
  const window = { asOf: BCE(200), span: { unit: 'year', amount: 20 } };
  assert.equal(formatWindowLabelZh(window, NOW), '公元前200年 · 前20年');
  assert.equal(dayInWindow(toDayNumber(BCE(220)), window, NOW), true);
  assert.equal(dayInWindow(toDayNumber(CE(1)), window, NOW), false);
});

test('storage keys round trip', () => {
  for (const asOf of [CE(2000), BCE(200), CE(1, 12, 31)]) {
    assert.deepEqual(asOfFromKey(asOfKey(asOf)), asOf);
  }
  for (const span of [null, { unit: 'day', amount: 7 }, { unit: 'month', amount: 6 }, { unit: 'year', amount: 100 }]) {
    assert.deepEqual(spanFromKey(spanKey(span)), span);
  }
  assert.equal(asOfFromKey('nope'), null);
  assert.equal(spanFromKey('nope'), null);
});

test('windowFromInput names the failing field', () => {
  assert.deepEqual(windowFromInput('2000-01-01', '10年'), {
    ok: true,
    window: { asOf: CE(2000), span: { unit: 'year', amount: 10 } },
  });
  assert.equal(windowFromInput('2026-02-30', '10年').field, 'asOf');
  assert.equal(windowFromInput('2000-01-01', '0天').field, 'span');
});

test('parsePinArgs implements the /pin grammar', () => {
  assert.deepEqual(parsePinArgs(''), { kind: 'status' });
  assert.deepEqual(parsePinArgs('  '), { kind: 'status' });
  assert.deepEqual(parsePinArgs('off'), { kind: 'off' });
  assert.deepEqual(parsePinArgs('清空'), { kind: 'off' });
  assert.deepEqual(parsePinArgs('2000-01-01'), { kind: 'asOf', asOf: CE(2000) });
  assert.deepEqual(parsePinArgs('2000'), { kind: 'asOf', asOf: CE(2000) });
  assert.deepEqual(parsePinArgs('2000-01-01 10年'), {
    kind: 'window',
    asOf: CE(2000),
    span: { unit: 'year', amount: 10 },
  });
  assert.deepEqual(parsePinArgs('公元前200年 前20年'), {
    kind: 'window',
    asOf: BCE(200),
    span: { unit: 'year', amount: 20 },
  });
  assert.deepEqual(parsePinArgs('BC 200 20 years'), {
    kind: 'window',
    asOf: BCE(200),
    span: { unit: 'year', amount: 20 },
  });
  assert.deepEqual(parsePinArgs('3000 不限'), {
    kind: 'window',
    asOf: CE(3000),
    span: null,
  });
  // A span alone pins the clock to "today" and keeps a finite lookback.
  assert.deepEqual(parsePinArgs('7天'), {
    kind: 'span',
    span: { unit: 'day', amount: 7 },
  });
  assert.deepEqual(parsePinArgs('30天'), {
    kind: 'span',
    span: { unit: 'day', amount: 30 },
  });
  assert.deepEqual(parsePinArgs('不限'), { kind: 'span', span: null });
  assert.equal(parsePinArgs('2000-01-01 0天').kind, 'invalid');
  assert.equal(parsePinArgs('abc').kind, 'invalid');
});
