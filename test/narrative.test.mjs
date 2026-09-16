import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  baseRange,
  swingReversal,
  longTermBottom,
  trendReversalSignal,
  trendStage,
  entryPoints,
  currentStance,
  analyzeChart,
} from '../js/narrative.js';
import { supportResistanceLevels } from '../js/patterns.js';

/** near 비교. 나눗셈이 섞인 값은 정확 비교가 안 통한다(test/patterns.test.mjs 와 같은 헬퍼). */
function near(actual, expected, tolerance = 1e-6, label = '') {
  assert.ok(
    actual !== null && Math.abs(actual - expected) < tolerance,
    `${label} 기대 ${expected}, 실제 ${actual}`,
  );
}

/** 종가만으로 캔들을 만든다. 고저는 종가 ±0.5(대부분의 판정에는 영향이 없다). */
function bars(closes) {
  return closes.map((close, i) => ({
    open: i === 0 ? close : closes[i - 1],
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: 100,
  }));
}

// ── 박스권(바닥 다지기 · 고점 형성 · 그 돌파) ───────────────────

/**
 * 장기 하락(500→200) 후 저점권에서 좁게 횡보하는 박스를 만든다. `resolved`
 * 가 true 면 마지막 봉만 박스 위로 종가 이탈시킨다.
 */
function bottomBoxCloses(resolved) {
  const closes = [];
  for (let i = 0; i <= 65; i += 1) closes.push(500 - (300 / 65) * i);
  for (let i = 66; i <= 89; i += 1) closes.push(200 + (i % 2 === 0 ? 6 : -2));
  if (resolved) closes[closes.length - 1] = 230;
  return closes;
}

function topBoxCloses(resolved) {
  const closes = [];
  for (let i = 0; i <= 65; i += 1) closes.push(200 + (300 / 65) * i);
  for (let i = 66; i <= 89; i += 1) closes.push(500 + (i % 2 === 0 ? -6 : 2));
  if (resolved) closes[closes.length - 1] = 470;
  return closes;
}

test('baseRange: 저점권에서 좁게 횡보하면 바닥 다지기(아직 미돌파)', () => {
  const result = baseRange(bars(bottomBoxCloses(false)), 'bottom');
  assert.equal(result.side, 'bottom');
  assert.equal(result.resolved, null);
});

test('baseRange: 박스를 위로 종가 이탈하면 resolved:"up"', () => {
  const result = baseRange(bars(bottomBoxCloses(true)), 'bottom');
  assert.equal(result.resolved, 'up');
  assert.equal(result.anchorPrice, 230);
});

test('baseRange: 고점권에서 좁게 횡보하면 고점 형성(아직 미돌파)', () => {
  const result = baseRange(bars(topBoxCloses(false)), 'top');
  assert.equal(result.side, 'top');
  assert.equal(result.resolved, null);
});

test('baseRange: 박스를 아래로 종가 이탈하면 resolved:"down"', () => {
  const result = baseRange(bars(topBoxCloses(true)), 'top');
  assert.equal(result.resolved, 'down');
});

// ── 스윙 반전 ────────────────────────────────────────────────

/** 하락(320→~200) 후 반등하는 저점을 만든다 — '하락 후 반등' 기준 픽스처 */
function declineReboundCloses() {
  const closes = [250, 270, 290, 305, 315, 320];
  for (let i = 6; i <= 29; i += 1) closes.push(320 - ((320 - 205) / 24) * (i - 5));
  closes.push(200, 205, 210);
  for (let i = 33; i <= 39; i += 1) closes.push(210 + (i - 32) * 0.6);
  return closes;
}

test('swingReversal: 하락 후 반등 — 저점 확인 후 되돌림이 진행 중이면 감지한다', () => {
  const result = swingReversal(bars(declineReboundCloses()), 'bullish', 3);
  assert.ok(result, '반등을 찾아야 한다');
  assert.equal(result.extreme.index, 30);
  assert.ok(result.bounce >= 0.02);
});

