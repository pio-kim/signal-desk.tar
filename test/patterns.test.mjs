import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  swingPoints,
  supportResistanceLevels,
  trendlines,
  fibonacciRetracement,
  vwap,
  volumeProfile,
  obvDivergence,
  doubleExtremes,
  headAndShoulders,
  triangle,
} from '../js/patterns.js';

/** near 비교. 나눗셈이 섞인 값(피보나치·VWAP)은 정확 비교가 안 통한다. */
function near(actual, expected, tolerance = 1e-6, label = '') {
  assert.ok(
    actual !== null && Math.abs(actual - expected) < tolerance,
    `${label} 기대 ${expected}, 실제 ${actual}`,
  );
}

/** 고가·저가 배열을 캔들로 합친다. 종가는 둘의 중간, 거래량은 지정 없으면 100. */
function hl(highs, lows, volumes = null) {
  return highs.map((high, i) => ({
    high,
    low: lows[i],
    close: (high + lows[i]) / 2,
    volume: volumes ? volumes[i] : 100,
  }));
}

/** 종가·거래량만으로 만드는 캔들(OBV 다이버전스 전용 — 고저는 종가와 같게 둔다). */
function ohlcv(close, volume) {
  return { open: close, high: close, low: close, close, volume };
}

// ── 스윙 포인트 ──────────────────────────────────────────────

test('swingPoints: 고가·저가 배열에서 각각 스윙을 찾는다', () => {
  const highs = [150, 155, 160, 170, 180, 190, 200, 190, 180, 170];
  const lows = [100, 95, 90, 85, 80, 85, 90, 95, 100, 105];
  const candles = hl(highs, lows);

  const { highs: swingHighs, lows: swingLows } = swingPoints(candles, 2);
  assert.deepEqual(swingLows.map((p) => p.index), [4]);
  assert.equal(swingLows[0].price, 80);
  assert.deepEqual(swingHighs.map((p) => p.index), [6]);
  assert.equal(swingHighs[0].price, 200);
});

// ── 라인형 ───────────────────────────────────────────────────

test('supportResistanceLevels: 같은 가격대를 두 번 이상 건드리면 레벨로 잡는다', () => {
  const lows = [
    100, 95, 90, 85, 80, 85, 90, 95, 100, 95, 90, 85, 80, 85, 90, 95, 100, 105, 110, 105, 100,
  ];
  const highs = lows.map((v) => 300 - v); // 300-v 는 저점이 있는 자리에서 고점을 만드는 단조 변환
  const candles = hl(highs, lows);

  const levels = supportResistanceLevels(candles, { span: 2 });
  const support = levels.find((l) => l.kind === 'support');
  const resistance = levels.find((l) => l.kind === 'resistance');

  assert.ok(support, '지지선을 찾아야 한다');
  near(support.price, 80, 1e-6, 'support.price');
  assert.equal(support.touches, 2);

  assert.ok(resistance, '저항선을 찾아야 한다');
  near(resistance.price, 220, 1e-6, 'resistance.price');
  assert.equal(resistance.touches, 2);
});

test('supportResistanceLevels: 한 번만 닿은 극점은 레벨이 아니다', () => {
  const highs = [150, 155, 160, 170, 180, 190, 200, 190, 180, 170];
  const lows = [100, 95, 90, 85, 80, 85, 90, 95, 100, 105];
  const candles = hl(highs, lows);

  assert.deepEqual(supportResistanceLevels(candles, { span: 2 }), []);
});

test('trendlines: 스윙 저점 2개로 상승선, 스윙 고점 2개로 하락선을 긋는다', () => {
  const highs = [150, 160, 170, 200, 180, 170, 180, 190, 180, 170, 160];
  const lows = [100, 90, 80, 90, 100, 105, 100, 95, 90, 95, 100];
  const candles = hl(highs, lows);

  const { support, resistance } = trendlines(candles, { span: 2 });

  assert.ok(support.slope > 0, '저점 2개가 오르면 상승 추세선');
  near(support.priceAt(2), 80, 1e-6);
  near(support.priceAt(8), 90, 1e-6);

  assert.ok(resistance.slope < 0, '고점 2개가 내리면 하락 추세선');
  near(resistance.priceAt(3), 200, 1e-6);
  near(resistance.priceAt(7), 190, 1e-6);
});

