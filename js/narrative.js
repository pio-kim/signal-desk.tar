/**
 * 서술형 차트 해설 — "chart/" 참고 이미지(매매 교재 스타일) 재현.
 *
 * patterns.js 가 '무엇이 감지됐는가'를 순수 계산으로 낸다면, 여기서는 그
 * 결과를 이미지 속 20개 패턴명(상승형 5 · 하락형 5 · 희망 5 · 공포 5,
 * 단 '바닥 다지기'는 상승형과 희망에 같은 뜻으로 두 번 나와 실제로는 19종)
 * 과 지지/저항선 매수·매도 진입 신호로 이름 붙여 하나의 번호 매겨진
 * 리포트로 합친다. patterns.js 처럼 순수 함수만 둔다 — DOM 은 모른다.
 *
 * 많은 이름이 근본적으로 같은 재료(스윙 극점·박스권·추세선)를 다른 각도로
 * 읽은 것이라, 저수준 판정 함수를 공유하고 그 위에 '어느 이름을 붙일지'를
 * 정하는 얇은 층을 얹었다. 예: '하락 후 반등' · '상승 후 하락' ·
 * '고점에서 하락' · 'V자 하락' 은 전부 swingReversal() 하나가 만들고,
 * 특징(주요 고점인가·며칠 만에 만들어졌는가)에 따라 이름만 갈린다.
 */

import { swingPoints, supportResistanceLevels, triangle, wedge, heldBreakouts, doubleExtremes } from './patterns.js';
import { sma } from './indicators.js';
import { PERIODS } from './config.js';
import { formatPrice } from './format.js';

const present = (value) => value !== null && value !== undefined && Number.isFinite(value);

// ── 박스권(바닥 다지기 · 고점 형성 · 그 돌파) ───────────────────

/** 박스권으로 볼 최근 봉 수 */
const BASE_WINDOW = 20;
/** 박스 계산에서 제외하고 '지금 돌파했는가'만 보는 최근 봉 수 — 돌파 시도 봉이 박스 폭
 *  계산에 섞이면 range 가 늘어나 돌파 직후에 오히려 조건이 깨지는 자기모순이 생긴다 */
const BASE_RECENT_OFFSET = 4;
/** 고저 폭이 저가 대비 이 비율 이하여야 '박스권'으로 본다 */
const BASE_RANGE_MAX = 0.06;
/** 저점권/고점권인지 비교할 장기 구간 */
const BASE_LOOKBACK = 60;
/** 박스가 장기 최저/최고 대비 이 안에 있어야 '그 권역'으로 본다 */
const BASE_EXTREME_TOLERANCE = 0.04;
/** 박스 경계를 이만큼 넘겨 종가로 닫아야 돌파로 본다 */
const BASE_BREAK_MARGIN = 0.006;

/**
 * 박스권 — 최근 구간이 저점권/고점권에서 좁게 횡보하고 있는지, 이미 그
 * 박스를 벗어났는지를 함께 판정한다.
 *
 * @param {'bottom'|'top'} side
 */
function baseRange(candles, side) {
  const n = candles.length;
  if (n < BASE_WINDOW + BASE_RECENT_OFFSET + 1) return null;

  const boxEnd = n - BASE_RECENT_OFFSET;
  const boxCandles = candles.slice(boxEnd - BASE_WINDOW, boxEnd);
  const rangeHigh = Math.max(...boxCandles.map((c) => c.high));
  const rangeLow = Math.min(...boxCandles.map((c) => c.low));
  if (rangeLow <= 0) return null;
  if ((rangeHigh - rangeLow) / rangeLow > BASE_RANGE_MAX) return null;

  const lookbackCandles = candles.slice(Math.max(0, boxEnd - BASE_LOOKBACK));
  const extremeLow = Math.min(...lookbackCandles.map((c) => c.low));
  const extremeHigh = Math.max(...lookbackCandles.map((c) => c.high));

  if (side === 'bottom' && (rangeLow - extremeLow) / extremeLow > BASE_EXTREME_TOLERANCE) return null;
  if (side === 'top' && (extremeHigh - rangeHigh) / extremeHigh > BASE_EXTREME_TOLERANCE) return null;

  const lastIndex = n - 1;
  const lastClose = candles[lastIndex].close;
  let resolved = null;
  if (side === 'bottom' && lastClose > rangeHigh * (1 + BASE_BREAK_MARGIN)) resolved = 'up';
  if (side === 'top' && lastClose < rangeLow * (1 - BASE_BREAK_MARGIN)) resolved = 'down';

  return {
    side,
    resolved,
    rangeHigh,
    rangeLow,
    anchorIndex: resolved ? lastIndex : boxEnd - 1,
    anchorPrice: resolved ? lastClose : side === 'bottom' ? rangeLow : rangeHigh,
  };
}

