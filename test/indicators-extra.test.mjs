/**
 * 확장 지표 테스트 — ADX/DMI · 스토캐스틱 · ATR · OBV · 다이버전스.
 * 기존 indicators.test.mjs 와 같은 원칙으로 손계산이 가능한 입력만 쓴다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  adx,
  atr,
  atrPercentile,
  findSwings,
  obv,
  obvSlope,
  rsi,
  rsiDivergence,
  stochastic,
  trueRange,
} from '../js/indicators.js';

/** 시가·고가·저가·종가·거래량을 직접 지정하는 캔들 */
const bar = (open, high, low, close, volume = 100) => ({ open, high, low, close, volume });

/** 겹치지 않게 계단식으로 오르는 봉. +DM 만 발생한다. */
function risingBars(count, step = 10) {
  return Array.from({ length: count }, (_, i) => {
    const base = 100 + i * step;
    return bar(base, base + step, base, base + step);
  });
}

/** 겹치지 않게 계단식으로 내리는 봉. −DM 만 발생한다. */
function fallingBars(count, step = 10) {
  return Array.from({ length: count }, (_, i) => {
    const base = 1000 - i * step;
    return bar(base, base, base - step, base - step);
  });
}

const flatBars = (count) => Array.from({ length: count }, () => bar(100, 100, 100, 100));

// ── True Range ───────────────────────────────────────────────

test('trueRange: 세 후보 중 가장 큰 값을 고른다', () => {
  const bars = [bar(100, 110, 90, 105), bar(105, 130, 100, 120)];
  const out = trueRange(bars);

  assert.equal(out[0], null, '첫 봉은 전일 종가가 없다');
  // max(고−저 30, |고−전종| 25, |저−전종| 5) = 30
  assert.equal(out[1], 30);
});

test('trueRange: 갭 상승은 고−저보다 전일 종가 기준이 크다', () => {
  const bars = [bar(100, 100, 100, 100), bar(150, 155, 150, 152)];
  // 고−저 5, |고−전종| 55, |저−전종| 50 → 55
  assert.equal(trueRange(bars)[1], 55);
});

// ── ATR ─────────────────────────────────────────────────────

test('atr: 변동폭이 일정하면 ATR 도 그 값이다', () => {
  const bars = Array.from({ length: 30 }, () => bar(100, 110, 100, 100));
  // 첫 봉 이후 TR 은 항상 10 (고−저 10, 전일 종가도 100)
  const out = atr(bars, 14);
  assert.ok(Math.abs(out.at(-1) - 10) < 1e-9, `실제 ${out.at(-1)}`);
});

test('atr: 봉이 기간보다 적으면 전부 null', () => {
  assert.deepEqual(atr(flatBars(5), 14), [null, null, null, null, null]);
});

test('atrPercentile: 최근 구간 안에서 현재 ATR 의 순위를 낸다', () => {
  // 앞쪽은 좁은 변동, 마지막에 크게 확장 → 백분위가 1에 가까워야 한다
  const calm = Array.from({ length: 60 }, () => bar(100, 101, 99, 100));
  const spike = Array.from({ length: 5 }, () => bar(100, 140, 60, 100));
  const out = atrPercentile([...calm, ...spike], 14, 40);

  assert.ok(out.at(-1) > 0.9, `확장 구간 백분위 ${out.at(-1)}`);
  assert.ok(out[40] !== null && out[40] < 0.6, `평온 구간 백분위 ${out[40]}`);
});

// ── ADX / DMI ───────────────────────────────────────────────

test('adx: 단조 상승에서 +DI 만 살고 ADX 는 100 에 수렴한다', () => {
  const out = adx(risingBars(60), 14);

  assert.ok(out.adx.at(-1) > 95, `ADX ${out.adx.at(-1)}`);
  assert.ok(out.plusDI.at(-1) > 95, `+DI ${out.plusDI.at(-1)}`);
  assert.ok(Math.abs(out.minusDI.at(-1)) < 1e-9, `−DI ${out.minusDI.at(-1)}`);
});

