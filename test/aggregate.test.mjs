import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  averageScore,
  consensus,
  directionOf,
  impliedKrw,
  crossExchangeGap,
  withExternal,
} from '../js/aggregate.js';

test('directionOf: 등급 경계와 같은 기준으로 방향을 나눈다', () => {
  assert.equal(directionOf(80), 'buy');
  assert.equal(directionOf(20), 'buy');
  assert.equal(directionOf(19.9), 'neutral');
  assert.equal(directionOf(0), 'neutral');
  assert.equal(directionOf(-19.9), 'neutral');
  assert.equal(directionOf(-20), 'sell');
  assert.equal(directionOf(-80), 'sell');
  assert.equal(directionOf(null), null);
});

test('averageScore: 거래대금이 아니라 등가중 평균이다', () => {
  // 세 거래소 점수는 같은 시장을 세 번 측정한 값이므로 한쪽을 더 세지 않는다.
  assert.equal(averageScore([30, 60, 90]), 60);
  assert.equal(averageScore([10]), 10);
});

test('averageScore: 값 없는 거래소는 분모에서도 빠진다', () => {
  assert.equal(averageScore([40, null, 60]), 50);
  assert.equal(averageScore([null, null]), null);
  assert.equal(averageScore([]), null);
});

test('consensus: 세 거래소가 같은 방향이면 완전 일치', () => {
  const result = consensus({ upbit: 42, binance: 36, bybit: 35 });

  assert.equal(result.score, 37.7);
  assert.equal(result.direction, 'buy');
  assert.equal(result.agree, 3);
  assert.equal(result.total, 3);
  assert.equal(result.label, '완전 일치');
});

test('consensus: 평균이 중립이어도 두 곳이 매수면 다수 일치로 남는다', () => {
  // 평균은 (45+40−30)/3 = 18.3 으로 중립이지만, 두 거래소는 매수를 가리킨다.
  // 합의도가 평균에서 파생되면 이 사실이 상쇄로 위장돼 사라진다.
  const result = consensus({ upbit: 45, binance: 40, bybit: -30 });

  assert.equal(result.score, 18.3);
  assert.equal(directionOf(result.score), 'neutral', '점수 자체는 중립이다');
  assert.equal(result.direction, 'buy', '합의 방향은 거래소 다수결이다');
  assert.equal(result.agree, 2);
  assert.equal(result.label, '다수 일치');
});

test('consensus: 한 곳의 강한 값이 평균을 끌어올려도 다수 방향은 유지된다', () => {
  // +60 / −30 / −25 → 평균 1.7(중립)이지만 두 곳은 매도다.
  const result = consensus({ upbit: 60, binance: -30, bybit: -25 });

  assert.equal(result.score, 1.7);
  assert.equal(result.direction, 'sell');
  assert.equal(result.agree, 2);
  assert.equal(result.label, '다수 일치');
});

test('consensus: 세 방향이 모두 다르면 다수라고 부르지 않는다', () => {
  const result = consensus({ upbit: 60, binance: -60, bybit: 0 });

  assert.equal(result.total, 3);
  assert.equal(result.label, '이견');
  assert.equal(result.direction, 'neutral', '동수일 때는 평균 방향으로 적는다');
});

test('consensus: 거래소 하나만 살아 있으면 단독 판정으로 표시한다', () => {
  const result = consensus({ upbit: 55, binance: null, bybit: null });

  assert.equal(result.score, 55);
  assert.equal(result.agree, 1);
  assert.equal(result.total, 1);
  assert.equal(result.label, '단독 판정');
});

test('consensus: 데이터가 하나도 없으면 판정하지 않는다', () => {
  const result = consensus({ upbit: null, binance: null, bybit: null });

  assert.equal(result.score, null);
  assert.equal(result.direction, null);
  assert.equal(result.total, 0);
  assert.equal(result.label, '데이터 없음');
});

test('impliedKrw: 달러 시세를 시장 환율로 원화 환산한다', () => {
  assert.equal(impliedKrw(70000, 1400), 98_000_000);
  assert.equal(impliedKrw(null, 1400), null);
  assert.equal(impliedKrw(70000, null), null);
});

test('crossExchangeGap: 국내 가격이 환산가보다 높으면 양수', () => {
  // 환산가 98,000,000 대비 국내 99,960,000 → +2%
  const premium = crossExchangeGap({ krwPrice: 99_960_000, usdtPrice: 70_000, usdtKrw: 1400 });
  assert.ok(Math.abs(premium - 0.02) < 1e-9, `기대 0.02, 실제 ${premium}`);
});

test('crossExchangeGap: 국내가 더 싸면 음수(역프리미엄)', () => {
  const premium = crossExchangeGap({ krwPrice: 96_040_000, usdtPrice: 70_000, usdtKrw: 1400 });
  assert.ok(Math.abs(premium + 0.02) < 1e-9, `기대 −0.02, 실제 ${premium}`);
});

test('crossExchangeGap: 값이 빠지거나 0이면 계산하지 않는다', () => {
  assert.equal(crossExchangeGap({ krwPrice: null, usdtPrice: 70_000, usdtKrw: 1400 }), null);
  assert.equal(crossExchangeGap({ krwPrice: 1, usdtPrice: 0, usdtKrw: 1400 }), null);
  assert.equal(crossExchangeGap({ krwPrice: 1, usdtPrice: 70_000, usdtKrw: 0 }), null);
});

test('withExternal: 캔들 4.6 : 수급 1.0 : 심리 0.6 으로 합친다', () => {
  // 수급 16.1%, 심리 9.7% 를 차지한다.
  assert.equal(withExternal(0, { flow: 100, sentiment: 0 }), 16.1);
  assert.equal(withExternal(0, { flow: 0, sentiment: 100 }), 9.7);
  assert.equal(withExternal(50, { flow: 50, sentiment: 50 }), 50);
});

test('withExternal: 없는 항목은 분모에서도 빠진다', () => {
  assert.equal(withExternal(40, {}), 40, '수급·심리 대기 중에도 화면은 동작해야 한다');
  assert.equal(withExternal(null, { flow: -60 }), -60);
  assert.equal(withExternal(null, { sentiment: -60 }), -60);
  assert.equal(withExternal(null, {}), null);
});

test('withExternal: 심리만 빠져도 수급 비중은 그대로다', () => {
  // 심리를 못 받는 상황(순수 정적 서버)에서도 캔들:수급 비율이 유지돼야 한다.
  assert.equal(withExternal(0, { flow: 100 }), 17.9);
});
