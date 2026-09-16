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
  wedge,
  falseBreakouts,
  heldBreakouts,
  whipsaw,
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

/**
 * 쐐기형 픽스처 — 중심선이 기울고 폭(spread)이 시간이 지날수록 좁아지는
 * 채널을 만든 뒤, dips/pokes 로 지정한 인덱스에서만 살짝 더 깊게/높게
 * 찔러 그 자리를 스윙 저점/고점으로 만든다. 중심선이 기울어 있으므로
 * 두 스윙은 자연히 '오르는 저점·오르는 고점'(또는 그 반대) 관계가 된다.
 */
function wedgeCandles({ n = 30, centerStart = 200, centerSlope = 3, spreadStart = 60, spreadEnd = 20, dips, pokes, tailClose }) {
  const candles = [];
  for (let i = 0; i < n; i += 1) {
    const center = centerStart + centerSlope * i;
    const spread = spreadStart + ((spreadEnd - spreadStart) * i) / (n - 1);
    let low = center - spread * 0.5;
    let high = center + spread * 0.5;
    if (dips.includes(i)) low = center - spread * 1.1;
    if (pokes.includes(i)) high = center + spread * 1.1;
    candles.push({ open: center, high, low, close: center, volume: 100 });
  }
  if (tailClose !== undefined) {
    const lastIndex = n - 1;
    const last = candles[lastIndex];
    const half = (last.high - last.low) / 2 || 1;
    candles[lastIndex] = { ...last, close: tailClose, high: Math.max(last.high, tailClose + half * 0.1), low: Math.min(last.low, tailClose - half * 0.1) };
  }
  return candles;
}

test('wedge: 중심선이 오르고 폭이 좁아지면 상승 쐐기형(돌파 전에는 방향 미정)', () => {
  const candles = wedgeCandles({ dips: [3, 15], pokes: [6, 20] });
  const result = wedge(candles, { span: 2 });
  assert.equal(result.kind, 'rising');
  assert.equal(result.breakout, null);
});

test('wedge: 상승 쐐기형이라도 위로 종가 이탈하면 상승 돌파', () => {
  const base = wedgeCandles({ dips: [3, 15], pokes: [6, 20] });
  const upper = base.at(-1).high;
  const candles = wedgeCandles({ dips: [3, 15], pokes: [6, 20], tailClose: upper * 1.2 });
  assert.equal(wedge(candles, { span: 2 }).breakout, 'up');
});

test('wedge: 상승 쐐기형이 아래로 종가 이탈하면 하락 돌파', () => {
  const base = wedgeCandles({ dips: [3, 15], pokes: [6, 20] });
  const lower = base.at(-1).low;
  const candles = wedgeCandles({ dips: [3, 15], pokes: [6, 20], tailClose: lower * 0.8 });
  assert.equal(wedge(candles, { span: 2 }).breakout, 'down');
});

test('wedge: 두 추세선이 서로 다른 방향으로 기울면(대칭삼각형 모양) null', () => {
  const highs = [150, 160, 170, 200, 180, 170, 180, 190, 180, 170, 160];
  const lows = [100, 90, 80, 90, 100, 105, 100, 95, 90, 95, 100];
  const candles = hl(highs, lows);

  assert.equal(triangle(candles, { span: 2 }).kind, 'symmetric');
  assert.equal(wedge(candles, { span: 2 }), null);
});

// ── 거짓 무빙 ────────────────────────────────────────────────

/**
 * 저항 100 을 세 번 때린 뒤 뚫었다가 되돌아오는 모양을 만든다.
 * 종가 = 고저의 중간이므로 hl() 대신 종가를 직접 지정하는 캔들을 쓴다.
 */
function bars(closes, volumes = null) {
  return closes.map((close, i) => ({
    open: i === 0 ? close : closes[i - 1],
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: volumes ? volumes[i] : 100,
  }));
}

