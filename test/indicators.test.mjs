import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  sma,
  ema,
  rsi,
  macd,
  bollinger,
  volumeRatio,
} from '../js/indicators.js';

/** 부동소수 비교. 지표는 나눗셈이 섞이므로 정확 비교는 쓸 수 없다. */
function near(actual, expected, tolerance = 1e-9, label = '') {
  assert.ok(
    actual !== null && Math.abs(actual - expected) < tolerance,
    `${label} 기대 ${expected}, 실제 ${actual}`,
  );
}

test('sma: 기간이 채워지기 전에는 null, 이후 단순 평균', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test('sma: 입력보다 기간이 길면 전부 null', () => {
  assert.deepEqual(sma([1, 2], 5), [null, null]);
});

test('sma: 빈 입력은 빈 배열', () => {
  assert.deepEqual(sma([], 3), []);
});

test('ema: 첫 값은 SMA로 시드하고 이후 k=2/(n+1)로 평활', () => {
  // period 3 -> k = 0.5, 시드 = mean(1,2,3) = 2
  // ema[3] = (4-2)*0.5+2 = 3, ema[4] = (5-3)*0.5+3 = 4
  assert.deepEqual(ema([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test('rsi: Wilder 평활 결과가 손계산과 일치', () => {
  // 종가 [10,11,10,11], period 2
  // 변화 +1,-1,+1 -> 초기 avgGain=0.5 avgLoss=0.5 -> RSI 50
  // 다음 봉: avgGain=(0.5+1)/2=0.75, avgLoss=(0.5+0)/2=0.25 -> RS 3 -> RSI 75
  const out = rsi([10, 11, 10, 11], 2);
  assert.equal(out[0], null);
  assert.equal(out[1], null);
  near(out[2], 50, 1e-9, 'rsi[2]');
  near(out[3], 75, 1e-9, 'rsi[3]');
});

test('rsi: 하락이 전혀 없으면 100, 상승이 전혀 없으면 0', () => {
  const up = rsi([1, 2, 3, 4, 5, 6], 5);
  const down = rsi([6, 5, 4, 3, 2, 1], 5);
  near(up.at(-1), 100, 1e-9, '전량 상승');
  near(down.at(-1), 0, 1e-9, '전량 하락');
});

test('rsi: 캔들이 기간보다 적으면 전부 null', () => {
  assert.deepEqual(rsi([1, 2], 14), [null, null]);
});

test('macd: 느린 기간이 채워지기 전에는 null, 상승 추세에서는 양수', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
  const out = macd(closes, 12, 26, 9);

  assert.equal(out.macd.length, 60);
  assert.equal(out.macd[24], null, '느린 EMA 이전은 null');
  assert.ok(out.macd[25] !== null, '느린 EMA가 채워지는 지점부터 값 존재');
  assert.ok(out.macd.at(-1) > 0, '단조 상승에서 MACD는 양수');
  assert.equal(out.signal[25 + 7], null, '시그널선은 MACD 9개가 모여야 시작');
  assert.ok(out.signal[25 + 8] !== null);
  near(
    out.histogram.at(-1),
    out.macd.at(-1) - out.signal.at(-1),
    1e-9,
    '히스토그램 = MACD - 시그널',
  );
});

test('macd: 기울기가 일정한 추세에서 히스토그램은 0이 된다', () => {
  // 히스토그램은 모멘텀의 '변화'를 재는 값이다. 등차로 오르는 구간은
  // 모멘텀이 일정하므로 MACD가 상수로 수렴하고 시그널선이 따라붙는다.
  const closes = Array.from({ length: 80 }, (_, i) => 100 + i * 2);
  near(macd(closes).histogram.at(-1), 0, 1e-6, '등차 상승의 히스토그램');
});

test('macd: 가속 상승은 양수, 하락 전환은 음수 히스토그램', () => {
  const rising = Array.from({ length: 60 }, (_, i) => 100 * 1.02 ** i);
  const peak = rising.at(-1);
  const falling = Array.from({ length: 20 }, (_, i) => peak * (1 - 0.03 * (i + 1)));
  const out = macd([...rising, ...falling], 12, 26, 9);

  assert.ok(out.histogram[59] > 0, '가속 상승 구간에서는 양수');
  assert.ok(out.histogram.at(-1) < 0, '하락 전환 후에는 음수');
});

test('bollinger: 모집단 표준편차 기준으로 밴드와 %B를 계산', () => {
  // 교과서 예제: 평균 5, 모집단 시그마 2
  const closes = [2, 4, 4, 4, 5, 5, 7, 9];
  const out = bollinger(closes, 8, 2);

  near(out.middle.at(-1), 5, 1e-9, 'middle');
  near(out.upper.at(-1), 9, 1e-9, 'upper');
  near(out.lower.at(-1), 1, 1e-9, 'lower');
  near(out.percentB.at(-1), 1, 1e-9, '종가가 상단과 같으면 %B = 1');
});

test('bollinger: 변동이 없으면 밴드 폭이 0이고 %B는 null', () => {
  const out = bollinger([5, 5, 5, 5], 4, 2);
  near(out.upper.at(-1), 5, 1e-9, 'upper');
  assert.equal(out.percentB.at(-1), null, '0으로 나누지 않는다');
});

test('volumeRatio: 직전 N봉 평균과 현재 봉을 비교한다', () => {
  // 직전 4봉 평균 1 대비 현재 4 -> 4배
  const out = volumeRatio([1, 1, 1, 1, 4], 4);
  assert.equal(out[3], null, '직전 4봉이 모이기 전에는 null');
  near(out[4], 4, 1e-9, 'ratio');
});

test('volumeRatio: 직전 구간 평균이 0이면 null', () => {
  const out = volumeRatio([0, 0, 5], 2);
  assert.equal(out[2], null);
});