// ── 스윙 반전(하락후반등 · 상승후하락 · 고점에서하락 · V자하락) ──

/** 반전 전 있었던 반대 방향 움직임의 최소 폭 — 이게 없으면 그냥 첫 스윙이지 '반전'이 아니다 */
const REVERSAL_MIN_LEG = 0.04;
/** 극점 이후 지금까지 되돌린 최소 폭 */
const REVERSAL_MIN_BOUNCE = 0.02;
/** 극점이 이 안에서 형성돼야 '최근 반전'으로 본다 */
const REVERSAL_LOOKBACK_BARS = 30;
/** '주요(장기) 극점'인지 비교할 구간 */
const REVERSAL_MAJOR_LOOKBACK = 60;
/** 이전 극점→지금 극점까지 이 이내면 '가파르다'(V자) */
const REVERSAL_SHARP_BARS = 8;
/** V자는 되돌림 폭도 이보다 커야 한다 */
const REVERSAL_SHARP_MIN_BOUNCE = 0.05;

/**
 * 스윙 반전 — 최근 스윙 극점이 그 이전 반대 방향 움직임을 뒤집고 있는지
 * 본다. bullish 는 저점 기준(하락 후 반등), bearish 는 고점 기준(상승 후
 * 하락 · 고점에서 하락 · V자 하락 — 세 이름 중 하나는 호출부가 sharp/major
 * 플래그로 고른다).
 */
function swingReversal(candles, direction, span) {
  const { highs, lows } = swingPoints(candles, span);
  const points = direction === 'bullish' ? lows : highs;
  const opposite = direction === 'bullish' ? highs : lows;
  if (!points.length) return null;

  const extreme = points.at(-1);
  const n = candles.length;
  const barsSince = n - 1 - extreme.index;
  if (barsSince < 0 || barsSince > REVERSAL_LOOKBACK_BARS) return null;

  const priorOpposite = [...opposite].reverse().find((p) => p.index < extreme.index);
  if (!priorOpposite) return null;
  const leg = Math.abs(priorOpposite.price - extreme.price) / priorOpposite.price;
  if (leg < REVERSAL_MIN_LEG) return null;

  const lastClose = candles[n - 1].close;
  const bounce =
    direction === 'bullish'
      ? (lastClose - extreme.price) / extreme.price
      : (extreme.price - lastClose) / extreme.price;
  if (bounce < REVERSAL_MIN_BOUNCE) return null;

  const sharp = extreme.index - priorOpposite.index <= REVERSAL_SHARP_BARS && bounce >= REVERSAL_SHARP_MIN_BOUNCE;

  const majorWindow = candles.slice(Math.max(0, extreme.index - REVERSAL_MAJOR_LOOKBACK), extreme.index + 1);
  const majorValue =
    direction === 'bullish'
      ? Math.min(...majorWindow.map((c) => c.low))
      : Math.max(...majorWindow.map((c) => c.high));
  const major = direction === 'bullish' ? extreme.price <= majorValue * 1.001 : extreme.price >= majorValue * 0.999;

  return { direction, extreme, bounce, sharp, major };
}

// ── 장기 바닥 확인 ───────────────────────────────────────────

/** 장기 최저가를 비교할 구간 */
const LTB_LOOKBACK = 90;
/** 저점 형성 후 이만큼 지나야 '확인'됐다고 본다 */
const LTB_CONFIRM_BARS = 10;
/** 그 저점이 장기 최저와 거의 같다고 볼 오차 */
const LTB_TOLERANCE = 0.01;
/** 확인 기간 동안 이 아래로 재하락하면 무효 */
const LTB_NO_REBREAK = 0.002;

