/**
 * 기술적 지표 계산 — 순수 함수만 둔다.
 *
 * 모든 함수는 입력과 같은 길이의 배열을 돌려주고, 계산에 필요한 봉이 모이지
 * 않은 구간은 null로 채운다. 길이를 보존하는 이유는 캔들 배열과 인덱스를
 * 그대로 맞춰 쓰기 때문이다. 브라우저 API에 의존하지 않으므로 Node에서
 * 그대로 테스트할 수 있다.
 */

/** 단순이동평균 */
export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0) return out;

  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** 지수이동평균. 첫 값은 SMA로 시드한다. */
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;

  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i];
  out[period - 1] = seed / period;

  for (let i = period; i < values.length; i += 1) {
    out[i] = (values[i] - out[i - 1]) * k + out[i - 1];
  }
  return out;
}

/** RSI. Wilder 평활을 쓴다(단순평균이 아니다). */
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = closes[i] - closes[i - 1];
    if (delta > 0) avgGain += delta;
    else avgLoss -= delta;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = toRsi(avgGain, avgLoss);

  for (let i = period + 1; i < closes.length; i += 1) {
    const delta = closes[i] - closes[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
}

function toRsi(avgGain, avgLoss) {
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/**
 * MACD. 시그널선은 MACD 값의 EMA이므로, null 구간을 걷어낸 뒤 계산하고
 * 원래 인덱스로 다시 정렬한다. null이 섞인 배열을 그대로 EMA에 넣으면
 * 앞쪽 null이 숫자 연산에 휩쓸려 0으로 취급된다.
 */
export function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);

  const macdLine = closes.map((_, i) =>
    emaFast[i] === null || emaSlow[i] === null ? null : emaFast[i] - emaSlow[i],
  );

  const firstIndex = macdLine.findIndex((v) => v !== null);
  const signalLine = new Array(closes.length).fill(null);

  if (firstIndex !== -1) {
    const dense = macdLine.slice(firstIndex);
    const denseSignal = ema(dense, signalPeriod);
    for (let i = 0; i < denseSignal.length; i += 1) {
      signalLine[firstIndex + i] = denseSignal[i];
    }
  }

  const histogram = macdLine.map((v, i) =>
    v === null || signalLine[i] === null ? null : v - signalLine[i],
  );

  return { macd: macdLine, signal: signalLine, histogram };
}

/**
 * 볼린저밴드. 표준편차는 모집단 기준(period로 나눔)이다.
 * %B = (종가 − 하단) / (상단 − 하단). 밴드 폭이 0이면 null을 준다.
 */
export function bollinger(closes, period = 20, multiplier = 2) {
  const middle = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  const percentB = new Array(closes.length).fill(null);

  for (let i = 0; i < closes.length; i += 1) {
    if (middle[i] === null) continue;

    let variance = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      const diff = closes[j] - middle[i];
      variance += diff * diff;
    }
    const sd = Math.sqrt(variance / period);

    upper[i] = middle[i] + sd * multiplier;
    lower[i] = middle[i] - sd * multiplier;

    const width = upper[i] - lower[i];
    if (width > 0) percentB[i] = (closes[i] - lower[i]) / width;
  }

  return { middle, upper, lower, percentB };
}

/**
 * 거래량비 — 현재 봉의 거래량을 '직전 period봉 평균'과 비교한다.
 * 현재 봉을 평균에 포함시키면 급증한 거래량이 스스로 기준선을 끌어올려
 * 비율이 둔해지므로 제외한다.
 */
export function volumeRatio(volumes, period = 20) {
  const out = new Array(volumes.length).fill(null);

  for (let i = period; i < volumes.length; i += 1) {
    let sum = 0;
    for (let j = i - period; j < i; j += 1) sum += volumes[j];
    const average = sum / period;
    if (average > 0) out[i] = volumes[i] / average;
  }
  return out;
}

/**
 * True Range — 갭을 포함한 실제 변동폭.
 * 고−저만 보면 갭 상승·하락을 놓치므로 전일 종가와의 거리도 함께 본다.
 */
