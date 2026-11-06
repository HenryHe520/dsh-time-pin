// Unit tests for the anchor-echo validator: `node --test tests/`.
import test from 'node:test';
import assert from 'node:assert/strict';

import { anchorLine, hasAnchorEcho } from '../lib/core/text.js';

const CE = (year, month = 1, day = 1) => ({ era: 'ce', year, month, day });
const BCE = (year, month = 1, day = 1) => ({ era: 'bce', year, month, day });

const PINNED = { asOf: CE(2000, 1, 1), span: { unit: 'year', amount: 10 } };
const PINNED_EN = { asOf: CE(2000, 1, 1), span: { unit: 'year', amount: 10 } };
const DEFAULT_CLOCK = { asOf: null, span: { unit: 'year', amount: 10 } };
const UNLIMITED_SPAN = { asOf: CE(2000, 1, 1), span: null };
const BC = { asOf: BCE(200, 1, 1), span: { unit: 'year', amount: 20 } };

test('hasAnchorEcho: the exact zh and en lines pass', () => {
  assert.equal(hasAnchorEcho(`${anchorLine(PINNED, 'zh')}\n正文。`, PINNED, 'zh'), true);
  assert.equal(hasAnchorEcho(`${anchorLine(PINNED_EN, 'en')}\nBody.`, PINNED_EN, 'en'), true);
});

test('hasAnchorEcho: a wrong date fails', () => {
  assert.equal(hasAnchorEcho('时间窗：2000-01-05 · 前10年\n正文。', PINNED, 'zh'), false);
  assert.equal(hasAnchorEcho('Time window: 2000-01-05 · last 10 years\nBody.', PINNED_EN, 'en'), false);
  assert.equal(hasAnchorEcho('时间窗：1999-12-31 · 前10年\n正文。', PINNED, 'zh'), false);
});

test('hasAnchorEcho: a wrong span fails', () => {
  assert.equal(hasAnchorEcho('时间窗：2000-01-01 · 前99年\n正文。', PINNED, 'zh'), false);
  assert.equal(hasAnchorEcho('Time window: 2000-01-01 · last 99 years\nBody.', PINNED_EN, 'en'), false);
});

test('hasAnchorEcho: truncated echoes fail', () => {
  for (const probe of [
    '时间窗：',
    '时间窗：2000-01-01',
    '时间窗：2000-01-01 ·',
    '时间窗口：2000-01-01 · 前10年',
    '前10年',
  ]) {
    assert.equal(hasAnchorEcho(probe, PINNED, 'zh'), false, probe);
  }
  // The old prefix check accepted `Time window: 2`; the semantic check does not.
  assert.equal(hasAnchorEcho('Time window: 2', PINNED_EN, 'en'), false);
});

test('hasAnchorEcho: the wrong locale marker fails', () => {
  assert.equal(hasAnchorEcho('Time window: 2000-01-01 · last 10 years', PINNED, 'zh'), false);
  assert.equal(hasAnchorEcho('时间窗：2000-01-01 · 前10年', PINNED_EN, 'en'), false);
});

test('hasAnchorEcho: spacing, full-width punctuation and accepted date forms are tolerated', () => {
  for (const probe of [
    '时间窗：2000-01-01·前10年',
    '时间窗:2000/01/01 · 前 10 年',
    '时间窗：2000年1月1日 · 前十年年'.replace('前十年年', '前10年'),
    '  时间窗：2000-01-01 · 前10年  ',
  ]) {
    assert.equal(hasAnchorEcho(probe, PINNED, 'zh'), true, probe);
  }
});

test('hasAnchorEcho: a clock-following window must echo 默认 / default', () => {
  assert.equal(hasAnchorEcho('时间窗：默认 · 前10年\n正文。', DEFAULT_CLOCK, 'zh'), true);
  assert.equal(hasAnchorEcho('Time window: default · last 10 years\nBody.', DEFAULT_CLOCK, 'en'), true);
  // Inventing a fixed date for a clock-following window is not the echo.
  assert.equal(hasAnchorEcho('时间窗：2000-01-01 · 前10年\n正文。', DEFAULT_CLOCK, 'zh'), false);
});

test('hasAnchorEcho: unlimited lookback echoes 不限 / unlimited', () => {
  assert.equal(hasAnchorEcho('时间窗：2000-01-01 · 不限\n正文。', UNLIMITED_SPAN, 'zh'), true);
  assert.equal(hasAnchorEcho('Time window: 2000-01-01 · unlimited\nBody.', UNLIMITED_SPAN, 'en'), true);
  assert.equal(hasAnchorEcho('时间窗：2000-01-01 · 前10年\n正文。', UNLIMITED_SPAN, 'zh'), false);
});

test('hasAnchorEcho: BC window passes with the BC date form', () => {
  assert.equal(hasAnchorEcho('时间窗：公元前200年 · 前20年\n正文。', BC, 'zh'), true);
  assert.equal(hasAnchorEcho('时间窗：公元前220年 · 前20年\n正文。', BC, 'zh'), false);
});

test('hasAnchorEcho: empty or non-string input fails closed', () => {
  for (const probe of ['', '   ', null, undefined, 42]) {
    assert.equal(hasAnchorEcho(probe, PINNED, 'zh'), false);
  }
});