test('trendlines: 스윙이 2개 미만이면 null', () => {
  const candles = hl([100, 101, 102], [90, 91, 92]);
  const { support, resistance } = trendlines(candles, { span: 2 });
  assert.equal(support, null);
  assert.equal(resistance, null);
});

test('fibonacciRetracement: 고점이 저점보다 나중이면 상승 구간으로 본다', () => {
  const candles = hl([100, 150], [90, 140]);
  const result = fibonacciRetracement(candles);

  assert.equal(result.direction, 'up');
  assert.equal(result.high, 150);
  assert.equal(result.low, 90);
  near(result.levels[0].price, 150, 1e-6, 'ratio 0 == 고점');
  near(result.levels.at(-1).price, 90, 1e-6, 'ratio 1 == 저점');
  near(result.levels.find((l) => l.ratio === 0.5).price, 120, 1e-6, '50% 되돌림');
});

test('fibonacciRetracement: 저점이 고점보다 나중이면 하락 구간으로 본다', () => {
  const candles = hl([150, 100], [100, 40]);
  const result = fibonacciRetracement(candles);

  assert.equal(result.direction, 'down');
  near(result.levels[0].price, 40, 1e-6, 'ratio 0 == 저점');
  near(result.levels.at(-1).price, 150, 1e-6, 'ratio 1 == 고점');
});

test('fibonacciRetracement: 구간에 변동이 없으면 null', () => {
  const candles = hl([100, 100], [100, 100]);
  assert.equal(fibonacciRetracement(candles), null);
});

test('vwap: 거래량가중평균가를 누적으로 계산한다', () => {
  const candles = [
    { high: 10, low: 8, close: 9, volume: 100 },
    { high: 12, low: 10, close: 11, volume: 50 },
    { high: 8, low: 6, close: 7, volume: 0 }, // 거래량 0 이면 값이 움직이지 않는다
  ];
  const series = vwap(candles);

  near(series[0], 9, 1e-6);
  near(series[1], 1450 / 150, 1e-6);
  near(series[2], series[1], 1e-9, '거래량 0 인 봉은 VWAP 을 바꾸지 않는다');
});

test('vwap: 거래량이 전부 0이면 값을 낼 수 없다', () => {
  const candles = [
    { high: 10, low: 8, close: 9, volume: 0 },
    { high: 11, low: 9, close: 10, volume: 0 },
  ];
  assert.deepEqual(vwap(candles), [null, null]);
});

// ── 거래량 연계 ──────────────────────────────────────────────

test('volumeProfile: 거래량이 가장 많이 몰린 가격대가 POC', () => {
  const candles = [
    { high: 100, low: 100, volume: 30 },
    { high: 200, low: 200, volume: 70 },
  ];
  const profile = volumeProfile(candles, 2);

  assert.equal(profile.levels.length, 2);
  near(profile.levels[0].volume, 30, 1e-6);
  near(profile.levels[1].volume, 70, 1e-6);
  near(profile.poc.volume, 70, 1e-6);
  near(profile.poc.priceLow, 150, 1e-6);
});

test('volumeProfile: 가격 변동이 전혀 없으면 null', () => {
  const candles = [
    { high: 100, low: 100, volume: 10 },
    { high: 100, low: 100, volume: 5 },
  ];
  assert.equal(volumeProfile(candles, 4), null);
});

test('obvDivergence: 가격은 신저점인데 OBV 가 더 높은 저점이면 상승 다이버전스', () => {
  const closes = [100, 95, 90, 95, 100, 105, 100, 90, 80, 90, 100];
  const volumes = [100, 10, 10, 5, 5, 5, 1, 1, 1, 10, 10];
  const candles = closes.map((c, i) => ohlcv(c, volumes[i]));

  const result = obvDivergence(candles, { span: 2, lookback: closes.length });
  assert.deepEqual(result, { kind: 'bullish', indices: [2, 8] });
});

test('obvDivergence: 가격은 신고점인데 OBV 가 더 낮은 고점이면 하락 다이버전스', () => {
  const base = [100, 95, 90, 95, 100, 105, 100, 90, 80, 90, 100];
  const closes = base.map((c) => 200 - c); // 저점↔고점을 뒤집는다
  const volumes = [100, 10, 10, 5, 5, 5, 1, 1, 1, 10, 10];
  const candles = closes.map((c, i) => ohlcv(c, volumes[i]));

  const result = obvDivergence(candles, { span: 2, lookback: closes.length });
  assert.deepEqual(result, { kind: 'bearish', indices: [2, 8] });
});

