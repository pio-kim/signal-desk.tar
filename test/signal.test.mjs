import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  blendCategories,
  categoryScore,
  combineTimeframes,
  evaluateTimeframe,
  gradeOf,
  regimeOf,
  scoreAdx,
  scoreAtr,
  scoreBollinger,
  scoreDivergence,
  scoreMacd,
  scoreObv,
  scoreRsi,
  scoreStochastic,
  scoreTrend,
  scoreVolume,
} from '../js/signal.js';
import { CATEGORIES, candleCategories } from '../js/config.js';

/** 합성 캔들. 종가 배열을 받아 시가/고가/저가/거래량을 그럴듯하게 채운다. */
function candlesFrom(closes, volumes = null) {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    return {
      time: new Date(Date.UTC(2026, 0, 1 + i)),
      kst: `2026-01-${String(i + 1).padStart(2, '0')}T09:00:00`,
      open,
      high: Math.max(open, close) * 1.01,
      low: Math.min(open, close) * 0.99,
      close,
      volume: volumes ? volumes[i] : 100,
    };
  });
}

const indicatorsOf = (result) => result.categories.flatMap((category) => category.indicators);
const findIndicator = (result, key) => indicatorsOf(result).find((entry) => entry.key === key);

// ── 지표별 판정 경계 ─────────────────────────────────────────

test('scoreRsi: 구간 경계에서 정확히 갈린다', () => {
  assert.equal(scoreRsi(29.9).score, 80);
  assert.equal(scoreRsi(30).score, 40);
  assert.equal(scoreRsi(44.9).score, 40);
  assert.equal(scoreRsi(45).score, 0);
  assert.equal(scoreRsi(55).score, 0);
  assert.equal(scoreRsi(55.1).score, -40);
  assert.equal(scoreRsi(70).score, -40);
  assert.equal(scoreRsi(70.1).score, -80);
  assert.equal(scoreRsi(null), null);
});

test('scoreMacd: 최근 3봉 내 부호 전환을 크로스로 본다', () => {
  assert.equal(scoreMacd([-1, -0.5, 0.3]).score, 90);
  assert.equal(scoreMacd([1, 0.5, -0.3]).score, -90);
  assert.equal(scoreMacd([-1, 0.5, 0.6, 0.7, 0.8]).score, 40, '4봉 전 크로스는 만료');
  assert.equal(scoreMacd([2, 3, 4]).score, 40);
  assert.equal(scoreMacd([-2, -3, -4]).score, -40);
  assert.equal(scoreMacd([0, 0, 0]).score, 0);
  assert.equal(scoreMacd([null, null]), null);
  assert.equal(scoreMacd([]), null);
});

test('scoreTrend: 배열 상태와 종가 위치를 조합한다', () => {
  assert.equal(scoreTrend(110, 100, 90).score, 70, '정배열 지지');
  assert.equal(scoreTrend(95, 100, 90).score, 25, '정배열 조정');
  assert.equal(scoreTrend(110, 100, 105).score, -25, '역배열 반등');
  assert.equal(scoreTrend(95, 100, 105).score, -70, '역배열 약세');
  assert.equal(scoreTrend(100, null, 105), null);
});

test('scoreAdx: ADX 가 낮으면 방향이 뚜렷해도 점수를 줄인다', () => {
  // 같은 DI 격차(+30, 포화)라도 국면에 따라 세기가 달라진다.
  assert.equal(scoreAdx(30, 40, 10).score, 80, '추세장 · 상승');
  assert.equal(scoreAdx(22, 40, 10).score, 40, '전환 구간은 절반');
  assert.equal(scoreAdx(12, 40, 10).score, 16, '횡보장의 DI 우위는 곧 뒤집힌다');
  assert.equal(scoreAdx(30, 10, 40).score, -80, '추세장 · 하락');
});

test('scoreAdx: DI 격차 20 에서 포화한다', () => {
  assert.equal(scoreAdx(30, 30, 10).score, 80, '격차 20');
  assert.equal(scoreAdx(30, 60, 10).score, 80, '격차 50도 같은 값');
  assert.equal(scoreAdx(30, 20, 10).score, 40, '격차 10은 절반');
  assert.equal(scoreAdx(30, 20, 20).score, 0, '격차 0');
});

