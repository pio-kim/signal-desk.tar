/**
 * 종목별 탐욕지수 테스트.
 *
 * 성분 매핑을 각각 순수 함수로 떼어 두었으므로 경계를 직접 찔러본다.
 * 캔들로 RSI 를 정확히 원하는 값으로 만드는 것은 역산이 필요해 불가능하다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  attentionComponent,
  blendComponents,
  greedIndex,
  greedLabel,
  momentumComponent,
  socialComponent,
  volatilityComponent,
  volumeComponent,
} from '../js/greed.js';

const bar = (open, high, low, close, volume = 100) => ({ open, high, low, close, volume });

/** 계단식 상승 캔들. RSI·ATR·거래량이 모두 계산될 만큼 길게 만든다. */
function risingCandles(count = 160) {
  return Array.from({ length: count }, (_, i) => {
    const base = 100 + i;
    return bar(base, base + 1.5, base - 0.5, base + 1, 100 + (i % 7) * 5);
  });
}

// ── 성분 매핑 ───────────────────────────────────────────────

test('momentumComponent: RSI 는 이미 0~100 이라 그대로 쓴다', () => {
  assert.equal(momentumComponent(70), 70);
  assert.equal(momentumComponent(0), 0);
  assert.equal(momentumComponent(100), 100);
  assert.equal(momentumComponent(null), null);
});

/**
 * 원 지수도 '이례적 변동성은 공포' 로 본다. 그대로 넣으면 방향이 뒤집힌다.
 */
test('volatilityComponent: 변동성이 크면 공포 쪽으로 간다(역방향)', () => {
  assert.equal(volatilityComponent(0.9), 10, '백분위 90% → 지수 10');
  assert.equal(volatilityComponent(0.1), 90, '백분위 10% → 지수 90');
  assert.equal(volatilityComponent(0.5), 50);
  assert.equal(volatilityComponent(null), null);
});

test('volumeComponent: 평균 대비 배수를 0~100 으로 눌러 담는다', () => {
  assert.equal(volumeComponent(1), 50, '평균이면 중립');
  assert.equal(volumeComponent(2), 100, '2배면 상한');
  assert.equal(volumeComponent(3), 100, '2배를 넘겨도 같은 값');
  assert.equal(volumeComponent(0.5), 0, '절반이면 하한');
  assert.equal(volumeComponent(0.2), 0);
  assert.equal(volumeComponent(1.5), 75);
  assert.equal(volumeComponent(0.75), 25);
  assert.equal(volumeComponent(null), null);
});

test('socialComponent: 상승 투표 비율을 그대로 쓴다', () => {
  assert.equal(socialComponent(75), 75);
  assert.equal(socialComponent(null), null);
});

test('attentionComponent: 검색 상위 진입만 알 수 있어 두 값뿐이다', () => {
  assert.equal(attentionComponent(true), 75);
  assert.equal(attentionComponent(false), 45);
  assert.equal(attentionComponent(null), null);
  assert.equal(attentionComponent(undefined), null);
});

// ── 성분 합산 ───────────────────────────────────────────────

test('blendComponents: 지정한 가중으로 합산한다', () => {
  const value = blendComponents([
    { key: 'momentum', value: 100, weight: 0.35 },
    { key: 'volatility', value: 0, weight: 0.25 },
    { key: 'volume', value: 50, weight: 0.2 },
    { key: 'social', value: 50, weight: 0.12 },
    { key: 'attention', value: 45, weight: 0.08 },
  ]);
  // 35 + 0 + 10 + 6 + 3.6 = 54.6
  assert.equal(value, 54.6);
});

test('blendComponents: 없는 성분은 분모에서도 빠져 재정규화된다', () => {
  // 모멘텀만 있으면 그 값이 그대로 지수가 된다.
  assert.equal(
    blendComponents([
      { key: 'momentum', value: 70, weight: 0.35 },
      { key: 'volatility', value: null, weight: 0.25 },
    ]),
    70,
  );
  assert.equal(blendComponents([{ key: 'momentum', value: null, weight: 0.35 }]), null);
  assert.equal(blendComponents([]), null);
});

// ── 등급 ────────────────────────────────────────────────────

