/**
 * 차트 패턴 탐지 — 순수 함수만 둔다.
 *
 * signal.js 의 지표는 '지금 얼마나 강한가'를 재지만, 여기서는 '과거 캔들이
 * 어떤 모양으로 배치됐는가'를 본다. 성격이 달라 파일을 분리했다.
 *
 * 네 갈래로 나눈다.
 *   - 라인형: 지지/저항선 · 추세선 · 피보나치 되돌림 · VWAP — 좌표 계산만
 *     하므로 판정이 결정적이다.
 *   - 거래량 연계: 거래량 프로파일(POC) · OBV 다이버전스 — 역시 결정적.
 *   - 반전 패턴: 쌍바닥/쌍봉 · 헤드앤숄더 — 스윙 극점의 '배치'를 보는
 *     패턴 매칭이라 경계가 본질적으로 흐릿하다. '봉우리가 비슷한 높이'를
 *     얼마나 봐줄지(허용 오차)가 결과를 바꾼다.
 *   - 지속 패턴: 삼각수렴 — 고점·저점 추세선의 기울기 조합으로 판정한다.
 *
 * 흐릿한 두 갈래는 허용 오차를 상수로 빼 두었고, 반환값에 근거가 된
 * 스윙 포인트 좌표를 항상 함께 담는다 — 판정 라벨만 보고 매매하면 안
 * 되는 영역이라, 화면에서도 근거 좌표를 함께 그려야 한다.
 */

import { findSwings, obv as obvSeries } from './indicators.js';

const present = (value) => value !== null && value !== undefined && Number.isFinite(value);

// ── 스윙 포인트 ──────────────────────────────────────────────

/**
 * 고가·저가 배열에서 스윙 고점/저점을 뽑는다.
 * 종가가 아니라 고가·저가를 보는 이유는 패턴의 꼭짓점은 몸통이 아니라
 * 꼬리에서 만들어지기 때문이다(다이버전스는 반대로 종가를 본다 — 그건
 * 모멘텀 비교이지 가격 극점 비교가 아니다).
 */
export function swingPoints(candles, span = 5) {
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  return {
    highs: findSwings(highs, span).highs.map((index) => ({ index, price: highs[index] })),
    lows: findSwings(lows, span).lows.map((index) => ({ index, price: lows[index] })),
  };
}

// ── 라인형 ───────────────────────────────────────────────────

const LEVEL_TOLERANCE = 0.015; // 이 안이면 '같은 가격대'로 묶는다

/**
 * 지지/저항선 — 스윙 극점을 가격대로 묶어 여러 번 반응한 레벨을 찾는다.
 * 한 번만 닿은 점은 우연일 수 있어 minTouches 미만은 버린다.
 */
export function supportResistanceLevels(
  candles,
  { span = 5, tolerance = LEVEL_TOLERANCE, minTouches = 2 } = {},
) {
  const { highs, lows } = swingPoints(candles, span);

  const cluster = (points, kind) => {
    const sorted = [...points].sort((a, b) => a.price - b.price);
    const groups = [];
    for (const point of sorted) {
      const last = groups.at(-1);
      if (last && Math.abs(point.price - last.avg) / last.avg <= tolerance) {
        last.points.push(point);
        last.avg = last.points.reduce((sum, p) => sum + p.price, 0) / last.points.length;
      } else {
        groups.push({ points: [point], avg: point.price });
      }
    }
    return groups
      .filter((group) => group.points.length >= minTouches)
      .map((group) => ({
        kind,
        price: group.avg,
        touches: group.points.length,
        indices: group.points.map((p) => p.index),
      }));
  };

  return [...cluster(lows, 'support'), ...cluster(highs, 'resistance')].sort(
    (a, b) => b.touches - a.touches,
  );
}

/**
 * 추세선 — 최근 스윙 저점 2개를 이은 상승 추세선(support), 스윙 고점 2개를
 * 이은 하락 추세선(resistance)을 각각 낸다. 어느 쪽이 지금 유효한지는
 * 호출부가 종가 위치로 판단한다(이 함수는 좌표만 낸다).
 */
export function trendlines(candles, { span = 5 } = {}) {
  const { highs, lows } = swingPoints(candles, span);

  const lineFrom = (points) => {
    if (points.length < 2) return null;
    const [a, b] = points.slice(-2);
    if (b.index === a.index) return null;
    const slope = (b.price - a.price) / (b.index - a.index);
    const intercept = a.price - slope * a.index;
    return { from: a, to: b, slope, priceAt: (index) => intercept + slope * index };
  };

  return { support: lineFrom(lows), resistance: lineFrom(highs) };
}

const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

/**
 * 피보나치 되돌림 — 구간 안 최고가·최저가 사이를 표준 비율로 나눈다.
 * 저점이 고점보다 나중이면 하락 구간으로 보고 방향을 뒤집는다.
 */