/** 저항 100 을 세 번 찍는 톱니. 스윙 고점이 100 에 세 번 생긴다. */
const TRIPLE_TOUCH = [
  90, 92, 95, 98, 100, 98, 95, 92,
  90, 92, 95, 98, 100, 98, 95, 92,
  90, 92, 95, 98, 100, 98, 95, 92,
  90, 92, 94, 96, 98,
];

test('falseBreakouts: 저항을 뚫고 되돌아오면 불트랩으로 확정한다', () => {
  const closes = [...TRIPLE_TOUCH, 103, 104, 101, 97, 95, 93];
  const traps = falseBreakouts(bars(closes), { span: 3 });

  assert.equal(traps.length, 1);
  const [trap] = traps;
  assert.equal(trap.kind, 'bull-trap');
  assert.equal(trap.status, 'confirmed');
  assert.equal(trap.breakIndex, 29, '돌파가 시작된 봉');
  assert.equal(trap.returnIndex, 32, '레벨 안쪽으로 되돌아온 봉');
  assert.equal(trap.bars, 3);
});

test('falseBreakouts: 지지를 깨고 되돌아오면 베어트랩이다', () => {
  // 지지 90 을 세 번 찍은 뒤 아래로 이탈했다 복귀한다.
  const closes = [...TRIPLE_TOUCH.map((c) => c), 96, 94, 92, 86, 85, 91, 93];
  const traps = falseBreakouts(bars(closes), { span: 3 });

  const bear = traps.find((trap) => trap.kind === 'bear-trap');
  assert.ok(bear, '지지 이탈 후 복귀를 잡아야 한다');
  assert.equal(bear.status, 'confirmed');
});

/*
 * 되돌아온 봉은 그 자체로 반대편 돌파처럼 보인다. 이 검사가 없으면 불트랩
 * 하나가 불트랩 + 베어트랩 두 건으로 세어진다(실제로 그렇게 나왔다).
 */
test('falseBreakouts: 복귀 봉을 반대편 트랩으로 두 번 세지 않는다', () => {
  const closes = [...TRIPLE_TOUCH, 103, 104, 101, 97, 95, 93];
  const traps = falseBreakouts(bars(closes), { span: 3 });

  assert.equal(traps.filter((trap) => trap.kind === 'bear-trap').length, 0);
});

test('falseBreakouts: 되돌아오지 않은 돌파는 미확정으로 남긴다', () => {
  const closes = [...TRIPLE_TOUCH, 103, 104];
  const [trap] = falseBreakouts(bars(closes), { span: 3 });

  assert.equal(trap.status, 'pending');
  assert.equal(trap.returnIndex, null);
  assert.equal(trap.kind, 'bull-trap', '되돌아오면 누가 물리는지로 이름을 붙인다');
});

test('falseBreakouts: 관찰 창을 넘겨 버틴 돌파는 거짓이 아니다', () => {
  // 돌파 후 6봉(확정 창 5봉 초과) 동안 레벨 위에 머문다.
  const closes = [...TRIPLE_TOUCH, 103, 104, 105, 106, 107, 108, 109];
  assert.deepEqual(falseBreakouts(bars(closes), { span: 3 }), []);
});

test('heldBreakouts: falseBreakouts 가 거짓이 아니라고 본 바로 그 돌파를 잡는다', () => {
  const closes = [...TRIPLE_TOUCH, 103, 104, 105, 106, 107, 108, 109];
  const [held] = heldBreakouts(bars(closes), { span: 3 });
  assert.ok(held, '확정 돌파를 찾아야 한다');
  assert.equal(held.kind, 'breakout-up');
  near(held.level.price, 100.5, 1e-6, 'level.price'); // bars() 는 high = close + 0.5
  assert.equal(held.breakIndex, 29);
});