function longTermBottom(candles, span) {
  const n = candles.length;
  const { lows } = swingPoints(candles, span);
  if (!lows.length) return null;

  const lookbackFrom = Math.max(0, n - LTB_LOOKBACK);
  const lookbackLow = Math.min(...candles.slice(lookbackFrom).map((c) => c.low));

  // 가장 최근 스윙이 아니라 '그 장기 저점'을 찾는다 — 오래됐어도 아직 유효해야 한다.
  const candidate = lows.find(
    (p) => p.index >= lookbackFrom && (p.price - lookbackLow) / lookbackLow <= LTB_TOLERANCE,
  );
  if (!candidate) return null;

  const barsSince = n - 1 - candidate.index;
  if (barsSince < LTB_CONFIRM_BARS) return null;

  const afterLow = Math.min(...candles.slice(candidate.index + 1).map((c) => c.low));
  if (afterLow < candidate.price * (1 - LTB_NO_REBREAK)) return null; // 그 뒤 더 깨졌다 — 확인된 바닥이 아니다

  return { index: candidate.index, price: candidate.price, barsSince };
}

// ── 추세 전환 신호(MA 골든크로스) ────────────────────────────

/** 이 안에서 크로스가 났어야 '방금 신호'로 본다 */
const TREND_SIGNAL_LOOKBACK = 10;

function trendReversalSignal(candles) {
  const closes = candles.map((c) => c.close);
  const ma20 = sma(closes, PERIODS.maShort);
  const ma60 = sma(closes, PERIODS.maLong);
  const n = candles.length;

  for (let i = n - 1; i >= Math.max(1, n - TREND_SIGNAL_LOOKBACK); i -= 1) {
    if (!present(ma20[i]) || !present(ma60[i]) || !present(ma20[i - 1]) || !present(ma60[i - 1])) continue;
    if (ma20[i] > ma60[i] && ma20[i - 1] <= ma60[i - 1]) return { index: i, price: candles[i].close };
  }
  return null;
}

// ── 추세 단계(상승 추세 · 추세 하락) ─────────────────────────

function trendStage(candles, span) {
  const { highs, lows } = swingPoints(candles, span);
  if (highs.length < 2 || lows.length < 2) return null;

  const [h1, h2] = highs.slice(-2);
  const [l1, l2] = lows.slice(-2);
  const closes = candles.map((c) => c.close);
  const ma20 = sma(closes, PERIODS.maShort);
  const ma60 = sma(closes, PERIODS.maLong);
  const n = candles.length;
  const lastMa20 = ma20[n - 1];
  const lastMa60 = ma60[n - 1];
  if (!present(lastMa20) || !present(lastMa60)) return null;
  const lastClose = closes[n - 1];

  if (h2.price > h1.price && l2.price > l1.price && lastClose > lastMa20 && lastMa20 > lastMa60) {
    return { direction: 'up', anchor: l2 };
  }
  if (h2.price < h1.price && l2.price < l1.price && lastClose < lastMa20 && lastMa20 < lastMa60) {
    return { direction: 'down', anchor: h2 };
  }
  return null;
}

// ── 지지/저항 진입 신호(매수 · 매도 · 진입) ─────────────────

/** 상위 몇 개 레벨까지 진입 신호로 볼지 */
const ENTRY_LEVEL_LIMIT = 3;
/** 레벨당 최근 몇 번 터치까지 표시할지 — 오래된 터치까지 늘어놓으면 차트가 어지럽다 */
const ENTRY_TOUCHES_PER_LEVEL = 2;
/** 돌파 이벤트와 레벨을 같은 것으로 볼 가격 오차 */
const ENTRY_RETEST_TOLERANCE = 0.01;
/** 현재가가 레벨에 이 안으로 붙어 있어야 '지금 매수/매도 관점'으로 본다 */
const STANCE_PROXIMITY = 0.01;

/**
 * 지지/저항 레벨의 각 터치 지점을 매수/매도 관점으로 표시한다. 확정
 * 돌파(heldBreakouts)로 역할이 바뀐 레벨(저항→지지, 지지→저항)을 그 뒤에
 * **반대편** 스윙이 다시 짚었다면 '진입'(재확인)으로 더 강하게 표시한다
 * — 저항을 뚫고 버텼으면 그 뒤의 스윙 저점을, 지지를 깨고 버텼으면 그
 * 뒤의 스윙 고점을 본다(터치 자체의 성격이 뒤집히기 때문이다).
 */