export function fibonacciRetracement(candles) {
  if (!candles.length) return null;

  let highIndex = 0;
  let lowIndex = 0;
  candles.forEach((c, i) => {
    if (c.high > candles[highIndex].high) highIndex = i;
    if (c.low < candles[lowIndex].low) lowIndex = i;
  });

  const high = candles[highIndex].high;
  const low = candles[lowIndex].low;
  if (high <= low) return null;

  const direction = highIndex >= lowIndex ? 'up' : 'down';
  const levels = FIB_RATIOS.map((ratio) => ({
    ratio,
    price: direction === 'up' ? high - (high - low) * ratio : low + (high - low) * ratio,
  }));

  return { high, low, highIndex, lowIndex, direction, levels };
}

/**
 * VWAP — 배열 시작 시점부터 누적한 거래량가중평균가. 길이를 보존한다.
 * 주식처럼 '장 시작'이 없는 코인 시장에서는 '보이는 구간 시작'을 기준점
 * 으로 쓰는 것이 그나마 뜻이 통한다 — 그래서 값은 창(window)에 따라
 * 달라진다는 한계를 그대로 안는다.
 */
export function vwap(candles) {
  const out = new Array(candles.length).fill(null);
  let cumPV = 0;
  let cumVolume = 0;

  candles.forEach((c, i) => {
    const typical = (c.high + c.low + c.close) / 3;
    const volume = c.volume ?? 0;
    cumPV += typical * volume;
    cumVolume += volume;
    out[i] = cumVolume > 0 ? cumPV / cumVolume : null;
  });

  return out;
}

// ── 거래량 연계 ──────────────────────────────────────────────

/**
 * 거래량 프로파일 — 가격을 bins 구간으로 나눠 거래량을 몰아 본다.
 * 체결가 분포를 모르므로 한 봉의 거래량은 그 봉의 고저 구간에 걸리는
 * 버킷에 균등 배분한다(근사치라는 한계가 있다). POC(Point of Control)는
 * 거래가 가장 많이 몰린 가격대로, 지지/저항선과 비슷한 역할을 하지만
 * '몇 번 닿았나'가 아니라 '얼마나 거래됐나'로 잰다는 점이 다르다.
 */
export function volumeProfile(candles, bins = 24) {
  if (!candles.length) return null;

  const low = Math.min(...candles.map((c) => c.low));
  const high = Math.max(...candles.map((c) => c.high));
  if (high <= low) return null;

  const step = (high - low) / bins;
  const buckets = new Array(bins).fill(0);

  for (const candle of candles) {
    const startBin = Math.min(bins - 1, Math.max(0, Math.floor((candle.low - low) / step)));
    const endBin = Math.min(bins - 1, Math.max(0, Math.floor((candle.high - low) / step)));
    const bucketCount = endBin - startBin + 1;
    const share = (candle.volume ?? 0) / bucketCount;
    for (let b = startBin; b <= endBin; b += 1) buckets[b] += share;
  }

  const levels = buckets.map((volume, i) => ({
    priceLow: low + i * step,
    priceHigh: low + (i + 1) * step,
    volume,
  }));

  const poc = levels.reduce((best, level) => (level.volume > best.volume ? level : best), levels[0]);

  return { levels, poc, low, high };
}

/**
 * OBV 다이버전스 — 가격 스윙과 누적 거래량(OBV) 스윙이 어긋나는 구간.
 * indicators.js 의 rsiDivergence 와 같은 논리를 OBV 에 적용한 것이다.
 */
export function obvDivergence(candles, { span = 3, lookback = 60 } = {}) {
  const closes = candles.map((c) => c.close);
  const series = obvSeries(candles);
  const from = Math.max(0, closes.length - lookback);
  const window = closes.slice(from);
  const { highs, lows } = findSwings(window, span);

  const obvAt = (index) => series[from + index];
  const lastTwo = (indices) => indices.slice(-2);

  const [highA, highB] = lastTwo(highs);
  if (highA !== undefined && highB !== undefined) {
    const a = obvAt(highA);
    const b = obvAt(highB);
    if (present(a) && present(b) && window[highB] > window[highA] && b < a) {
      return { kind: 'bearish', indices: [from + highA, from + highB] };
    }
  }

  const [lowA, lowB] = lastTwo(lows);
  if (lowA !== undefined && lowB !== undefined) {
    const a = obvAt(lowA);
    const b = obvAt(lowB);
    if (present(a) && present(b) && window[lowB] < window[lowA] && b > a) {
      return { kind: 'bullish', indices: [from + lowA, from + lowB] };
    }
  }

  return null;
}

// ── 반전 패턴 ────────────────────────────────────────────────

const PEAK_TOLERANCE = 0.02; // 두 꼭짓점을 '비슷한 높이'로 볼 오차
const MIN_NECK_DEPTH = 0.03; // 목선까지 최소 되돌림 — 너무 얕으면 그냥 횡보

/**
 * 쌍바닥/쌍봉 — 비슷한 높이의 극점 두 개와 그 사이 반대 극점(목선)을 찾는다.
 *
 * 교과서 정의는 '목선을 돌파해야 패턴 완성'이지만, 여기서는 그 전 단계인
 * '극점 두 개가 형성됐다'까지 판정하고 돌파 여부는 completed 로 따로
 * 표시한다 — 돌파 전에 미리 보여주는 것이 참고용 차트선의 목적에 맞다.
 */