test('swingReversal: 상승 후 하락 — 장기 최고가가 아니면 major:false', () => {
  // declineReboundCloses 를 뒤집어 고점 반전을 만들고, 그보다 훨씬 높은 봉우리를
  // 앞에 붙여 '장기 최고'가 아니게 한다(고점에서 하락과 구분하기 위함).
  const mirrored = declineReboundCloses().map((v) => 520 - v);
  const closes = [500, 480, 460, 440, 420, ...mirrored];
  const result = swingReversal(bars(closes), 'bearish', 3);
  assert.ok(result);
  assert.equal(result.major, false);
  assert.equal(result.sharp, false);
});

test('swingReversal: V자 하락 — 짧은 구간에서 급등 후 급락하면 sharp:true', () => {
  const closes = [300, 290, 270, 250, 260, 290, 320, 340, 335, 325, 315, 305, 300, 300, 300, 300];
  const result = swingReversal(bars(closes), 'bearish', 2);
  assert.ok(result);
  assert.equal(result.sharp, true);
});

test('swingReversal: 반전 전 반대 방향 움직임이 없으면(그냥 첫 스윙) null', () => {
  const closes = [200, 205, 210, 215, 220, 225, 220, 218];
  assert.equal(swingReversal(bars(closes), 'bullish', 2), null);
});

// ── 장기 바닥 확인 ───────────────────────────────────────────

test('longTermBottom: 장기 최저가가 10봉 이상 재하락 없이 유지되면 확인된 바닥', () => {
  const closes = [];
  for (let i = 0; i <= 30; i += 1) closes.push(400 - (200 / 30) * i);
  for (let i = 31; i <= 45; i += 1) closes.push(204 + (i % 2 === 0 ? 3 : -1));
  const result = longTermBottom(bars(closes), 3);
  assert.ok(result);
  assert.equal(result.index, 30);
  assert.ok(result.barsSince >= 10);
});

test('longTermBottom: 형성된 지 얼마 안 됐으면(확인 기간 미달) null', () => {
  const closes = [];
  for (let i = 0; i <= 30; i += 1) closes.push(400 - (200 / 30) * i);
  for (let i = 31; i <= 34; i += 1) closes.push(204 + i * 0.1); // 4봉만 경과
  assert.equal(longTermBottom(bars(closes), 3), null);
});

// ── 추세 전환 신호 · 추세 단계 ────────────────────────────────

test('trendReversalSignal: MA20 이 MA60 을 상향 돌파하면 감지한다', () => {
  const closes = [];
  for (let i = 0; i <= 60; i += 1) closes.push(300 - i);
  for (let i = 61; i <= 75; i += 1) closes.push(240 + (i - 60) * 8);
  const result = trendReversalSignal(bars(closes));
  assert.ok(result, '골든크로스를 찾아야 한다');
});

test('trendReversalSignal: 크로스가 없으면 null', () => {
  const closes = Array.from({ length: 70 }, (_, i) => 300 - i * 0.5);
  assert.equal(trendReversalSignal(bars(closes)), null);
});

test('trendStage: 고점·저점이 연속으로 높아지면 상승 추세', () => {
  const closes = Array.from({ length: 71 }, (_, i) => {
    const base = 200 + i * 2;
    return base + (i % 6 < 3 ? -5 : 5);
  });
  const result = trendStage(bars(closes), 3);
  assert.ok(result);
  assert.equal(result.direction, 'up');
});

test('trendStage: 고점·저점이 연속으로 낮아지면 추세 하락', () => {
  const closes = Array.from({ length: 71 }, (_, i) => {
    const base = 400 - i * 2;
    return base + (i % 6 < 3 ? -5 : 5);
  });
  const result = trendStage(bars(closes), 3);
  assert.ok(result);
  assert.equal(result.direction, 'down');
});

// ── 지지/저항 진입 신호 ──────────────────────────────────────

const TRIPLE_TOUCH = [
  90, 92, 95, 98, 100, 98, 95, 92, 90, 92, 95, 98, 100, 98, 95, 92, 90, 92, 95, 98, 100, 98, 95, 92,
];