export function trueRange(candles) {
  const out = new Array(candles.length).fill(null);

  for (let i = 1; i < candles.length; i += 1) {
    const previousClose = candles[i - 1].close;
    out[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - previousClose),
      Math.abs(candles[i].low - previousClose),
    );
  }
  return out;
}

/** Wilder 평활. RSI·ATR·ADX 가 모두 같은 방식을 쓴다. */
function wilder(values, period, from) {
  const out = new Array(values.length).fill(null);
  if (values.length < from + period) return out;

  let sum = 0;
  for (let i = from; i < from + period; i += 1) sum += values[i];
  out[from + period - 1] = sum / period;

  for (let i = from + period; i < values.length; i += 1) {
    out[i] = (out[i - 1] * (period - 1) + values[i]) / period;
  }
  return out;
}

/** ATR — True Range 의 Wilder 평활 */
export function atr(candles, period = 14) {
  return wilder(trueRange(candles), period, 1);
}

/**
 * ATR 백분위 — 현재 변동성이 최근 구간에서 몇 번째 수준인지.
 *
 * 절대값은 종목마다 자릿수가 달라 비교가 불가능하다. 가격으로 나눠 비율로
 * 만들고, 최근 lookback 구간 안에서의 순위로 바꾼다.
 */
export function atrPercentile(candles, period = 14, lookback = 100) {
  const atrSeries = atr(candles, period);
  const relative = atrSeries.map((value, i) =>
    value === null || !candles[i].close ? null : value / candles[i].close,
  );

  const out = new Array(candles.length).fill(null);

  for (let i = 0; i < candles.length; i += 1) {
    if (relative[i] === null) continue;
    const from = Math.max(0, i - lookback + 1);
    const window = relative.slice(from, i + 1).filter((value) => value !== null);
    if (window.length < 10) continue;
    const below = window.filter((value) => value < relative[i]).length;
    out[i] = below / (window.length - 1 || 1);
  }
  return out;
}

/**
 * ADX / DMI — 추세의 **강도**와 방향을 나눠서 잰다.
 *
 * ADX 는 방향을 말하지 않는다. 강한 상승과 강한 하락 모두 100 에 가까워지고,
 * 방향은 +DI / −DI 가 담당한다. 이걸 방향 지표로 쓰는 것이 대표적 오용이다.
 */
export function adx(candles, period = 14) {
  const length = candles.length;
  const empty = () => new Array(length).fill(null);
  const result = { adx: empty(), plusDI: empty(), minusDI: empty() };
  if (length < period * 2) return result;

  const tr = trueRange(candles);
  const plusDM = empty();
  const minusDM = empty();

  for (let i = 1; i < length; i += 1) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }

  const smoothTR = wilder(tr, period, 1);
  const smoothPlus = wilder(plusDM, period, 1);
  const smoothMinus = wilder(minusDM, period, 1);

  const dx = empty();
  for (let i = 0; i < length; i += 1) {
    if (smoothTR[i] === null) continue;
    // 가격이 전혀 움직이지 않으면 TR 합이 0 이다. 0 으로 나누지 않는다.
    if (smoothTR[i] === 0) continue;

    const plus = (100 * smoothPlus[i]) / smoothTR[i];
    const minus = (100 * smoothMinus[i]) / smoothTR[i];
    result.plusDI[i] = plus;
    result.minusDI[i] = minus;

    const sum = plus + minus;
    if (sum > 0) dx[i] = (100 * Math.abs(plus - minus)) / sum;
  }

  const firstDx = dx.findIndex((value) => value !== null);
  if (firstDx !== -1) {
    const dense = dx.slice(firstDx).map((value) => value ?? 0);
    const smoothed = wilder(dense, period, 0);
    for (let i = 0; i < smoothed.length; i += 1) {
      if (smoothed[i] !== null) result.adx[firstDx + i] = smoothed[i];
    }
  }

  return result;
}

/**
 * 스토캐스틱 — 최근 구간의 고저 범위 안에서 종가가 어디에 있는지.
 * RSI 가 변화량의 평균을 보는 것과 달리 이쪽은 위치를 보므로 관점이 다르다.
 */