export function doubleExtremes(candles, { span = 5, tolerance = PEAK_TOLERANCE } = {}) {
  const { highs, lows } = swingPoints(candles, span);
  const results = [];

  const scan = (points, opposite, kind) => {
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      if (Math.abs(a.price - b.price) / a.price > tolerance) continue;

      const between = opposite.filter((p) => p.index > a.index && p.index < b.index);
      if (!between.length) continue;
      const neckline =
        kind === 'double-bottom'
          ? between.reduce((min, p) => (p.price < min.price ? p : min))
          : between.reduce((max, p) => (p.price > max.price ? p : max));

      const depth = Math.abs(neckline.price - a.price) / a.price;
      if (depth < MIN_NECK_DEPTH) continue;

      const lastClose = candles.at(-1).close;
      const completed =
        kind === 'double-bottom' ? lastClose > neckline.price : lastClose < neckline.price;

      results.push({ kind, points: [a, b], neckline, completed });
    }
  };

  scan(lows, highs, 'double-bottom');
  scan(highs, lows, 'double-top');

  return results;
}

const SHOULDER_TOLERANCE = 0.03; // 양쪽 어깨 높이 차이 허용치
const HEAD_MARGIN = 0.02; // 머리가 어깨보다 최소 이만큼은 튀어나와야 한다

/**
 * 헤드앤숄더/역헤드앤숄더 — 극점 3개(어깨-머리-어깨)를 찾는다. 가운데가
 * 양쪽보다 뚜렷이 튀어나오고, 양 어깨 높이는 비슷해야 패턴으로 본다.
 */
export function headAndShoulders(candles, { span = 5 } = {}) {
  const { highs, lows } = swingPoints(candles, span);
  const results = [];

  const scan = (points, kind) => {
    for (let i = 0; i < points.length - 2; i += 1) {
      const [left, head, right] = points.slice(i, i + 3);
      const shoulderAvg = (left.price + right.price) / 2;
      const shoulderDiff = Math.abs(left.price - right.price) / shoulderAvg;
      if (shoulderDiff > SHOULDER_TOLERANCE) continue;

      const headStandsOut =
        kind === 'head-shoulders'
          ? head.price > shoulderAvg * (1 + HEAD_MARGIN)
          : head.price < shoulderAvg * (1 - HEAD_MARGIN);
      if (!headStandsOut) continue;

      results.push({ kind, left, head, right, neckline: shoulderAvg });
    }
  };

  scan(highs, 'head-shoulders');
  scan(lows, 'inverse-head-shoulders');

  return results;
}

// ── 지속 패턴 ────────────────────────────────────────────────

const FLAT_SLOPE_RATIO = 0.15; // 봉당 기울기가 전체 변동폭의 이 비율 이하면 '수평'

/**
 * 삼각수렴 — 고점 추세선과 저점 추세선의 기울기 조합으로 세 종류를 가른다.
 * 고점이 수평이고 저점이 오르면 상승삼각형, 그 반대는 하락삼각형,
 * 둘 다 기울어 서로를 향해 좁아지면 대칭삼각형.
 */
export function triangle(candles, { span = 5 } = {}) {
  const lines = trendlines(candles, { span });
  if (!lines.support || !lines.resistance) return null;

  const range = Math.max(...candles.map((c) => c.high)) - Math.min(...candles.map((c) => c.low));
  if (range <= 0) return null;
  const flatBar = (range * FLAT_SLOPE_RATIO) / Math.max(1, candles.length);

  const resistanceFlat = Math.abs(lines.resistance.slope) <= flatBar;
  const supportFlat = Math.abs(lines.support.slope) <= flatBar;
  const converging = lines.support.slope > flatBar && lines.resistance.slope < -flatBar;

  let kind = null;
  if (resistanceFlat && lines.support.slope > flatBar) kind = 'ascending';
  else if (supportFlat && lines.resistance.slope < -flatBar) kind = 'descending';
  else if (converging) kind = 'symmetric';
  if (!kind) return null;

  return { kind, support: lines.support, resistance: lines.resistance };
}

// ── 한 번에 전부 ─────────────────────────────────────────────

/** 네 카테고리를 한 번에 계산한다. 차트 오버레이가 호출하는 진입점. */
export function detectPatterns(candles, options = {}) {
  return {
    lines: {
      levels: supportResistanceLevels(candles, options),
      trendlines: trendlines(candles, options),
      fibonacci: fibonacciRetracement(candles),
      vwap: vwap(candles),
    },
    volume: {
      profile: volumeProfile(candles, options.bins),
      obvDivergence: obvDivergence(candles, options),
    },
    reversal: {
      doubleExtremes: doubleExtremes(candles, options),
      headAndShoulders: headAndShoulders(candles, options),
    },
    continuation: {
      triangle: triangle(candles, options),
    },
  };
}
