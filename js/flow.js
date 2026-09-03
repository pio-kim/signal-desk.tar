/**
 * 실시간 수급 — 호가 불균형과 체결강도.
 *
 * 캔들 기반 지표는 본질적으로 지연 지표다. RSI(14) 일봉은 14일치를 평활하므로
 * '지금 사도 되나'에 답하지 못한다. 호가 잔량과 체결 방향은 체결 즉시 바뀌므로
 * 이 화면에서 유일하게 진짜 실시간인 신호다.
 *
 * 순수 판정 함수와 상태를 가진 추적기를 분리해 시간 의존 로직도 테스트한다.
 */

import { flowCategory, labelOfFlowIndicator } from './config.js';

/** 잔량 비율은 이론상 ±1 까지 가능하지만 실전에서 ±0.3 이면 이미 극단이다. */
const IMBALANCE_SATURATION = 0.3;

/** 체결강도는 100 이 균형이고, ±40 이면 한쪽으로 확실히 기운 상태다. */
const STRENGTH_SATURATION = 40;

/** 매도 체결이 0 일 때 Infinity 가 화면까지 번지지 않게 씌우는 상한 */
const STRENGTH_CAP = 999;

/**
 * 체결강도를 신뢰하려면 표본이 있어야 한다.
 *
 * 60초 안에 체결이 두세 건뿐이면 비율이 3배든 0.3배든 우연이다. 그런데도
 * 점수를 내면 근거 없는 강한 신호가 생긴다 — 실제로 매도 체결이 0건일 때
 * 상한 999% 가 +80점(강한 매수)으로 계산되는 것을 관측했다. 거래가 한산한
 * 종목은 판정하지 않는 편이 옳다.
 */
const MIN_TRADES = 10;

const present = (value) => value !== null && value !== undefined && Number.isFinite(value);

const round1 = (value) => Math.round(value * 10) / 10;

/**
 * 호가 불균형 → 점수.
 * @param {number|null} imbalance (총매수잔량 − 총매도잔량) / 합계, −1~1
 */
export function scoreOrderbook(imbalance) {
  if (!present(imbalance)) return null;

  const ratio = Math.max(-1, Math.min(1, imbalance / IMBALANCE_SATURATION));
  const score = Math.round(ratio * 100);

  const verdict =
    score >= 60 ? '매수 잔량 우위' : score >= 20 ? '매수 약우위' : score <= -60 ? '매도 잔량 우위' : score <= -20 ? '매도 약우위' : '균형';

  return { score, verdict, display: `${imbalance > 0 ? '+' : imbalance < 0 ? '−' : ''}${Math.abs(imbalance * 100).toFixed(1)}%` };
}

/**
 * 체결강도 — 최근 윈도우의 매수 체결량 ÷ 매도 체결량 × 100.
 * 국내 거래소 화면의 '체결강도'와 같은 값이다.
 */
export function takerStrength(trades, now, windowMs, minTrades = MIN_TRADES) {
  const from = now - windowMs;
  let bid = 0;
  let ask = 0;
  let count = 0;

  for (const trade of trades) {
    if (trade.at < from) continue;
    count += 1;
    if (trade.side === 'BID') bid += trade.volume;
    else if (trade.side === 'ASK') ask += trade.volume;
  }

  if (count < minTrades) return null;
  if (bid === 0 && ask === 0) return null;
  if (ask === 0) return STRENGTH_CAP;
  return round1((bid / ask) * 100);
}

/** 윈도우 안 체결 건수. 표본이 부족한 이유를 화면에 적는 데 쓴다. */
export function tradesInWindow(trades, now, windowMs) {
  const from = now - windowMs;
  return trades.reduce((count, trade) => (trade.at >= from ? count + 1 : count), 0);
}

export function scoreTaker(strength) {
  if (!present(strength)) return null;

  const deviation = Math.max(-STRENGTH_SATURATION, Math.min(STRENGTH_SATURATION, strength - 100));
  const score = Math.round((deviation / STRENGTH_SATURATION) * 80);

  const verdict =
    score >= 60 ? '매수 체결 강함' : score >= 20 ? '매수 우위' : score <= -60 ? '매도 체결 강함' : score <= -20 ? '매도 우위' : '균형';

  return { score, verdict, display: `${strength.toFixed(0)}%` };
}

const unavailable = (key) => ({
  key,
  label: labelOfFlowIndicator(key),
  score: null,
  verdict: '—',
  display: '데이터 대기',
  available: false,
});

const entry = (key, evaluated) =>
  evaluated
    ? { key, label: labelOfFlowIndicator(key), available: true, ...evaluated }
    : unavailable(key);

/**
 * 종목별 호가·체결 상태를 들고 있으면서 수급 점수를 낸다.
 *
 * @param {{windowMs: number}} options 체결강도 계산 윈도우
 */
export function createFlowTracker({ windowMs = 60_000, minTrades = MIN_TRADES } = {}) {
  const books = new Map();
  const trades = new Map();

  const prune = (coin, now) => {
    const list = trades.get(coin);
    if (!list) return;
    const from = now - windowMs;
    // 앞쪽부터 버린다. 도착 순서대로 쌓이므로 정렬은 필요 없다.
    let cut = 0;
    while (cut < list.length && list[cut].at < from) cut += 1;
    if (cut > 0) list.splice(0, cut);
  };

  return {
    applyOrderbook({ coin, totalBidSize, totalAskSize }) {
      const sum = (totalBidSize ?? 0) + (totalAskSize ?? 0);
      if (!coin || !(sum > 0)) return;
      books.set(coin, { imbalance: round1(((totalBidSize - totalAskSize) / sum) * 1000) / 1000 });
    },

    applyTrade({ coin, side, volume, at = Date.now() }) {
      if (!coin || !present(volume) || volume <= 0) return;
      if (!trades.has(coin)) trades.set(coin, []);
      trades.get(coin).push({ at, side, volume });
    },

    /** 화면에 보이지 않는 종목의 상태를 버린다. 종목을 바꿀 때 호출한다. */
    retain(coins) {
      const keep = new Set(coins);
      for (const key of [...books.keys()]) if (!keep.has(key)) books.delete(key);
      for (const key of [...trades.keys()]) if (!keep.has(key)) trades.delete(key);
    },

    tradeCount(coin) {
      return trades.get(coin)?.length ?? 0;
    },

    /**
     * @returns {{score, imbalance, strength, indicators}} 카테고리 안에서는
     *   단순 평균이므로 두 지표를 평균한다.
     */
    evaluate(coin, now = Date.now()) {
      prune(coin, now);

      const list = trades.get(coin) ?? [];
      const imbalance = books.get(coin)?.imbalance ?? null;
      const strength = takerStrength(list, now, windowMs, minTrades);
      const count = tradesInWindow(list, now, windowMs);

      const taker = entry('taker', scoreTaker(strength));
      if (!taker.available && count > 0) {
        // 왜 판정하지 않는지 적어 준다. 빈 칸은 고장으로 보인다.
        taker.display = `체결 ${count}건 (${minTrades}건 필요)`;
      }

      const indicators = [entry('orderbook', scoreOrderbook(imbalance)), taker];

      const usable = indicators.filter((item) => item.available);
      const score = usable.length
        ? round1(usable.reduce((sum, item) => sum + item.score, 0) / usable.length)
        : null;

      return { score, imbalance, strength, indicators, weight: flowCategory().weight };
    },
  };
}