test('scoreAdx: 값이 없으면 null', () => {
  assert.equal(scoreAdx(null, 30, 10), null);
  assert.equal(scoreAdx(30, null, 10), null);
});

test('scoreStochastic: %K 구간과 %D 교차를 함께 본다', () => {
  assert.equal(scoreStochastic(15, 10).score, 80, '과매도에서 %K 가 %D 위 → 반전 시작');
  assert.equal(scoreStochastic(15, 20).score, 50, '과매도지만 아직 하락 교차');
  assert.equal(scoreStochastic(30, 30).score, 35);
  assert.equal(scoreStochastic(50, 50).score, 0);
  assert.equal(scoreStochastic(70, 70).score, -35);
  assert.equal(scoreStochastic(90, 95).score, -80, '과매수에서 %K 가 %D 아래');
  assert.equal(scoreStochastic(90, 85).score, -50, '과매수지만 아직 상승 교차');
  assert.equal(scoreStochastic(null, null), null);
});

test('scoreDivergence: 있을 때만 강한 신호다', () => {
  assert.equal(scoreDivergence('bullish').score, 70);
  assert.equal(scoreDivergence('bearish').score, -70);
  assert.equal(scoreDivergence(null).score, 0);
  assert.equal(scoreDivergence(null).verdict, '없음');
});

test('scoreAtr: 변동성은 방향이 없으므로 가격 방향과 짝지어야 한다', () => {
  const up = { open: 100, close: 110 };
  const down = { open: 110, close: 100 };

  assert.equal(scoreAtr(0.9, up).score, 40, '확장 + 상승');
  assert.equal(scoreAtr(0.9, down).score, -40, '확장 + 하락');
  assert.equal(scoreAtr(0.2, up).score, 0, '압축은 방향을 모른다');
  assert.equal(scoreAtr(0.2, up).verdict, '변동성 압축');
  assert.equal(scoreAtr(0.5, up).score, 0);
  assert.equal(scoreAtr(null, up), null);
});

test('scoreVolume: 거래량 급증만으로는 방향이 정해지지 않는다', () => {
  assert.equal(scoreVolume(1.2, { open: 100, close: 110 }).score, 50);
  assert.equal(scoreVolume(1.2, { open: 110, close: 100 }).score, -50);
  assert.equal(scoreVolume(1.19, { open: 100, close: 110 }).score, 0);
  assert.equal(scoreVolume(null, { open: 100, close: 110 }), null);
});

test('scoreObv: 가격과 어긋나면 점수를 깎는다', () => {
  assert.equal(scoreObv(1, true).score, 60, '가격도 오르고 OBV 도 오름');
  assert.equal(scoreObv(-1, false).score, -60);
  assert.equal(scoreObv(1, false).score, 30, '가격은 내리는데 OBV 상승 → 얇은 추세');
  assert.equal(scoreObv(-1, true).score, -30);
  assert.equal(scoreObv(0, true).score, 0);
  assert.equal(scoreObv(null, true), null);
});

// ── 카테고리 계층 ────────────────────────────────────────────

test('categoryScore: 카테고리 안에서는 단순 평균이다', () => {
  // 상관 높은 지표가 중복 투표하지 않도록 내부 가중을 두지 않는다.
  const score = categoryScore([
    { score: 90, available: true },
    { score: 30, available: true },
    { score: 0, available: true },
  ]);
  assert.equal(score, 40);
});

test('categoryScore: 계산 불가 지표는 분모에서도 빠진다', () => {
  assert.equal(
    categoryScore([
      { score: 60, available: true },
      { score: 20, available: true },
      { score: null, available: false },
    ]),
    40,
  );
  assert.equal(categoryScore([{ score: null, available: false }]), null);
  assert.equal(categoryScore([]), null);
});