function entryPoints(candles, span) {
  const levels = supportResistanceLevels(candles, { span }).slice(0, ENTRY_LEVEL_LIMIT);
  const points = [];

  for (const level of levels) {
    const touches = level.indices.slice(-ENTRY_TOUCHES_PER_LEVEL);
    for (const index of touches) {
      points.push({
        kind: level.kind === 'support' ? 'buy' : 'sell',
        index,
        price: level.kind === 'support' ? candles[index].low : candles[index].high,
        level,
      });
    }
  }

  const { highs, lows } = swingPoints(candles, span);
  for (const event of heldBreakouts(candles, { span })) {
    const opposite = event.kind === 'breakout-up' ? lows : highs;
    const retest = opposite.find(
      (p) => p.index > event.breakIndex && Math.abs(p.price - event.level.price) / event.level.price < ENTRY_RETEST_TOLERANCE,
    );
    if (retest) points.push({ kind: 'enter', index: retest.index, price: retest.price, level: event.level });
  }

  return points;
}

/** 현재가가 어느 레벨에 근접해 있는지 — '지금 매수/매도 관점' 한 줄 요약용 */
function currentStance(candles, levels) {
  const lastClose = candles.at(-1).close;
  let nearest = null;
  for (const level of levels) {
    const dist = Math.abs(lastClose - level.price) / level.price;
    if (!nearest || dist < nearest.dist) nearest = { level, dist };
  }
  if (!nearest || nearest.dist > STANCE_PROXIMITY) return null;
  return { stance: nearest.level.kind === 'support' ? 'buy' : 'sell', level: nearest.level, price: lastClose };
}

// ── 전부 합쳐 번호 매긴 리포트로 ─────────────────────────────

/** 차트 한 장에 얹을 배지 총량. 넘치면 최근 진입 신호부터 잘라낸다(구조 패턴이 우선) */
const MAX_ANALYSIS_ITEMS = 14;

export {
  baseRange,
  swingReversal,
  longTermBottom,
  trendReversalSignal,
  trendStage,
  entryPoints,
  currentStance,
};

/**
 * 캔들 하나를 넣으면 chart/ 참고 이미지 스타일의 번호 매긴 구조 패턴 +
 * 지지/저항 진입 신호를 시간순으로 매긴다.
 *
 * @returns {{items: Array<{number, index, price, side, group, label, text}>, stance: object|null}}
 *   `side` 는 배지를 극점 위(above)/아래(below) 어디에 그릴지, `group` 은
 *   색 구분(bullish/bearish/buy/sell/enter)이다.
 */