test('entryPoints: 저항 터치는 매도, 지지 터치는 매수로 표시한다', () => {
  const points = entryPoints(bars(TRIPLE_TOUCH), 3);
  assert.ok(points.some((p) => p.kind === 'sell' && p.level.kind === 'resistance'));
  assert.ok(points.some((p) => p.kind === 'buy' && p.level.kind === 'support'));
});

test('entryPoints: 저항을 뚫고 버틴 레벨을 나중에 스윙 저점이 다시 짚으면 진입(재확인)', () => {
  // TRIPLE_TOUCH 로 저항 100 을 세 번 찍은 뒤 위로 뚫고 버티다가(heldBreakouts),
  // 그 자리 근처에서 스윙 저점을 다시 만든다 — 저항이 지지로 바뀐 뒤의 재확인.
  const closes = [
    ...TRIPLE_TOUCH,
    103, 104, 105, 106, 107, 108, 109, 112, 108, 101, 100.3, 101, 108, 112, 115,
  ];
  const points = entryPoints(bars(closes), 3);
  const enter = points.find((p) => p.kind === 'enter');
  assert.ok(enter, '재확인 진입 신호를 찾아야 한다');
  near(enter.price, 99.8, 1e-6, 'enter.price');
});

test('currentStance: 현재가가 지지선에 붙어 있으면 매수 관점', () => {
  const closes = [...TRIPLE_TOUCH, 89.7];
  const candles = bars(closes);
  const levels = supportResistanceLevels(candles, { span: 3 });
  const stance = currentStance(candles, levels);
  assert.ok(stance);
  assert.equal(stance.stance, 'buy');
});

test('currentStance: 현재가가 저항선에 붙어 있으면 매도 관점', () => {
  const closes = [...TRIPLE_TOUCH, 100.2];
  const candles = bars(closes);
  const levels = supportResistanceLevels(candles, { span: 3 });
  const stance = currentStance(candles, levels);
  assert.ok(stance);
  assert.equal(stance.stance, 'sell');
});

test('currentStance: 레벨에서 멀리 떨어져 있으면 null', () => {
  const candles = bars(TRIPLE_TOUCH); // 마지막 종가 92 — 어느 레벨과도 1% 밖
  const levels = supportResistanceLevels(candles, { span: 3 });
  assert.equal(currentStance(candles, levels), null);
});

// ── 전부 합쳐 번호 매긴 리포트 ────────────────────────────────

test('analyzeChart: 구조 패턴이 시간순으로 번호 매겨진다', () => {
  const result = analyzeChart(bars(bottomBoxCloses(false)), { span: 3 });
  assert.ok(result.items.length > 0, '바닥 다지기를 포함해 적어도 하나는 잡혀야 한다');
  assert.ok(result.items.some((item) => item.label === '바닥 다지기'));

  // 번호는 1부터 순서대로, index 는 항상 오름차순이어야 한다.
  result.items.forEach((item, i) => assert.equal(item.number, i + 1));
  for (let i = 1; i < result.items.length; i += 1) {
    assert.ok(result.items[i].index >= result.items[i - 1].index);
  }
});

test('analyzeChart: 캔들이 너무 적으면 빈 리포트를 낸다(예외를 던지지 않는다)', () => {
  const result = analyzeChart(bars([100, 101, 99, 102]), { span: 3 });
  assert.deepEqual(result, { items: [], stance: null });
});

test('analyzeChart: 각 항목은 배지를 그릴 좌표(index·price·side)와 색 구분(group)을 함께 낸다', () => {
  const result = analyzeChart(bars(bottomBoxCloses(false)), { span: 3 });
  for (const item of result.items) {
    assert.equal(typeof item.index, 'number');
    assert.equal(typeof item.price, 'number');
    assert.ok(['above', 'below'].includes(item.side));
    assert.ok(['bullish', 'bearish', 'buy', 'sell', 'enter'].includes(item.group));
    assert.equal(typeof item.text, 'string');
  }
});