test('regimeOf: ADX 25 이상 추세장, 20 미만 횡보장', () => {
  assert.equal(regimeOf(25).key, 'trending');
  assert.equal(regimeOf(24.9).key, 'neutral');
  assert.equal(regimeOf(20).key, 'neutral');
  assert.equal(regimeOf(19.9).key, 'ranging');
  assert.equal(regimeOf(null).key, 'unknown');
});

test('regimeOf: 추세장은 추세를 키우고 모멘텀을 줄인다', () => {
  assert.deepEqual(regimeOf(30).adjust, { trend: 1.5, momentum: 0.7, volatility: 0.8 });
  assert.deepEqual(regimeOf(10).adjust, { trend: 0.6, momentum: 1.3, volatility: 1.2 });
  assert.deepEqual(regimeOf(22).adjust, { trend: 1, momentum: 1, volatility: 1 });
});

test('blendCategories: 가중 평균이고 조정치를 곱한다', () => {
  const score = blendCategories([
    { score: 100, weight: 1.2, adjust: 1 },
    { score: 0, weight: 0.8, adjust: 1 },
  ]);
  assert.equal(score, 60, '(100×1.2 + 0×0.8) / 2.0');
});

test('blendCategories: 값 없는 카테고리는 분모에서도 빠진다', () => {
  assert.equal(blendCategories([{ score: 40, weight: 1 }, { score: null, weight: 9 }]), 40);
  assert.equal(blendCategories([]), null);
});

/**
 * 이 테스트가 이번 확장의 핵심을 지킨다. 지표값이 똑같아도 국면에 따라 등급이
 * 중립 → 매수 → 매도로 바뀌어야 한다. 추세장에서 과매수를 매도로 세면 추세
 * 신호가 상쇄돼 버리는 것이 기존 구조의 결함이었다.
 */
test('ADX 국면에 따라 같은 지표가 다른 등급을 낸다', () => {
  const build = (adx) => {
    const adjust = regimeOf(adx).adjust;
    return blendCategories([
      { score: 70, weight: 1.2, adjust: adjust.trend }, // 추세: 정배열
      { score: -80, weight: 1.0, adjust: adjust.momentum }, // 모멘텀: 과매수
    ]);
  };

  const ranging = build(10);
  const neutral = build(22);
  const trending = build(30);

  assert.equal(neutral, 1.8, '평탄 가중이면 상쇄되어 중립');
  assert.equal(trending, 28, '추세장에서는 추세를 신뢰');
  assert.equal(ranging, -26.5, '횡보장에서는 과매수를 신뢰');

  assert.equal(gradeOf(neutral).key, 'neutral');
  assert.equal(gradeOf(trending).key, 'buy');
  assert.equal(gradeOf(ranging).key, 'sell');
});

test('gradeOf: 등급 경계', () => {
  assert.equal(gradeOf(50).key, 'strong-buy');
  assert.equal(gradeOf(49.9).key, 'buy');
  assert.equal(gradeOf(20).key, 'buy');
  assert.equal(gradeOf(19.9).key, 'neutral');
  assert.equal(gradeOf(-19.9).key, 'neutral');
  assert.equal(gradeOf(-20).key, 'sell');
  assert.equal(gradeOf(-49.9).key, 'sell');
  assert.equal(gradeOf(-50).key, 'strong-sell');
  assert.equal(gradeOf(null).key, 'unknown');
  assert.equal(gradeOf(80).label, '강력매수');
  assert.equal(gradeOf(-80).label, '강력매도');
});

// ── 봉 주기 평가 ─────────────────────────────────────────────

test('evaluateTimeframe: 캔들 기반 카테고리 4개와 지표 10개를 낸다', () => {
  const closes = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 6) * 12 + i * 0.4);
  const result = evaluateTimeframe(candlesFrom(closes));

  assert.deepEqual(
    result.categories.map((c) => c.key),
    ['trend', 'momentum', 'volatility', 'volume'],
    '실시간 수급은 봉 주기 차원에 넣지 않는다',
  );
  assert.deepEqual(
    indicatorsOf(result).map((entry) => entry.key),
    ['ma', 'macd', 'adx', 'rsi', 'stochastic', 'divergence', 'bollinger', 'atr', 'volume', 'obv'],
  );
  assert.ok(indicatorsOf(result).every((entry) => entry.available), '전부 계산 가능해야 한다');
  assert.ok(result.score >= -100 && result.score <= 100);
  assert.equal(result.grade.key, gradeOf(result.score).key);
  assert.ok(['trending', 'ranging', 'neutral'].includes(result.regime.key));
});