export function analyzeChart(candles, { span = 5, quote = 'KRW' } = {}) {
  if (!candles || candles.length < BASE_WINDOW + BASE_RECENT_OFFSET + 1) return { items: [], stance: null, levels: [] };

  const n = candles.length;
  const levels = supportResistanceLevels(candles, { span });
  const structure = [];

  const bottomBase = baseRange(candles, 'bottom');
  if (bottomBase) {
    structure.push(
      bottomBase.resolved === 'up'
        ? {
            code: 'base-up',
            label: '바닥 다지기 후 상승',
            group: 'bullish',
            index: bottomBase.anchorIndex,
            price: bottomBase.anchorPrice,
            side: 'below',
            text: `바닥 다지기 후 상승 · ${formatPrice(bottomBase.rangeLow, quote)}~${formatPrice(bottomBase.rangeHigh, quote)} 박스권을 위로 이탈`,
          }
        : {
            code: 'base-bottom',
            label: '바닥 다지기',
            group: 'bullish',
            index: bottomBase.anchorIndex,
            price: bottomBase.anchorPrice,
            side: 'below',
            text: `바닥 다지기 · ${formatPrice(bottomBase.rangeLow, quote)}~${formatPrice(bottomBase.rangeHigh, quote)} 박스권에서 저점권 횡보 중`,
          },
    );
  }

  const topBase = baseRange(candles, 'top');
  if (topBase) {
    structure.push(
      topBase.resolved === 'down'
        ? {
            code: 'top-down',
            label: '횡보 후 하락',
            group: 'bearish',
            index: topBase.anchorIndex,
            price: topBase.anchorPrice,
            side: 'above',
            text: `횡보 후 하락 · ${formatPrice(topBase.rangeLow, quote)}~${formatPrice(topBase.rangeHigh, quote)} 박스권을 아래로 이탈`,
          }
        : {
            code: 'top-formation',
            label: '고점 형성',
            group: 'bearish',
            index: topBase.anchorIndex,
            price: topBase.anchorPrice,
            side: 'above',
            text: `고점 형성 · ${formatPrice(topBase.rangeLow, quote)}~${formatPrice(topBase.rangeHigh, quote)} 박스권에서 고점권 횡보 중`,
          },
    );
  }

  const bull = swingReversal(candles, 'bullish', span);
  if (bull) {
    structure.push({
      code: 'decline-rebound',
      label: '하락 후 반등',
      group: 'bullish',
      index: bull.extreme.index,
      price: bull.extreme.price,
      side: 'below',
      text: `하락 후 반등 · ${formatPrice(bull.extreme.price, quote)} 저점 확인 후 반등 진행 중`,
    });
  }

  const bear = swingReversal(candles, 'bearish', span);
  if (bear) {
    const label = bear.sharp ? 'V자 하락' : bear.major ? '고점에서 하락' : '상승 후 하락';
    const code = bear.sharp ? 'v-decline' : bear.major ? 'major-high-decline' : 'rise-decline';
    structure.push({
      code,
      label,
      group: 'bearish',
      index: bear.extreme.index,
      price: bear.extreme.price,
      side: 'above',
      text: `${label} · ${formatPrice(bear.extreme.price, quote)} 고점 확인 후 하락 진행 중`,
    });
  }

  const tri = triangle(candles, { span });
  if (tri && tri.kind !== 'symmetric') {
    const bullishTri = tri.kind === 'ascending';
    structure.push({
      code: bullishTri ? 'triangle-up' : 'triangle-down',
      label: bullishTri ? '상승 삼각형' : '하락 삼각형',
      group: bullishTri ? 'bullish' : 'bearish',
      index: n - 1,
      price: candles[n - 1].close,
      side: bullishTri ? 'below' : 'above',
      text: `${bullishTri ? '상승' : '하락'} 삼각형 수렴 중`,
    });
  }

  const w = wedge(candles, { span });
  if (w && w.breakout) {
    const bullishW = w.breakout === 'up';
    structure.push({
      code: bullishW ? 'wedge-up' : 'wedge-down',
      label: bullishW ? '상승 쐐기형' : '하락 쐐기형',
      group: bullishW ? 'bullish' : 'bearish',
      index: n - 1,
      price: candles[n - 1].close,
      side: bullishW ? 'below' : 'above',
      text: `${bullishW ? '상승' : '하락'} 쐐기형 · ${w.kind === 'rising' ? '상승' : '하락'} 채널을 ${bullishW ? '위로' : '아래로'} 돌파`,
    });
  }

  const ltb = longTermBottom(candles, span);
  if (ltb) {
    structure.push({
      code: 'long-term-bottom',
      label: '장기 바닥 확인',
      group: 'bullish',
      index: ltb.index,
      price: ltb.price,
      side: 'below',
      text: `장기 바닥 확인 · ${formatPrice(ltb.price, quote)} 저점이 ${ltb.barsSince}봉째 유지 중`,
    });
  }

  const trs = trendReversalSignal(candles);
  if (trs) {
    structure.push({
      code: 'trend-reversal-signal',
      label: '추세 전환 신호',
      group: 'bullish',
      index: trs.index,
      price: trs.price,
      side: 'below',
      text: `추세 전환 신호 · MA${PERIODS.maShort}이 MA${PERIODS.maLong}을 상향 돌파(골든크로스)`,
    });
  }

  const stage = trendStage(candles, span);
  if (stage) {
    const up = stage.direction === 'up';
    structure.push({
      code: up ? 'trend-up' : 'trend-down',
      label: up ? '상승 추세' : '추세 하락',
      group: up ? 'bullish' : 'bearish',
      index: stage.anchor.index,
      price: stage.anchor.price,
      side: up ? 'below' : 'above',
      text: `${up ? '상승' : '하락'} 추세 · 고점과 저점이 연속으로 ${up ? '높아지고' : '낮아지고'} 있음`,
    });
  }

  const topDouble = doubleExtremes(candles, { span }).find((d) => d.kind === 'double-top' && d.completed);
  if (topDouble) {
    const peak = topDouble.points[1];
    structure.push({
      code: 'downtrend-reversal',
      label: '하락 추세 전환',
      group: 'bearish',
      index: peak.index,
      price: peak.price,
      side: 'above',
      text: `하락 추세 전환 · 쌍봉 넥라인 ${formatPrice(topDouble.neckline.price, quote)} 하향 돌파`,
    });
  }

  // 박스권 돌파(base-up/top-down)로 이미 설명한 레벨은 지지선/저항선 돌파로 중복 표시하지 않는다.
  const claimedLevelPrices = [];
  if (bottomBase?.resolved === 'up') claimedLevelPrices.push(bottomBase.rangeHigh);
  if (topBase?.resolved === 'down') claimedLevelPrices.push(topBase.rangeLow);

  for (const event of heldBreakouts(candles, { span })) {
    const claimed = claimedLevelPrices.some((price) => Math.abs(event.level.price - price) / price < 0.01);
    if (claimed) continue;

    const bullishEvent = event.kind === 'breakout-up';
    structure.push({
      code: bullishEvent ? 'support-breakout' : 'resistance-breakout',
      label: bullishEvent ? '지지선 돌파' : '저항선 돌파',
      group: bullishEvent ? 'bullish' : 'bearish',
      index: event.breakIndex,
      price: event.breakPrice,
      side: bullishEvent ? 'below' : 'above',
      text: bullishEvent
        ? `지지선 돌파 · 저항선 ${formatPrice(event.level.price, quote)}을 돌파해 지지선으로 전환, ${event.bars}봉째 유지 중`
        : `저항선 돌파 · 지지선 ${formatPrice(event.level.price, quote)}을 이탈해 저항선으로 전환, ${event.bars}봉째 유지 중`,
    });
  }

  const entries = entryPoints(candles, span).map((point) => ({
    code: point.kind,
    group: point.kind,
    index: point.index,
    price: point.price,
    side:
      point.kind === 'sell'
        ? 'above'
        : point.kind === 'buy'
          ? 'below'
          : point.level.kind === 'resistance' // enter: 원래 저항이었으면 지금은 지지 역할 → 저점 재확인
            ? 'below'
            : 'above',
    label: point.kind === 'enter' ? '진입' : point.kind === 'buy' ? '매수' : '매도',
    text:
      point.kind === 'enter'
        ? `진입! · ${point.level.kind === 'support' ? '지지선' : '저항선'} ${formatPrice(point.level.price, quote)} 재확인`
        : `${point.kind === 'buy' ? '매수' : '매도'} 관점 · ${point.kind === 'buy' ? '지지선' : '저항선'} ${formatPrice(point.level.price, quote)} 터치`,
  }));

  const sortedStructure = [...structure].sort((a, b) => a.index - b.index).slice(0, MAX_ANALYSIS_ITEMS);
  const entryBudget = Math.max(0, MAX_ANALYSIS_ITEMS - sortedStructure.length);
  const trimmedEntries = [...entries]
    .sort((a, b) => b.index - a.index) // 최신 진입 신호부터 채우고
    .slice(0, entryBudget)
    .sort((a, b) => a.index - b.index); // 다시 시간순으로

  const items = [...sortedStructure, ...trimmedEntries]
    .sort((a, b) => a.index - b.index)
    .map((item, i) => ({ ...item, number: i + 1 }));

  return {
    items,
    stance: currentStance(candles, levels),
    // 진입 신호(entryPoints)가 실제로 참조하는 것과 같은 상위 레벨만 낸다 —
    // 배지 근거가 되는 선만 그려야 화면이 레벨 전부로 어지러워지지 않는다.
    levels: levels.slice(0, ENTRY_LEVEL_LIMIT),
  };
}