test('obvDivergence: 단조 추세에는 스윙이 없어 판정하지 않는다', () => {
  const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
  const candles = closes.map((c) => ohlcv(c, 100));
  assert.equal(obvDivergence(candles, { span: 2 }), null);
});

// ── 반전 패턴 ────────────────────────────────────────────────

test('doubleExtremes: 비슷한 높이의 저점 두 개 + 뚜렷한 넥라인이면 쌍바닥', () => {
  const lows = [
    100, 95, 90, 85, 80, 85, 90, 95, 100, 95, 90, 85, 80, 85, 90, 95, 100, 105, 110, 105, 100,
  ];
  const highs = [
    150, 150, 150, 150, 150, 200, 250, 280, 300, 280, 250, 200, 150, 150, 150, 150, 150, 150,
    150, 150, 150,
  ];
  const candles = hl(highs, lows);

  const results = doubleExtremes(candles, { span: 2 });
  const bottom = results.find((r) => r.kind === 'double-bottom');

  assert.ok(bottom, '쌍바닥을 찾아야 한다');
  assert.deepEqual(
    bottom.points.map((p) => p.index),
    [4, 12],
  );
  assert.equal(bottom.neckline.index, 8);
  assert.equal(results.some((r) => r.kind === 'double-top'), false, '고점 스윙이 하나뿐이라 쌍봉은 없다');
});

test('doubleExtremes: 넥라인까지 되돌림이 너무 얕으면(3% 미만) 패턴으로 보지 않는다', () => {
  const lows = [
    100, 95, 90, 85, 80, 85, 90, 95, 100, 95, 90, 85, 80, 85, 90, 95, 100, 105, 110, 105, 100,
  ];
  // 넥라인 후보가 82 — 저점 80 대비 2.5%밖에 안 된다(기준 3%)
  const highs = [
    150, 150, 150, 150, 150, 78, 80, 81, 82, 81, 80, 78, 150, 150, 150, 150, 150, 150, 150, 150,
    150,
  ];
  const candles = hl(highs, lows);

  const results = doubleExtremes(candles, { span: 2 });
  assert.deepEqual(results, []);
});

test('headAndShoulders: 어깨-머리-어깨 배치를 찾는다', () => {
  const highs = [50, 60, 100, 60, 50, 60, 115, 60, 50, 60, 100, 60, 50, 50, 50];
  const lows = highs.map((v) => v - 20);
  const candles = hl(highs, lows);

  const results = headAndShoulders(candles, { span: 2 });
  const found = results.find((r) => r.kind === 'head-shoulders');

  assert.ok(found, '헤드앤숄더를 찾아야 한다');
  assert.equal(found.left.index, 2);
  assert.equal(found.head.index, 6);
  assert.equal(found.right.index, 10);
  near(found.neckline, 100, 1e-6);
  assert.equal(
    results.some((r) => r.kind === 'inverse-head-shoulders'),
    false,
  );
});

test('headAndShoulders: 양쪽 어깨 높이 차이가 크면(3% 초과) 패턴으로 보지 않는다', () => {
  const highs = [50, 60, 100, 60, 50, 60, 115, 60, 50, 60, 110, 60, 50, 50, 50];
  const lows = highs.map((v) => v - 20);
  const candles = hl(highs, lows);

  assert.deepEqual(headAndShoulders(candles, { span: 2 }), []);
});

// ── 지속 패턴 ────────────────────────────────────────────────

test('triangle: 고점·저점이 서로를 향해 좁아지면 대칭삼각형', () => {
  const highs = [150, 160, 170, 200, 180, 170, 180, 190, 180, 170, 160];
  const lows = [100, 90, 80, 90, 100, 105, 100, 95, 90, 95, 100];
  const candles = hl(highs, lows);

  const result = triangle(candles, { span: 2 });
  assert.equal(result.kind, 'symmetric');
});

test('triangle: 고점이 수평이고 저점만 오르면 상승삼각형', () => {
  const highs = [150, 160, 170, 190, 180, 170, 180, 190, 180, 170, 160];
  const lows = [100, 90, 80, 90, 100, 105, 100, 95, 90, 95, 100];
  const candles = hl(highs, lows);

  const result = triangle(candles, { span: 2 });
  assert.equal(result.kind, 'ascending');
});

test('triangle: 스윙이 부족하면 null', () => {
  const candles = hl([100, 101, 102], [90, 91, 92]);
  assert.equal(triangle(candles, { span: 2 }), null);
});
