/**
 * 판정을 사람이 읽는 설명으로 옮기는 계층. 순수 함수만 둔다.
 *
 * `signal.js` 가 '점수가 얼마인가'를 답한다면 이 파일은 '왜 그 점수인가'를
 * 답한다. 화면에 숫자만 늘어놓으면 가격이 크게 올랐는데 등급이 중립인 상황을
 * 사용자가 결함으로 읽는다 — 실제로는 추세(매수)와 과매수(매도)가 상쇄된
 * 정상 동작이다. 그 상쇄를 눈에 보이게 만드는 것이 이 파일의 목적이다.
 *
 * DOM 에 의존하지 않으므로 문장과 힘 배분을 테스트로 고정할 수 있다.
 */

import {
  GRADE_THRESHOLDS,
  TIMEFRAMES,
  candleCategories,
  flowCategory,
  sentimentCategory,
} from './config.js';
import { gradeOf } from './signal.js';
// 문장 속 점수와 막대 옆 숫자가 어긋나면 안 되므로 표기를 한 곳에서 가져온다.
import { formatScore } from './format.js';

const present = (value) => value !== null && value !== undefined && Number.isFinite(value);

const round1 = (value) => Math.round(value * 10) / 10;

/**
 * 받침 유무로 조사를 고른다. 한글 음절이 아니면 받침 있는 쪽을 쓴다 —
 * 영문·숫자로 끝나는 라벨은 대체로 자음으로 읽힌다.
 */
export function withParticle(word, withBatchim, withoutBatchim) {
  const code = word?.length ? word.charCodeAt(word.length - 1) : 0;
  if (code < 0xac00 || code > 0xd7a3) return `${word}${withBatchim}`;
  return `${word}${(code - 0xac00) % 28 === 0 ? withoutBatchim : withBatchim}`;
}

/**
 * 등급이 실제로 무엇을 하라는 말인지. 배지 옆에 붙는다.
 *
 * '중립' 은 '신호 없음' 이 아니라 '근거가 양쪽으로 갈렸다' 는 뜻인데, 라벨만
 * 보면 그 차이가 드러나지 않는다.
 */
export const ACTION_BY_GRADE = {
  'strong-buy': '적극 매수 구간',
  buy: '매수 우위',
  neutral: '관망 — 방향이 갈림',
  sell: '매도 우위',
  'strong-sell': '적극 매도 구간',
  unknown: '데이터 부족',
};

export const actionOf = (grade) => ACTION_BY_GRADE[grade?.key] ?? ACTION_BY_GRADE.unknown;

/** 등급 경계값. config 의 단일 원본을 그대로 쓴다. */
const BOUNDARIES = [
  GRADE_THRESHOLDS.buy,
  GRADE_THRESHOLDS.strongBuy,
  GRADE_THRESHOLDS.sell,
  GRADE_THRESHOLDS.strongSell,
];

/**
 * 가장 가까운 등급 경계까지 남은 점수.
 *
 * 19.9 를 '중립' 이라고만 적으면 매수 기준선(20.0)에서 0.1점 모자란 상태와
 * 0점짜리 중립이 화면에서 똑같아 보인다. 실제로 이 때문에 '많이 올랐는데 왜
 * 아직 중립이냐' 는 질문이 나왔다.
 *
 * 등급 산출 자체는 건드리지 않는다 — 표시만 더한다.
 *
 * @returns {{label: string, gap: number, direction: 'up'|'down'}|null}
 */
export function gradeGap(score) {
  if (!present(score)) return null;

  let best = null;
  for (const at of BOUNDARIES) {
    const gap = round1(Math.abs(at - score));
    // 같은 거리면 매수 쪽을 먼저 잡는다(BOUNDARIES 순서). 임의 선택이지만
    // 0점에서 '매도까지 20' 보다 '매수까지 20' 이 덜 놀랍다.
    if (best && gap >= best.gap) continue;
    const up = score < at;
    // 그 경계를 넘으면 어떤 등급이 되는지로 라벨을 만든다.
    best = { label: gradeOf(up ? at : at - 0.1).label, gap, direction: up ? 'up' : 'down' };
  }
  return best;
}

/** 경계가 이만큼 가까우면 '아슬아슬' 로 강조한다. */
export const NEAR_BOUNDARY = 3;

export const isNearBoundary = (gap) => present(gap?.gap) && gap.gap <= NEAR_BOUNDARY;

/**
 * 카드에 그릴 '힘 배분'. 카테고리마다 점수 × 유효가중을 당기는 힘으로 본다.
 *
 * 캔들 카테고리는 참조 거래소의 봉 주기 점수를 TIMEFRAMES 가중으로 접는다.
 * ⚠️ 최종 점수는 거래소 여러 곳의 평균이라 이 값과 정확히 같지 않다. 근사임을
 * 감추지 않으려고 화면에는 어느 거래소 기준인지 함께 적는다.
 *
 * 유효가중에는 ADX 국면 조정이 이미 반영돼 있다(`category.adjust`). 추세장에서
 * 추세 가중이 1.2 가 아니라 1.8 로 보이는 것이 정상이다.
 *
 * @param {object} evaluation recompute() 가 만든 종목 평가
 * @param {string} exchangeId 기준 거래소
 * @returns {Array<{key, label, score, weight, pull, ratio}>} |pull| 내림차순
 */