// ── 매매 전략 요약 ───────────────────────────────────────────

/** 매수 관점일 때, 2차 지지선이 없으면 지지선보다 이 비율 아래를 손절 참고가로 본다 */
const STOP_MARGIN = 0.02;

/**
 * 지금이 매수하기 좋은 자리인지, 아니라면(=매도 관점) 어느 가격에서 재매수를
 * 고려할지를 지지/저항선 + 구조 패턴의 방향성(강세/약세 우세)으로 요약한다.
 *
 * 판단 순서: ① 현재가가 지지선에 붙어 있고 구조 패턴이 약세 우세가 아니면
 * 매수 관점 ② 현재가가 저항선에 붙어 있고 구조 패턴이 강세 우세가 아니면
 * 매도 관점 ③ 둘 다 아니면(레벨 사이 중간이거나, 붙어 있어도 구조 패턴이
 * 반대라 신뢰도가 낮으면) 관망 — 두 레벨을 참고 범위로만 제시한다.
 *
 * ⚠️ 지금 보이는 레벨·패턴을 기준으로 한 참고 가격일 뿐 예측이 아니다
 * (README 고지와 같은 태도). 호출부는 반드시 이 태도가 드러나게 문구를
 * 노출해야 한다.
 *
 * @param {Array} [options.items] analyzeChart() 의 items — 이미 계산해 둔
 *   게 있으면 넘겨서 중복 계산을 피한다. 없으면 이 함수가 직접 계산한다.
 */