export function stochastic(candles, period = 14, signalPeriod = 3) {
  const k = new Array(candles.length).fill(null);

  for (let i = period - 1; i < candles.length; i += 1) {
    let highest = -Infinity;
    let lowest = Infinity;
    for (let j = i - period + 1; j <= i; j += 1) {
      highest = Math.max(highest, candles[j].high);
      lowest = Math.min(lowest, candles[j].low);
    }
    const range = highest - lowest;
    // 구간 고저가 같으면 위치를 정의할 수 없다.
    if (range > 0) k[i] = (100 * (candles[i].close - lowest)) / range;
  }

  const dense = k.filter((value) => value !== null);
  const d = new Array(candles.length).fill(null);
  const firstK = k.findIndex((value) => value !== null);

  if (firstK !== -1 && dense.length >= signalPeriod) {
    const smoothed = sma(k.slice(firstK).map((value) => value ?? 0), signalPeriod);
    for (let i = 0; i < smoothed.length; i += 1) {
      if (k[firstK + i] !== null) d[firstK + i] = smoothed[i];
    }
  }

  return { k, d };
}

/** OBV — 종가가 오른 봉의 거래량은 더하고 내린 봉은 뺀 누적값 */
export function obv(candles) {
  const out = new Array(candles.length).fill(0);

  for (let i = 1; i < candles.length; i += 1) {
    const delta = candles[i].close - candles[i - 1].close;
    const volume = candles[i].volume ?? 0;
    out[i] = out[i - 1] + (delta > 0 ? volume : delta < 0 ? -volume : 0);
  }
  return out;
}

/** OBV 의 최근 구간 방향. 값의 크기는 종목마다 달라 부호만 쓴다. */
export function obvSlope(series, period = 20) {
  if (!series || series.length < period + 1) return null;
  const delta = series.at(-1) - series[series.length - 1 - period];
  return delta > 0 ? 1 : delta < 0 ? -1 : 0;
}

/**
 * 스윙 고점·저점 — 좌우 span 봉보다 크면(작으면) 극점으로 본다.
 * 다이버전스 판정의 기준점이 된다.
 */
export function findSwings(values, span = 3) {
  const highs = [];
  const lows = [];

  for (let i = span; i < values.length - span; i += 1) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - span; j <= i + span; j += 1) {
      if (j === i) continue;
      if (values[j] >= values[i]) isHigh = false;
      if (values[j] <= values[i]) isLow = false;
    }
    if (isHigh) highs.push(i);
    if (isLow) lows.push(i);
  }

  return { highs, lows };
}

/**
 * RSI 다이버전스 — 가격과 모멘텀이 어긋나는 구간.
 *
 * 가격이 신고점을 만들었는데 RSI 는 이전 고점보다 낮으면 상승 동력이 식은
 * 것이고(하락 다이버전스), 반대는 하락 동력이 식은 것이다. 추세 지표만으로는
 * 잡히지 않는 반전 신호라 모멘텀 카테고리에 넣는다.
 *
 * @returns {'bullish'|'bearish'|null}
 */
export function rsiDivergence(closes, rsiSeries, { span = 3, lookback = 60 } = {}) {
  const from = Math.max(0, closes.length - lookback);
  const window = closes.slice(from);
  const { highs, lows } = findSwings(window, span);

  const rsiAt = (index) => rsiSeries[from + index];

  const lastTwo = (indices) => indices.slice(-2);

  const [highA, highB] = lastTwo(highs);
  if (highA !== undefined && highB !== undefined) {
    const rsiA = rsiAt(highA);
    const rsiB = rsiAt(highB);
    if (rsiA !== null && rsiB !== null && window[highB] > window[highA] && rsiB < rsiA) {
      return 'bearish';
    }
  }

  const [lowA, lowB] = lastTwo(lows);
  if (lowA !== undefined && lowB !== undefined) {
    const rsiA = rsiAt(lowA);
    const rsiB = rsiAt(lowB);
    if (rsiA !== null && rsiB !== null && window[lowB] < window[lowA] && rsiB > rsiA) {
      return 'bullish';
    }
  }

  return null;
}
