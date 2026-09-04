/**
 * 거래소별 시그널을 하나로 모으는 계층. 순수 함수만 둔다.
 *
 * 이 파일이 이번 확장의 산출물이다 — 거래소가 여러 곳이라서 새로 알 수 있는
 * 것은 '세 곳이 같은 방향을 가리키는가'이고, 그 판단을 여기서 만든다.
 */

import { GRADE_THRESHOLDS, candleCategories, flowCategory, sentimentCategory } from './config.js';

const round1 = (value) => Math.round(value * 10) / 10;

const present = (value) => value !== null && value !== undefined && Number.isFinite(value);

/** 등급 경계와 같은 기준으로 방향만 뽑는다. */
export function directionOf(score) {
  if (!present(score)) return null;
  if (score >= GRADE_THRESHOLDS.buy) return 'buy';
  if (score <= GRADE_THRESHOLDS.sell) return 'sell';
  return 'neutral';
}

/**
 * 거래대금 가중이 아니라 등가중 평균이다. 세 거래소 점수는 같은 시장을 세 번
 * 측정한 값이고, 한쪽을 더 신뢰할 근거가 없을 때 측정치를 합치는 표준 방식이
 * 등가중이다. 거래대금으로 가중하면 바이낸스가 사실상 단독 결정하게 되어
 * 합의도라는 개념 자체가 무의미해진다.
 */
export function averageScore(scores) {
  const valid = scores.filter(present);
  if (!valid.length) return null;
  return round1(valid.reduce((sum, score) => sum + score, 0) / valid.length);
}

const DIRECTION_LABELS = {
  buy: '매수 우세',
  sell: '매도 우세',
  neutral: '중립',
};

/**
 * 점수와 합의도는 서로 다른 것을 잰다.
 *
 * - `score` 는 등가중 평균이다. 정직한 집계값이다.
 * - `direction`/`agree` 는 **거래소들이 서로 일치하는지**를 잰다. 그래서 평균의
 *   방향이 아니라 거래소별 방향의 최다값을 쓴다.
 *
 * 평균에서 방향을 파생시키면 45/40/−30 이 '중립'으로 뭉개져 두 곳이 매수를
 * 가리켰다는 사실이 사라진다. 이견이 상쇄로 위장되는 셈이다. 두 값을 나란히
 * 두면 '점수는 중립인데 두 곳은 매수'라는 상태를 그대로 읽을 수 있다.
 *
 * @param {Record<string, number|null>} scoreByExchange
 * @returns {{score, direction, agree, total, label, byExchange}}
 */
export function consensus(scoreByExchange) {
  const entries = Object.entries(scoreByExchange).map(([exchange, score]) => ({
    exchange,
    score: present(score) ? score : null,
    direction: directionOf(score),
  }));

  const valid = entries.filter((entry) => entry.score !== null);
  const score = averageScore(valid.map((entry) => entry.score));
  const total = valid.length;

  const tally = new Map();
  for (const entry of valid) tally.set(entry.direction, (tally.get(entry.direction) ?? 0) + 1);

  const top = Math.max(0, ...tally.values());
  const leaders = [...tally.entries()].filter(([, count]) => count === top);

  // 최다 방향이 둘 이상으로 갈리면 다수라고 부를 수 없다. 평균 방향으로 적고 이견으로 표시한다.
  const tied = leaders.length > 1;
  const direction = total === 0 ? null : tied ? directionOf(score) : leaders[0][0];
  const agree = valid.filter((entry) => entry.direction === direction).length;

  return {
    score,
    direction,
    agree,
    total,
    label: tied ? '이견' : labelOf(agree, total),
    byExchange: entries,
  };
}

function labelOf(agree, total) {
  if (total === 0) return '데이터 없음';
  if (total === 1) return '단독 판정';
  if (agree === total) return '완전 일치';
  if (agree * 2 > total) return '다수 일치';
  return '이견';
}

export function directionLabel(direction) {
  return DIRECTION_LABELS[direction] ?? '판정 불가';
}

/** 달러 시세를 시장 환율로 원화 환산한다. */
export function impliedKrw(usdtPrice, usdtKrw) {
  if (!present(usdtPrice) || !present(usdtKrw)) return null;
  return usdtPrice * usdtKrw;
}

/**
 * 거래소 간 괴리. 업비트 원화 가격을 업비트 KRW-USDT 시장가로 환산한
 * 해외 가격과 비교한다.
 *
 * 흔히 말하는 '김치 프리미엄'과 다른 값이라는 점이 중요하다. 그쪽은 은행
 * USD/KRW 환율을 쓰기 때문에 USDT 자체의 프리미엄까지 포함해 보통 1~3% 로
 * 나온다. 여기서 재는 것은 그 성분을 걷어낸 **거래소 사이의 순수 가격 차이**라
 * 평소 0% 근처에 머문다. 같은 이름을 쓰면 2% 를 기대하고 0.03% 를 보게 되므로
 * 화면에서도 'USDT 기준 괴리'로 적는다.
 *
 * 이 값은 시그널 점수에 넣지 않는다. 의미가 국면에 따라 뒤집히고, 점수에 섞으면
 * 가격에 이미 반영된 정보를 이중으로 세게 된다.
 */
export function crossExchangeGap({ krwPrice, usdtPrice, usdtKrw }) {
  const reference = impliedKrw(usdtPrice, usdtKrw);
  if (!present(krwPrice) || !present(reference) || reference === 0) return null;
  return krwPrice / reference - 1;
}

/**
 * 캔들 기반 합의 점수에 봉 주기가 없는 카테고리를 합산해 최종 시그널을 낸다.
 *
 * 수급·심리를 봉 주기별 점수에 각각 더하면 같은 값이 세 번 세어진다. 캔들
 * 계층을 끝까지 접은 뒤 마지막에 한 번만 얹는 것이 옳다. 가중은 카테고리 정의를
 * 그대로 쓴다 — 캔들 4.6 : 수급 1.0 : 심리 0.6 이므로 수급 16.1%, 심리 9.7% 다.
 *
 * @param {number|null} consensusScore 거래소 합의(캔들) 점수
 * @param {{flow?: number|null, sentiment?: number|null}} extras
 */
export function withExternal(consensusScore, extras = {}) {
  const parts = [
    { score: consensusScore, weight: candleCategories().reduce((sum, c) => sum + c.weight, 0) },
    { score: extras.flow ?? null, weight: flowCategory().weight },
    { score: extras.sentiment ?? null, weight: sentimentCategory().weight },
  ];

  let total = 0;
  let weightSum = 0;

  for (const part of parts) {
    if (!present(part.score)) continue;
    total += part.score * part.weight;
    weightSum += part.weight;
  }

  return weightSum === 0 ? null : round1(total / weightSum);
}