export function tradingPlan(candles, { span = 5, quote = 'KRW', items = null } = {}) {
  if (!candles || candles.length < BASE_WINDOW + BASE_RECENT_OFFSET + 1) {
    return {
      verdict: 'unknown',
      price: candles?.at(-1)?.close ?? null,
      bias: 'neutral',
      buy: null,
      sell: null,
      stop: null,
      text: '아직 데이터가 부족해 참고 가격을 낼 수 없습니다.',
    };
  }

  const levels = supportResistanceLevels(candles, { span });
  const price = candles.at(-1).close;

  const supportsBelow = levels.filter((l) => l.kind === 'support' && l.price <= price).sort((a, b) => b.price - a.price);
  const resistancesAbove = levels.filter((l) => l.kind === 'resistance' && l.price >= price).sort((a, b) => a.price - b.price);
  const buyLevel = supportsBelow[0] ?? null;
  const sellLevel = resistancesAbove[0] ?? null;

  const distToBuy = buyLevel ? Math.abs(price - buyLevel.price) / buyLevel.price : Infinity;
  const distToSell = sellLevel ? Math.abs(sellLevel.price - price) / sellLevel.price : Infinity;

  const structureItems = (items ?? analyzeChart(candles, { span, quote }).items).filter(
    (item) => item.group === 'bullish' || item.group === 'bearish',
  );
  const bullishCount = structureItems.filter((item) => item.group === 'bullish').length;
  const bearishCount = structureItems.filter((item) => item.group === 'bearish').length;
  const bias = bullishCount > bearishCount ? 'bullish' : bearishCount > bullishCount ? 'bearish' : 'neutral';
  const rationale = structureItems.filter((item) => item.group === bias).sort((a, b) => b.index - a.index)[0] ?? null;

  const fmt = (value) => formatPrice(value, quote);
  let verdict;
  let text;

  if (buyLevel && distToBuy <= STANCE_PROXIMITY && bias !== 'bearish') {
    verdict = 'buy';
    text = sellLevel
      ? `지금(${fmt(price)})은 지지선 ${fmt(buyLevel.price)} 부근 — 매수 관점입니다. 다음 저항선 ${fmt(sellLevel.price)} 부근이 매도 우위 타이밍입니다.`
      : `지금(${fmt(price)})은 지지선 ${fmt(buyLevel.price)} 부근 — 매수 관점입니다. 위로는 아직 뚜렷한 저항선이 없습니다.`;
  } else if (sellLevel && distToSell <= STANCE_PROXIMITY && bias !== 'bullish') {
    verdict = 'sell';
    text = buyLevel
      ? `지금(${fmt(price)})은 저항선 ${fmt(sellLevel.price)} 부근 — 매도 관점입니다. 매도한다면 지지선 ${fmt(buyLevel.price)} 부근이 재매수를 고려할 자리입니다.`
      : `지금(${fmt(price)})은 저항선 ${fmt(sellLevel.price)} 부근 — 매도 관점입니다. 아래로는 아직 뚜렷한 지지선이 없습니다.`;
  } else {
    verdict = 'wait';
    text =
      buyLevel && sellLevel
        ? `지금(${fmt(price)})은 지지선 ${fmt(buyLevel.price)}과 저항선 ${fmt(sellLevel.price)} 사이 — 매수·매도 어느 쪽도 우위가 아닙니다. 지지선 근처면 매수, 저항선 근처면 매도 관점으로 보세요.`
        : '뚜렷한 지지·저항선이 아직 형성되지 않아 참고 가격을 제시하기 어렵습니다.';
  }
  if (rationale) text += ` (${rationale.label})`;

  const stop =
    verdict === 'buy' && buyLevel
      ? supportsBelow[1]
        ? { price: supportsBelow[1].price, touches: supportsBelow[1].touches }
        : { price: buyLevel.price * (1 - STOP_MARGIN), touches: null }
      : null;

  return {
    verdict,
    price,
    bias,
    buy: buyLevel ? { price: buyLevel.price, touches: buyLevel.touches } : null,
    sell: sellLevel ? { price: sellLevel.price, touches: sellLevel.touches } : null,
    stop,
    text,
  };
}