test('heldBreakouts: 지지를 깨고 버티면 breakout-down', () => {
  // 저항 100 대신 지지 90 을 세 번 찍은 뒤 아래로 뚫고 버틴다.
  const closes = [...TRIPLE_TOUCH.map((v) => 190 - v), 87, 86, 85, 84, 83, 82, 81];
  const [held] = heldBreakouts(bars(closes), { span: 3 });
  assert.ok(held, '확정 돌파를 찾아야 한다');
  assert.equal(held.kind, 'breakout-down');
  near(held.level.price, 89.5, 1e-6, 'level.price'); // bars() 는 low = close - 0.5
});

test('heldBreakouts: 되돌아온 트랩은 확정 돌파가 아니다', () => {
  // falseBreakouts 의 '불트랩으로 확정한다' 픽스처와 같은 데이터 — 저항을
  // 뚫었다가 바로 되돌아오므로 heldBreakouts 에는 잡히지 않아야 한다.
  const closes = [...TRIPLE_TOUCH, 103, 104, 97, 95, 93];
  assert.deepEqual(heldBreakouts(bars(closes), { span: 3 }), []);
});

test('heldBreakouts: 아직 관찰 창이 안 끝난 미확정 돌파는 잡지 않는다', () => {
  const closes = [...TRIPLE_TOUCH, 103, 104];
  assert.deepEqual(heldBreakouts(bars(closes), { span: 3 }), []);
});

test('falseBreakouts: 돌파봉 거래량이 평균 미만이면 실리지 않은 돌파로 본다', () => {
  const closes = [...TRIPLE_TOUCH, 103, 104, 101, 97, 95, 93];
  const volumes = closes.map((_, i) => (i === 29 ? 20 : 100));
  const [weak] = falseBreakouts(bars(closes, volumes), { span: 3 });
  assert.equal(weak.weak, true);
  near(weak.volumeRatio, 0.2, 1e-9, '돌파봉 거래량비');

  const heavy = closes.map((_, i) => (i === 29 ? 300 : 100));
  const [strong] = falseBreakouts(bars(closes, heavy), { span: 3 });
  assert.equal(strong.weak, false);
});

test('falseBreakouts: 꼬리만 스친 것은 돌파로 보지 않는다', () => {
  // 종가는 레벨 아래인데 고가만 레벨을 넘긴다.
  const closes = [...TRIPLE_TOUCH, 100.2, 100.1, 97, 95];
  const candles = bars(closes).map((candle, i) => (i >= 29 ? { ...candle, high: 110 } : candle));

  assert.deepEqual(falseBreakouts(candles, { span: 3 }), []);
});

test('falseBreakouts: 봉이 부족하면 빈 배열', () => {
  assert.deepEqual(falseBreakouts(bars([100, 101, 102]), { span: 3 }), []);
});

test('whipsaw: 기준선을 반복해 넘나들면 톱질로 본다', () => {
  // MA5 위아래를 계속 오가는 톱니
  const closes = Array.from({ length: 40 }, (_, i) => 100 + (i % 2 === 0 ? 4 : -4));
  const result = whipsaw(bars(closes), { period: 5, window: 20, minCrosses: 4 });

  assert.ok(result, '교차가 잦으면 감지돼야 한다');
  assert.ok(result.crosses >= 4);
  assert.equal(result.window, 20);
  assert.equal(result.period, 5);
});

test('whipsaw: 한 방향으로만 가면 교차가 없어 null', () => {
  const closes = Array.from({ length: 40 }, (_, i) => 100 + i * 2);
  assert.equal(whipsaw(bars(closes), { period: 5, window: 20, minCrosses: 4 }), null);
});

test('whipsaw: 교차가 기준 미만이면 null', () => {
  const closes = Array.from({ length: 40 }, (_, i) => 100 + i * 2);
  // 한 번만 꺾이는 모양 — 교차 1회
  closes.splice(30, 10, ...Array.from({ length: 10 }, (_, i) => 158 - i * 4));
  assert.equal(whipsaw(bars(closes), { period: 5, window: 20, minCrosses: 4 }), null);
});
