// Unit tests for the anchor-echo validator: `node --test tests/`.
import test from 'node:test';
import assert from 'node:assert/strict';

import { anchorLine, hasAnchorEcho } from '../lib/core/text.js';
import {
  formatAsOfDate,
  subtractSpan,
  today,
} from '../lib/core/window.js';

const CE = (year, month = 1, day = 1) => ({ era: 'ce', year, month, day });
const BCE = (year, month = 1, day = 1) => ({ era: 'bce', year, month, day });

const TEN = { unit: 'year', amount: 10 };
const FIVE = { unit: 'year', amount: 5 };
const TWENTY = { unit: 'year', amount: 20 };

/** Symmetric window: ten years before and after 2000-01-01. */
const PINNED = { asOf: CE(2000, 1, 1), before: TEN, after: TEN };
const PINNED_EN = { asOf: CE(2000, 1, 1), before: TEN, after: TEN };
/** Asymmetric window: ten years before, five after. */
const ASYM = { asOf: CE(2000, 1, 1), before: TEN, after: FIVE };
/** One-sided window: only the before side is bounded. */
const BEFORE_ONLY = { asOf: CE(2000, 1, 1), before: TEN, after: null };
/** Clock-following window (no pinned as-of). */
const DEFAULT_CLOCK = { asOf: null, before: TEN, after: TEN };
/** Pinned as-of with an unbounded range on both sides. */
const UNBOUNDED = { asOf: CE(2000, 1, 1), before: null, after: null };
/** BC window with symmetric 20-year sides. */
const BC = { asOf: BCE(200, 1, 1), before: TWENTY, after: TWENTY };

test('hasAnchorEcho: the exact zh and en lines pass', () => {
  assert.equal(hasAnchorEcho(`${anchorLine(PINNED, 'zh')}\n正文。`, PINNED, 'zh'), true);
  assert.equal(hasAnchorEcho(`${anchorLine(PINNED_EN, 'en')}\nBody.`, PINNED_EN, 'en'), true);
});

test('hasAnchorEcho: a wrong date fails', () => {
  assert.equal(hasAnchorEcho('时间窗：2000-01-05 · 前后各10年\n正文。', PINNED, 'zh'), false);
  assert.equal(hasAnchorEcho('Time window: 2000-01-05 · ±10 years\nBody.', PINNED_EN, 'en'), false);
  assert.equal(hasAnchorEcho('时间窗：1999-12-31 · 前后各10年\n正文。', PINNED, 'zh'), false);
});

test('hasAnchorEcho: a wrong range fails', () => {
  assert.equal(hasAnchorEcho('时间窗：2000-01-01 · 前后各99年\n正文。', PINNED, 'zh'), false);
  assert.equal(hasAnchorEcho('时间窗：2000-01-01 · 前10年/后5年\n正文。', PINNED, 'zh'), false);
  assert.equal(hasAnchorEcho('Time window: 2000-01-01 · ±99 years\nBody.', PINNED_EN, 'en'), false);
});

test('hasAnchorEcho: truncated echoes fail', () => {
  for (const probe of [
    '时间窗：',
    '时间窗：2000-01-01',
    '时间窗：2000-01-01 ·',
    '时间窗口：2000-01-01 · 前后各10年',
    '前后各10年',
  ]) {
    assert.equal(hasAnchorEcho(probe, PINNED, 'zh'), false, probe);
  }
  // The old prefix check accepted `Time window: 2`; the semantic check does not.
  assert.equal(hasAnchorEcho('Time window: 2', PINNED_EN, 'en'), false);
});

test('hasAnchorEcho: the wrong locale marker fails', () => {
  assert.equal(hasAnchorEcho('Time window: 2000-01-01 · ±10 years', PINNED, 'zh'), false);
  assert.equal(hasAnchorEcho('时间窗：2000-01-01 · 前后各10年', PINNED_EN, 'en'), false);
});

test('hasAnchorEcho: spacing, full-width punctuation and accepted date forms are tolerated', () => {
  for (const probe of [
    '时间窗：2000-01-01·前后各10年',
    '时间窗:2000/01/01 · 前后各 10 年',
    '时间窗：2000年1月1日 · 前后各10年',
    '  时间窗：2000-01-01 · 前后各10年  ',
  ]) {
    assert.equal(hasAnchorEcho(probe, PINNED, 'zh'), true, probe);
  }
});

test('hasAnchorEcho: asymmetric ranges must match both sides', () => {
  assert.equal(hasAnchorEcho('时间窗：2000-01-01 · 前10年/后5年\n正文。', ASYM, 'zh'), true);
  assert.equal(hasAnchorEcho('Time window: 2000-01-01 · last 10 years / next 5 years\nBody.', ASYM, 'en'), true);
  assert.equal(hasAnchorEcho('时间窗：2000-01-01 · 前后各10年\n正文。', ASYM, 'zh'), false);
  assert.equal(hasAnchorEcho('时间窗：2000-01-01 · 前10年/后不限\n正文。', ASYM, 'zh'), false);
});

test('hasAnchorEcho: one-sided windows echo the unbounded side', () => {
  assert.equal(hasAnchorEcho('时间窗：2000-01-01 · 前10年/后不限\n正文。', BEFORE_ONLY, 'zh'), true);
  assert.equal(hasAnchorEcho('Time window: 2000-01-01 · last 10 years / unbounded\nBody.', BEFORE_ONLY, 'en'), true);
  assert.equal(hasAnchorEcho('时间窗：2000-01-01 · 前后各10年\n正文。', BEFORE_ONLY, 'zh'), false);
});

test('hasAnchorEcho: a fully unbounded range echoes 不限 / unlimited', () => {
  assert.equal(hasAnchorEcho('时间窗：2000-01-01 · 不限\n正文。', UNBOUNDED, 'zh'), true);
  assert.equal(hasAnchorEcho('Time window: 2000-01-01 · unlimited\nBody.', UNBOUNDED, 'en'), true);
  assert.equal(hasAnchorEcho('时间窗：2000-01-01 · 前后各10年\n正文。', UNBOUNDED, 'zh'), false);
});

test('hasAnchorEcho: a clock-following window accepts 默认/默认 and the today date', () => {
  assert.equal(hasAnchorEcho('时间窗：默认 · 前后各10年\n正文。', DEFAULT_CLOCK, 'zh'), true);
  assert.equal(hasAnchorEcho('Time window: default · ±10 years\nBody.', DEFAULT_CLOCK, 'en'), true);
  const now = Date.UTC(2026, 10, 6, 4, 0, 0);
  const day = today(now);
  assert.equal(
    hasAnchorEcho(`时间窗：${formatAsOfDate(day)} · 前后各10年\n正文。`, DEFAULT_CLOCK, 'zh', now),
    true,
  );
  const yesterday = subtractSpan(day, { unit: 'day', amount: 1 });
  assert.equal(
    hasAnchorEcho(`时间窗：${formatAsOfDate(yesterday)} · 前后各10年\n正文。`, DEFAULT_CLOCK, 'zh', now),
    false,
  );
});

test('hasAnchorEcho: BC window passes with the BC date form', () => {
  assert.equal(hasAnchorEcho('时间窗：公元前200年 · 前后各20年\n正文。', BC, 'zh'), true);
  assert.equal(hasAnchorEcho('时间窗：公元前220年 · 前后各20年\n正文。', BC, 'zh'), false);
});

test('hasAnchorEcho: empty or non-string input fails closed', () => {
  for (const probe of ['', '   ', null, undefined, 42]) {
    assert.equal(hasAnchorEcho(probe, PINNED, 'zh'), false);
  }
});