test('adx: ADX 는 방향에 무관하다 — 단조 하락에서도 100 에 수렴한다', () => {
  // ADX 를 방향 지표로 착각하는 것이 이 지표의 대표적 오용이다.
  const out = adx(fallingBars(60), 14);

  assert.ok(out.adx.at(-1) > 95, `하락장 ADX ${out.adx.at(-1)}`);
  assert.ok(out.minusDI.at(-1) > 95, `−DI ${out.minusDI.at(-1)}`);
  assert.ok(Math.abs(out.plusDI.at(-1)) < 1e-9, `+DI ${out.plusDI.at(-1)}`);
});

test('adx: 가격이 전혀 움직이지 않으면 0 으로 나누지 않고 null 을 준다', () => {
  const out = adx(flatBars(60), 14);
  assert.equal(out.adx.at(-1), null);
  assert.equal(out.plusDI.at(-1), null);
});

test('adx: 방향이 계속 뒤집히면 ADX 가 낮다(횡보 판별)', () => {
  // 고가·저가가 매 봉 번갈아 오르내려야 +DM 과 −DM 이 함께 발생한다.
  // 고가를 고정하면 +DM 이 0 이 되어 오히려 ADX 100 이 나온다.
  const zigzag = Array.from({ length: 80 }, (_, i) =>
    i % 2 === 0 ? bar(100, 105, 95, 100) : bar(100, 104, 94, 100),
  );
  const out = adx(zigzag, 14);
  assert.ok(out.adx.at(-1) < 25, `지그재그 ADX ${out.adx.at(-1)}`);
});

test('adx: 봉이 부족하면 전부 null', () => {
  const out = adx(risingBars(10), 14);
  assert.ok(out.adx.every((v) => v === null));
});

// ── 스토캐스틱 ───────────────────────────────────────────────

test('stochastic: %K 는 구간 내 종가 위치를 백분율로 낸다', () => {
  // 14봉 저가 0, 고가 100, 마지막 종가 75 → %K = 75
  const bars = Array.from({ length: 14 }, (_, i) =>
    i === 0 ? bar(50, 100, 0, 50) : bar(50, 60, 40, i === 13 ? 75 : 50),
  );
  const out = stochastic(bars, 14, 3);
  assert.ok(Math.abs(out.k.at(-1) - 75) < 1e-9, `%K ${out.k.at(-1)}`);
});

test('stochastic: 신고가 종가는 100, 신저가 종가는 0', () => {
  const highClose = Array.from({ length: 20 }, (_, i) => bar(50, 100, 0, i === 19 ? 100 : 50));
  const lowClose = Array.from({ length: 20 }, (_, i) => bar(50, 100, 0, i === 19 ? 0 : 50));

  assert.ok(Math.abs(stochastic(highClose, 14, 3).k.at(-1) - 100) < 1e-9);
  assert.ok(Math.abs(stochastic(lowClose, 14, 3).k.at(-1)) < 1e-9);
});

test('stochastic: %D 는 %K 의 단순이동평균이다', () => {
  const bars = Array.from({ length: 30 }, (_, i) => bar(50, 60 + i, 40 + i, 50 + i));
  const out = stochastic(bars, 14, 3);
  const mean = (out.k.at(-1) + out.k.at(-2) + out.k.at(-3)) / 3;
  assert.ok(Math.abs(out.d.at(-1) - mean) < 1e-9);
});

test('stochastic: 구간 고저가 같으면 0 으로 나누지 않는다', () => {
  const out = stochastic(flatBars(20), 14, 3);
  assert.equal(out.k.at(-1), null);
});

// ── OBV ─────────────────────────────────────────────────────