test('greedLabel: 원 지수와 같은 구간을 쓴다', () => {
  assert.equal(greedLabel(0).label, '극단적 공포');
  assert.equal(greedLabel(24).label, '극단적 공포');
  assert.equal(greedLabel(25).label, '공포');
  assert.equal(greedLabel(49).label, '공포');
  assert.equal(greedLabel(50).label, '탐욕');
  assert.equal(greedLabel(74).label, '탐욕');
  assert.equal(greedLabel(75).label, '극단적 탐욕');
  assert.equal(greedLabel(100).label, '극단적 탐욕');
  assert.equal(greedLabel(null).label, '판정 불가');
});

test('greedLabel: 공포와 탐욕을 색으로 구분할 키를 준다', () => {
  assert.equal(greedLabel(10).key, 'extreme-fear');
  assert.equal(greedLabel(30).key, 'fear');
  assert.equal(greedLabel(60).key, 'greed');
  assert.equal(greedLabel(90).key, 'extreme-greed');
});

// ── 통합 ────────────────────────────────────────────────────

test('greedIndex: 캔들만 있어도 지수가 나온다', () => {
  const result = greedIndex({ candles: risingCandles() });

  assert.ok(result.value !== null, '캔들 기반 성분 셋으로 계산된다');
  assert.ok(result.value >= 0 && result.value <= 100, `실제 ${result.value}`);
  assert.equal(result.label, greedLabel(result.value).label);

  const available = result.components.filter((c) => c.value !== null).map((c) => c.key);
  assert.deepEqual(available, ['momentum', 'volatility', 'volume']);
});

test('greedIndex: 투표와 트렌딩이 있으면 성분 다섯 개가 모두 찬다', () => {
  const result = greedIndex({
    candles: risingCandles(),
    votes: { up: 80 },
    trending: true,
  });

  assert.deepEqual(
    result.components.map((c) => c.key),
    ['momentum', 'volatility', 'volume', 'social', 'attention'],
  );
  assert.ok(result.components.every((c) => c.value !== null));
});

test('greedIndex: 상승 추세는 탐욕 쪽으로 나온다', () => {
  // RSI 가 100 에 가까우므로 모멘텀 성분이 지수를 끌어올린다.
  const result = greedIndex({ candles: risingCandles() });
  assert.ok(result.value > 50, `실제 ${result.value}`);
});

test('greedIndex: 캔들이 부족하면 있는 성분만으로 계산한다', () => {
  const result = greedIndex({ candles: [bar(100, 101, 99, 100)], votes: { up: 30 } });

  assert.equal(result.value, 30, '투표 성분만 남는다');
  assert.equal(result.components.find((c) => c.key === 'momentum').value, null);
});

test('greedIndex: 아무 데이터도 없으면 판정하지 않는다', () => {
  const empty = greedIndex({});
  assert.equal(empty.value, null);
  assert.equal(empty.label, '판정 불가');
  assert.ok(empty.components.every((c) => c.value === null));
});

test('greedIndex: 성분 가중 합은 1 이다', () => {
  const total = greedIndex({}).components.reduce((sum, c) => sum + c.weight, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `실제 ${total}`);
});

/*
 * signal.js 에서 이미 고친 함정을 이 파일에서 반복했다. 진행 중인 봉의 누적
 * 거래량을 완결봉 평균과 비교하면 봉 초반에 언제나 낮게 읽혀, 실제로 세 종목
 * 모두 거래량 성분이 0 으로 나왔다.
 */
test('greedIndex: 거래량은 진행 중인 봉이 아니라 직전 완결봉으로 본다', () => {
  const candles = Array.from({ length: 60 }, (_, i) =>
    // 마지막 봉은 방금 시작해 거래량이 1뿐이고, 직전 완결봉은 평균의 3배다.
    bar(100 + i, 101 + i, 99 + i, 100 + i, i === 59 ? 1 : i === 58 ? 300 : 100),
  );

  const volume = greedIndex({ candles }).components.find((c) => c.key === 'volume');
  assert.equal(volume.value, 100, '직전 완결봉의 3배 거래량이 상한에 닿는다');
});

test('greedIndex: 봉이 하나뿐이면 거래량 성분은 없다', () => {
  const volume = greedIndex({ candles: [bar(100, 101, 99, 100)] }).components.find(
    (c) => c.key === 'volume',
  );
  assert.equal(volume.value, null, '비교할 직전 봉이 없다');
});