export function categoryForces(evaluation, exchangeId) {
  const byTimeframe = evaluation?.byExchange?.[exchangeId]?.byTimeframe;
  const forces = [];

  for (const template of candleCategories()) {
    let total = 0;
    let weightSum = 0;
    let adjustSum = 0;
    let adjustCount = 0;

    for (const timeframe of TIMEFRAMES) {
      const found = byTimeframe?.[timeframe.key]?.categories?.find(
        (category) => category.key === template.key,
      );
      if (!found || !present(found.score)) continue;
      total += found.score * timeframe.weight;
      weightSum += timeframe.weight;
      adjustSum += found.adjust ?? 1;
      adjustCount += 1;
    }

    if (weightSum === 0) continue;
    const adjust = adjustCount ? adjustSum / adjustCount : 1;
    forces.push({
      key: template.key,
      label: template.label,
      score: round1(total / weightSum),
      weight: Math.round(template.weight * adjust * 100) / 100,
    });
  }

  // 봉 주기가 없는 두 카테고리는 접을 것이 없으므로 그대로 얹는다.
  if (present(evaluation?.flow?.score)) {
    const category = flowCategory();
    forces.push({
      key: category.key,
      label: category.label,
      score: round1(evaluation.flow.score),
      weight: category.weight,
    });
  }
  if (present(evaluation?.sentiment?.score)) {
    const category = sentimentCategory();
    forces.push({
      key: category.key,
      label: category.label,
      score: round1(evaluation.sentiment.score),
      weight: category.weight,
    });
  }

  for (const force of forces) force.pull = round1(force.score * force.weight);
  // 막대 길이는 가장 센 힘 대비 상대 크기다. 절대 점수로 그리면 모든 카드가
  // 비슷한 길이로 보여 어느 쪽이 이기는지 드러나지 않는다.
  const strongest = Math.max(1, ...forces.map((force) => Math.abs(force.pull)));
  for (const force of forces) force.ratio = Math.abs(force.pull) / strongest;

  return forces.sort((a, b) => Math.abs(b.pull) - Math.abs(a.pull));
}

/**
 * 캔들 카테고리가 하나라도 들어 있는가.
 *
 * 수급·심리는 거래소와 무관하게 계산되므로, 그 거래소가 이 종목의 캔들을
 * 못 주더라도 `categoryForces` 는 빈 배열이 아니다. 길이만 보고 '데이터 있음'
 * 으로 판단하면 캔들 없는 거래소를 기준으로 삼은 채 대표 거래소로 물러나지
 * 못한다.
 */
export function hasCandleForces(forces) {
  const keys = new Set(candleCategories().map((category) => category.key));
  return Boolean(forces?.some((force) => keys.has(force.key)));
}

/**
 * 힘 배분을 한 문장으로 옮긴다. 가장 세게 당기는 매수 힘과 매도 힘을 짚는다.
 *
 * 이 문장이 카드에서 사용자가 가장 먼저 읽는 줄이다 — 숫자를 계산해 보지
 * 않아도 '무엇과 무엇이 싸우는지' 는 알 수 있어야 한다.
 */
export function explainForces(forces, grade) {
  if (!forces?.length) return null;

  const buys = forces.filter((force) => force.pull > 0);
  const sells = forces.filter((force) => force.pull < 0);
  const [buy] = buys;
  const [sell] = sells;

  const names = (list) => list.slice(0, 3).map((force) => force.label).join('·');

  if (buy && !sell) {
    return `${withParticle(names(buys), '이', '가')} 모두 매수를 가리킵니다.`;
  }
  if (sell && !buy) {
    return `${withParticle(names(sells), '이', '가')} 모두 매도를 가리킵니다.`;
  }
  if (!buy || !sell) return null;

  const buyPart = `${buy.label} 매수(${formatScore(buy.score)})`;
  const sellPart = `${sell.label} 매도(${formatScore(sell.score)})`;

  if (grade?.key === 'buy' || grade?.key === 'strong-buy') {
    return `${withParticle(buyPart, '이', '가')} ${withParticle(sellPart, '을', '를')} 이겼습니다.`;
  }
  if (grade?.key === 'sell' || grade?.key === 'strong-sell') {
    return `${withParticle(sellPart, '이', '가')} ${withParticle(buyPart, '을', '를')} 눌렀습니다.`;
  }
  return `${withParticle(buy.label, '은', '는')} 매수(${formatScore(buy.score)})인데 ${withParticle(sell.label, '이', '가')} 매도(${formatScore(sell.score)})로 맞서 상쇄됐습니다.`;
}

/**
 * 과열·과냉 주석.
 *
 * '가격이 많이 올랐는데 왜 매수가 아니냐' 에 대한 직접적인 답이다. 추세가
 * 살아 있는데 모멘텀·변동성이 반대로 도는 것은 지표 오류가 아니라 과매수의
 * 정의 그 자체다. 이 문장이 없으면 사용자는 계속 결함으로 읽는다.
 *
 * @returns {{tone: 'hot'|'cold', text: string}|null}
 */
export function overheatNote(forces) {
  const at = (key) => forces?.find((force) => force.key === key) ?? null;
  const trend = at('trend');
  if (!trend) return null;

  const momentum = at('momentum');
  const volatility = at('volatility');

  if (trend.score >= 40 && [momentum, volatility].some((f) => f && f.score <= -30)) {
    return {
      tone: 'hot',
      text: '많이 올라 과매수 구간입니다. 추세는 살아 있지만 지금 진입은 되돌림 위험을 함께 안습니다.',
    };
  }
  if (trend.score <= -40 && [momentum, volatility].some((f) => f && f.score >= 30)) {
    return {
      tone: 'cold',
      text: '많이 내려 과매도 구간입니다. 하락 추세는 이어지고 있지만 반등 시도가 나올 수 있습니다.',
    };
  }
  return null;
}