test('obv: 종가가 오르면 거래량을 더하고 내리면 뺀다', () => {
  const bars = [
    bar(100, 100, 100, 100, 10),
    bar(100, 100, 100, 105, 20), // 상승 → +20
    bar(105, 105, 105, 103, 30), // 하락 → −30
    bar(103, 103, 103, 103, 40), // 보합 → 변화 없음
  ];
  assert.deepEqual(obv(bars), [0, 20, -10, -10]);
});

test('obvSlope: 최근 구간의 OBV 방향 부호를 낸다', () => {
  const up = Array.from({ length: 40 }, (_, i) => bar(100, 100, 100, 100 + i, 10));
  const down = Array.from({ length: 40 }, (_, i) => bar(100, 100, 100, 100 - i, 10));

  assert.equal(obvSlope(obv(up), 20), 1);
  assert.equal(obvSlope(obv(down), 20), -1);
  assert.equal(obvSlope(obv(flatBars(40)), 20), 0);
  assert.equal(obvSlope([1, 2], 20), null, '구간이 부족하면 판정하지 않는다');
});

// ── 스윙과 다이버전스 ────────────────────────────────────────

test('findSwings: 좌우 span 봉보다 크면 고점, 작으면 저점', () => {
  const values = [1, 2, 5, 2, 1, 0, 1, 4, 1];
  const { highs, lows } = findSwings(values, 2);

  // 인덱스 7 은 오른쪽에 span(2)만큼의 봉이 없어 극점으로 확정할 수 없다.
  assert.deepEqual(highs, [2]);
  assert.deepEqual(lows, [5]);
});

test('findSwings: 양쪽 span 이 확보된 인덱스만 극점이 된다', () => {
  const values = [1, 2, 5, 2, 1, 0, 1, 4, 1, 1, 1];
  assert.deepEqual(findSwings(values, 2).highs, [2, 7], '오른쪽이 채워지면 7 도 고점');
});

/*
 * RSI 는 기울기를 보지 않는다. 하락 없이 오르기만 하면 +3/봉이든 +1.4/봉이든
 * 손실 평균이 0이라 RSI 는 똑같이 100 이다. 그래서 2차 상승 구간에 되돌림 봉을
 * 섞어야 비로소 RSI 가 낮아지고 다이버전스가 만들어진다.
 */
test('rsiDivergence: 가격은 신고점인데 RSI 가 낮아지면 하락 다이버전스', () => {
  const closes = [100];
  for (let i = 0; i < 20; i += 1) closes.push(closes.at(-1) + 3); // 단조 급등 → RSI 100
  for (let i = 0; i < 8; i += 1) closes.push(closes.at(-1) - 4); // 조정
  for (let i = 0; i < 30; i += 1) closes.push(closes.at(-1) + (i % 2 ? -2 : 5)); // 되돌림 섞인 상승
  for (let i = 0; i < 6; i += 1) closes.push(closes.at(-1) - 3); // 2차 고점 확정

  // 고점 160(RSI 100) → 175(RSI 70): 가격은 높아졌는데 모멘텀은 식었다
  assert.equal(rsiDivergence(closes, rsi(closes, 14)), 'bearish');
});

test('rsiDivergence: 가격은 신저점인데 RSI 가 올라가면 상승 다이버전스', () => {
  const closes = [300];
  for (let i = 0; i < 20; i += 1) closes.push(closes.at(-1) - 3);
  for (let i = 0; i < 8; i += 1) closes.push(closes.at(-1) + 4);
  for (let i = 0; i < 30; i += 1) closes.push(closes.at(-1) + (i % 2 ? 2 : -5));
  for (let i = 0; i < 6; i += 1) closes.push(closes.at(-1) + 3);

  // 저점 240(RSI 0) → 225(RSI 30)
  assert.equal(rsiDivergence(closes, rsi(closes, 14)), 'bullish');
});

test('rsiDivergence: 스윙이 부족하면 판정하지 않는다', () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.equal(rsiDivergence(closes, rsi(closes, 14)), null);
});