test('evaluateTimeframe: 점수는 카테고리 가중 평균과 일치한다', () => {
  const closes = Array.from({ length: 200 }, (_, i) => 100 + Math.cos(i / 5) * 8);
  const result = evaluateTimeframe(candlesFrom(closes));
  assert.equal(result.score, blendCategories(result.categories));
});

test('evaluateTimeframe: 카테고리 점수는 그 안 지표의 평균과 일치한다', () => {
  const closes = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 9) * 15);
  const result = evaluateTimeframe(candlesFrom(closes));

  for (const category of result.categories) {
    assert.equal(category.score, categoryScore(category.indicators), `${category.label}`);
  }
});

test('evaluateTimeframe: 거래량은 진행 중인 봉이 아니라 직전 완결봉으로 판정한다', () => {
  const closes = Array.from({ length: 100 }, (_, i) => 100 + i);
  const volumes = Array.from({ length: 100 }, (_, i) => (i === 98 ? 500 : i === 99 ? 1 : 100));

  const volume = findIndicator(evaluateTimeframe(candlesFrom(closes, volumes)), 'volume');
  assert.equal(volume.score, 50, '직전 완결봉의 거래량 급증을 잡아야 한다');
  assert.equal(volume.display, '평균의 5.00배');
});

test('evaluateTimeframe: 캔들이 부족하면 점수 없이 사유를 남긴다', () => {
  const result = evaluateTimeframe(candlesFrom([100, 101, 102]));

  assert.equal(result.score, null);
  assert.equal(result.grade.key, 'unknown');
  assert.ok(
    indicatorsOf(result).every((entry) => !entry.available && entry.display === '데이터 부족'),
    '계산 불가 지표는 사유를 표시한다',
  );
});

test('evaluateTimeframe: 캔들이 없어도 예외를 던지지 않는다', () => {
  const result = evaluateTimeframe([]);
  assert.equal(result.score, null);
  assert.equal(indicatorsOf(result).length, 10);
});

test('combineTimeframes: 일봉 0.5 / 4시간 0.3 / 1시간 0.2 가중', () => {
  assert.equal(combineTimeframes({ day: 100, h4: 100, h1: 100 }), 100);
  assert.equal(combineTimeframes({ day: 100, h4: 0, h1: 0 }), 50);
  assert.equal(combineTimeframes({ day: 0, h4: 0, h1: 100 }), 20);
});

test('combineTimeframes: 값 있는 주기만으로 다시 정규화한다', () => {
  assert.equal(combineTimeframes({ day: 100, h4: 0, h1: null }), 62.5);
  assert.equal(combineTimeframes({ day: null, h4: null, h1: -40 }), -40);
  assert.equal(combineTimeframes({ day: null, h4: null, h1: null }), null);
  assert.equal(combineTimeframes({}), null);
});

// ── 설정 계약 ───────────────────────────────────────────────

test('CATEGORIES: 지시서에 정한 카테고리와 가중치를 유지한다', () => {
  assert.deepEqual(
    CATEGORIES.map((c) => [c.key, c.weight, c.candleBased]),
    [
      ['trend', 1.2, true],
      ['momentum', 1.0, true],
      ['volatility', 0.8, true],
      ['volume', 0.7, true],
      ['flow', 1.0, false],
      ['sentiment', 0.6, false],
    ],
  );
});

test('CATEGORIES: 캔들 기반 카테고리는 넷이고 지표는 열 개다', () => {
  const candle = candleCategories();
  assert.equal(candle.length, 4);
  assert.equal(candle.flatMap((c) => c.indicators).length, 10);
  // 실시간 수급은 전체 가중의 21% 를 차지한다(1.0 / 4.7).
  const candleWeight = candle.reduce((sum, c) => sum + c.weight, 0);
  assert.equal(candleWeight, 3.7);
});
