/**
 * 지표값을 매수/매도 판정으로 옮기는 계층. 순수 함수만 둔다.
 *
 * 판정 함수를 스칼라 입출력으로 쪼갠 이유는 경계값을 직접 검증할 수 있어야
 * 하기 때문이다. 캔들 배열만 받는 구조라면 'RSI 가 정확히 30인 캔들'을
 * 역산해야 하므로 경계 테스트가 불가능해진다.
 *
 * 판정 → 카테고리 → 봉 주기의 3단 구조를 쓴다. 카테고리 안에서는 단순 평균,
 * 카테고리 사이에만 가중을 두므로 상관 높은 지표가 중복 투표하지 않는다.
 */

import {
  adx as adxSeries,
  atrPercentile,
  bollinger,
  macd,
  obv,
  obvSlope,
  rsi,
  rsiDivergence,
  sma,
  stochastic,
  volumeRatio,
} from './indicators.js';
import { falseBreakouts, whipsaw } from './patterns.js';
import {
  ADX_REGIMES,
  GRADES,
  GRADE_THRESHOLDS,
  PERIODS,
  TIMEFRAMES,
  UNKNOWN_GRADE,
  candleCategories,
} from './config.js';

/** 점수는 소수 첫째 자리까지만 다룬다. 표시와 비교가 함께 안정된다. */
const round1 = (value) => Math.round(value * 10) / 10;

const present = (value) => value !== null && value !== undefined && Number.isFinite(value);

const signed = (value, digits = 2) =>
  `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(digits)}`;

// ── 지표별 판정 ──────────────────────────────────────────────

export function scoreRsi(value) {
  if (!present(value)) return null;

  let score;
  let verdict;
  if (value < 30) [score, verdict] = [80, '과매도'];
  else if (value < 45) [score, verdict] = [40, '약세권'];
  else if (value <= 55) [score, verdict] = [0, '중립'];
  else if (value <= 70) [score, verdict] = [-40, '강세권'];
  else [score, verdict] = [-80, '과매수'];

  return { score, verdict, display: value.toFixed(1) };
}

/**
 * MACD 히스토그램의 부호와 최근 전환을 본다.
 * 크로스는 최근 3봉 안에서만 유효하다 — 그보다 오래된 전환은 이미 추세이지
 * 신호가 아니다.
 */
export function scoreMacd(histogram, close = null) {
  const last = histogram.length - 1;
  if (last < 0 || !present(histogram[last])) return null;

  const value = histogram[last];
  const display = close ? `${signed((value / close) * 100)}%` : signed(value);

  for (let i = Math.max(1, last - 2); i <= last; i += 1) {
    const current = histogram[i];
    const previous = histogram[i - 1];
    if (current === null || previous === null) continue;
    if (current > 0 && previous <= 0) return { score: 90, verdict: '골든크로스', display };
    if (current < 0 && previous >= 0) return { score: -90, verdict: '데드크로스', display };
  }

  if (value > 0) return { score: 40, verdict: '상승 모멘텀', display };
  if (value < 0) return { score: -40, verdict: '하락 모멘텀', display };
  return { score: 0, verdict: '중립', display };
}

export function scoreTrend(close, maShort, maLong) {
  if (!present(maShort) || !present(maLong)) return null;

  const aligned = maShort > maLong;
  const above = close > maShort;

  let score;
  let verdict;
  if (aligned && above) [score, verdict] = [70, '정배열 지지'];
  else if (aligned) [score, verdict] = [25, '정배열 조정'];
  else if (above) [score, verdict] = [-25, '역배열 반등'];
  else [score, verdict] = [-70, '역배열 약세'];

  return {
    score,
    verdict,
    display: `MA20 대비 ${signed(((close - maShort) / maShort) * 100, 1)}%`,
  };
}

/**
 * ADX/DMI — 강도와 방향을 함께 본다.
 *
 * ADX 자체는 방향을 말하지 않으므로 방향은 +DI/−DI 차이에서 가져오고, ADX 는
 * 그 방향을 얼마나 세게 밀어줄지 결정한다. ADX 가 낮으면 방향이 뚜렷해도
 * 점수를 줄여야 한다 — 횡보장의 DI 우위는 곧 뒤집힌다.
 */
export function scoreAdx(adx, plusDI, minusDI) {
  if (!present(adx) || !present(plusDI) || !present(minusDI)) return null;

  const bias = plusDI - minusDI;
  const strength = adx >= 25 ? 1 : adx >= 20 ? 0.5 : 0.2;
  // DI 격차 20 이상을 '뚜렷한 방향'으로 보고 포화시킨다.
  const direction = Math.max(-1, Math.min(1, bias / 20));
  const score = Math.round(direction * strength * 80);

  const regime = adx >= 25 ? '추세장' : adx < 20 ? '횡보장' : '전환 구간';
  const way = bias > 0 ? '상승' : bias < 0 ? '하락' : '방향 없음';

  return {
    score,
    verdict: `${regime} · ${way}`,
    display: `ADX ${adx.toFixed(0)} · DI ${signed(bias, 0)}`,
  };
}

export function scoreBollinger(percentB) {
  if (!present(percentB)) return null;

  let score;
  let verdict;
  if (percentB < 0) [score, verdict] = [80, '하단 이탈'];
  else if (percentB < 0.2) [score, verdict] = [45, '하단 근접'];
  else if (percentB <= 0.8) [score, verdict] = [0, '밴드 중앙'];
  else if (percentB <= 1) [score, verdict] = [-45, '상단 근접'];
  else [score, verdict] = [-80, '상단 이탈'];

  return { score, verdict, display: `%B ${percentB.toFixed(2)}` };
}

/** 스토캐스틱 — %K 위치와 %D 교차 방향을 함께 본다. */
export function scoreStochastic(k, d) {
  if (!present(k)) return null;

  const display = present(d) ? `%K ${k.toFixed(0)} · %D ${d.toFixed(0)}` : `%K ${k.toFixed(0)}`;
  const rising = present(d) ? k > d : null;

  let score;
  let verdict;
  if (k < 20) [score, verdict] = [rising === false ? 50 : 80, '과매도'];
  else if (k < 40) [score, verdict] = [35, '약세권'];
  else if (k <= 60) [score, verdict] = [0, '중립'];
  else if (k <= 80) [score, verdict] = [-35, '강세권'];
  else [score, verdict] = [rising === true ? -50 : -80, '과매수'];

  return { score, verdict, display };
}

/** 다이버전스는 있을 때만 강한 신호다. 없으면 중립이 아니라 '없음'으로 둔다. */
export function scoreDivergence(kind) {
  if (kind === 'bullish') return { score: 70, verdict: '상승 다이버전스', display: '가격↓ RSI↑' };
  if (kind === 'bearish') return { score: -70, verdict: '하락 다이버전스', display: '가격↑ RSI↓' };
  return { score: 0, verdict: '없음', display: '—' };
}

/**
 * ATR 백분위 — **방향 신호가 없다.**
 *
 * 변동성은 크기만 말하므로 거래량과 같은 방식으로 가격 방향과 짝지어야 뜻이
 * 생긴다. 압축 구간은 큰 움직임이 임박했다는 뜻이지만 방향을 모르므로 0 이다.
 * 없는 방향을 만들어내지 않는 것이 중요하다.
 */
export function scoreAtr(percentile, candle) {
  if (!present(percentile) || !candle) return null;

  const display = `백분위 ${Math.round(percentile * 100)}%`;
  if (percentile <= 0.3) return { score: 0, verdict: '변동성 압축', display };
  if (percentile < 0.7) return { score: 0, verdict: '보통', display };

  return candle.close > candle.open
    ? { score: 40, verdict: '확장 · 상승', display }
    : { score: -40, verdict: '확장 · 하락', display };
}

/** 거래량은 방향을 스스로 말하지 않는다. 그 봉이 올랐는지와 함께 읽어야 한다. */
export function scoreVolume(ratio, candle) {
  if (!present(ratio) || !candle) return null;

  const display = `평균의 ${ratio.toFixed(2)}배`;
  if (ratio < 1.2) return { score: 0, verdict: '평범', display };

  return candle.close > candle.open
    ? { score: 50, verdict: '상승 거래량 동반', display }
    : { score: -50, verdict: '하락 거래량 동반', display };
}

/** OBV 방향 — 가격과 어긋나면 경고 신호다. */
export function scoreObv(slope, priceRising) {
  if (slope === null || slope === undefined) return null;

  const display = slope > 0 ? '누적 상승' : slope < 0 ? '누적 하락' : '변화 없음';
  if (slope === 0) return { score: 0, verdict: '중립', display };

  if (priceRising !== null && priceRising !== undefined && priceRising !== slope > 0) {
    // 가격과 거래량 누적이 어긋나면 추세가 얇다.
    return { score: slope > 0 ? 30 : -30, verdict: '가격과 불일치', display };
  }
  return slope > 0 ? { score: 60, verdict: '매수 우위', display } : { score: -60, verdict: '매도 우위', display };
}

/**
 * 찾아봤지만 없을 때. 점수가 없다는 점은 '데이터 부족'과 같지만 뜻이 정반대다 —
 * 이쪽은 판정이 끝난 상태다. 화면에 이유를 적기 위해 문구를 함께 돌려준다.
 */
const absent = (verdict, display) => ({ score: null, verdict, display });

/**
 * 거짓 돌파 — 불트랩 / 베어트랩.
 *
 * 되돌아온 것만 점수를 준다. 아직 레벨 밖에 있는 돌파(pending)는 진짜 돌파일
 * 수도 있어 방향을 정하지 않는다 — 화면에는 '감시 중'으로 적고 점수는 비운다.
 *
 * 부호는 **누가 물렸는지**를 따른다. 저항 위에서 산 사람이 물린 불트랩은
 * 매도 신호이고, 지지 아래에서 판 사람이 물린 베어트랩은 매수 신호다.
 *
 * @param {object|null} trap 가장 최근 트랩. 트랩의 뜻이 '마지막 시도가
 *   실패했다' 이므로 여러 건이 겹칠 때는 최신 것이 지금 유효한 사실이다.
 * @param {number} more 같은 구간에 남은 트랩 수. 실제로 불트랩과 베어트랩이
 *   동시에 잡히는 구간이 있어(실측: ETH 일봉) 하나만 보고 판단하지 않도록
 *   화면에 건수를 함께 적는다. 점수는 최신 것만 쓴다.
 */
export function scoreFalseBreak(trap, more = 0) {
  if (!trap) return absent('없음', '감지 없음');

  const side = trap.kind === 'bull-trap' ? '저항' : '지지';
  if (trap.status === 'pending') {
    return absent('돌파 감시 중', `${side} 이탈 ${trap.bars}봉째 · 미확정`);
  }

  /*
   * 거래량이 실리지 않은 돌파가 되돌아온 것은 애초에 사려는 힘이 없었다는
   * 뜻이라 더 강한 신호로 본다. 거래량이 터졌는데도 되돌아온 것은 힘이
   * 부딪친 흔적이라 그만큼은 아니다.
   */
  const score = (trap.weak ? 80 : 60) * (trap.kind === 'bull-trap' ? -1 : 1);
  const volume = trap.volumeRatio === null ? '거래량 미상' : `거래량 ${trap.volumeRatio.toFixed(2)}배`;

  return {
    score,
    verdict: trap.kind === 'bull-trap' ? '불트랩 확정' : '베어트랩 확정',
    display: `${trap.bars}봉 만에 복귀 · ${volume}${more > 0 ? ` · 최근 ${more}건 더` : ''}`,
  };
}

/**
 * 휩쏘 — 방향이 아니라 **신뢰도**를 말하는 값이다.
 *
 * 톱질 구간에서는 어느 쪽 신호도 곧 뒤집힌다. 그래서 매수도 매도도 아닌 0점을
 * 주어 다른 카테고리가 만든 점수를 중립 쪽으로 끌어당기게 한다. 방향이 없는
 * 값에 억지로 부호를 주지 않는 것은 ATR·거래량과 같은 원칙이다.
 */
export function scoreWhipsaw(saw) {
  if (!saw) return absent('없음', '감지 없음');
  return {
    score: 0,
    verdict: '휩쏘 구간 · 신호 신뢰도 낮음',
    display: `${saw.window}봉 중 MA${saw.period} 교차 ${saw.crosses}회`,
  };
}

// ── 카테고리와 봉 주기 ──────────────────────────────────────

/** 계산 가능한 지표만으로 낸 단순 평균. 카테고리 내부에는 가중을 두지 않는다. */
export function categoryScore(indicators) {
  const usable = indicators.filter((entry) => entry.available && present(entry.score));
  if (!usable.length) return null;
  return round1(usable.reduce((sum, entry) => sum + entry.score, 0) / usable.length);
}

/** ADX 값으로 국면을 판정하고 카테고리 가중 조정치를 돌려준다. */
export function regimeOf(adx) {
  if (!present(adx)) return { key: 'unknown', label: '판정 불가', adjust: ADX_REGIMES.neutral.adjust };
  if (adx >= ADX_REGIMES.trending.min) {
    return { key: 'trending', label: ADX_REGIMES.trending.label, adjust: ADX_REGIMES.trending.adjust };
  }
  if (adx < ADX_REGIMES.ranging.max) {
    return { key: 'ranging', label: ADX_REGIMES.ranging.label, adjust: ADX_REGIMES.ranging.adjust };
  }
  return { key: 'neutral', label: ADX_REGIMES.neutral.label, adjust: ADX_REGIMES.neutral.adjust };
}

/** 카테고리 점수를 가중 평균한다. 값 없는 카테고리는 분모에서도 빠진다. */
export function blendCategories(categories) {
  let total = 0;
  let weightSum = 0;

  for (const category of categories) {
    if (!present(category.score)) continue;
    const weight = category.weight * (category.adjust ?? 1);
    total += category.score * weight;
    weightSum += weight;
  }

  return weightSum === 0 ? null : round1(total / weightSum);
}

export function gradeOf(score) {
  if (!present(score)) return UNKNOWN_GRADE;

  const t = GRADE_THRESHOLDS;
  if (score >= t.strongBuy) return GRADES.strongBuy;
  if (score >= t.buy) return GRADES.buy;
  if (score <= t.strongSell) return GRADES.strongSell;
  if (score <= t.sell) return GRADES.sell;
  return GRADES.neutral;
}

const INDICATOR_LABELS = {
  ma: `MA ${PERIODS.maShort}/${PERIODS.maLong}`,
  macd: `MACD(${PERIODS.macdFast},${PERIODS.macdSlow},${PERIODS.macdSignal})`,
  adx: `ADX/DMI(${PERIODS.adx})`,
  rsi: `RSI(${PERIODS.rsi})`,
  stochastic: `스토캐스틱(${PERIODS.stochastic},${PERIODS.stochasticSignal})`,
  divergence: 'RSI 다이버전스',
  bollinger: `볼린저 ${PERIODS.bollinger},${PERIODS.bollingerSigma}σ`,
  atr: `ATR(${PERIODS.atr}) 백분위`,
  volume: `거래량 직전봉/${PERIODS.volume}봉 평균`,
  obv: `OBV ${PERIODS.obv}봉 방향`,
  falseBreak: '거짓 돌파 (불·베어 트랩)',
  whipsaw: `휩쏘 · MA${PERIODS.maShort} 교차`,
  orderbook: '호가 불균형',
  taker: '체결강도',
};

function entryOf(key, evaluated) {
  const label = INDICATOR_LABELS[key] ?? key;
  if (!evaluated) {
    return { key, label, score: null, verdict: '—', display: '데이터 부족', available: false };
  }
  /*
   * 점수가 없는 판정도 있다 — '찾아봤지만 없다'(absent)와 '아직 방향을 정하지
   * 않았다'(돌파 감시 중). 위의 '찾아볼 수 없다'와 달리 이유가 있으므로 문구는
   * 그대로 쓰되, 점수가 없으니 평균에는 넣지 않는다.
   */
  return { key, label, ...evaluated, available: present(evaluated.score) };
}

/**
 * 한 봉 주기의 캔들을 받아 지표별 판정 · 카테고리 점수 · 봉 주기 점수를 낸다.
 * 캔들이 부족하면 예외 대신 '데이터 부족' 항목을 돌려준다 — 신규 상장 종목이나
 * 장 초반에는 정상적으로 일어나는 상황이다.
 */
export function evaluateTimeframe(candles) {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const last = candles.length - 1;

  const evaluated = {};
  let adxValue = null;

  if (last >= 0) {
    const close = closes[last];
    const rsiSeries = rsi(closes, PERIODS.rsi);
    const macdSeries = macd(closes, PERIODS.macdFast, PERIODS.macdSlow, PERIODS.macdSignal);
    const bands = bollinger(closes, PERIODS.bollinger, PERIODS.bollingerSigma);
    const maShort = sma(closes, PERIODS.maShort);
    const maLong = sma(closes, PERIODS.maLong);
    const volumes20 = volumeRatio(volumes, PERIODS.volume);
    const dmi = adxSeries(candles, PERIODS.adx);
    const stoch = stochastic(candles, PERIODS.stochastic, PERIODS.stochasticSignal);
    const atrPct = atrPercentile(candles, PERIODS.atr, PERIODS.atrLookback);
    const obvSeries = obv(candles);

    adxValue = dmi.adx[last];

    evaluated.ma = scoreTrend(close, maShort[last], maLong[last]);
    evaluated.macd = scoreMacd(macdSeries.histogram, close);
    evaluated.adx = scoreAdx(dmi.adx[last], dmi.plusDI[last], dmi.minusDI[last]);
    evaluated.rsi = scoreRsi(rsiSeries[last]);
    evaluated.stochastic = scoreStochastic(stoch.k[last], stoch.d[last]);

    /*
     * '없음'(찾아봤지만 없다)과 '데이터 부족'(찾아볼 수 없다)은 다른 상태다.
     * 봉이 부족한데 '없음 = 0점'을 주면 근거 없는 중립 표가 생기고, 그 하나
     * 때문에 전체 점수가 판정 불가 대신 0 으로 나온다. 그래서 스윙을 찾을 만큼
     * 봉이 모였을 때만 판정한다.
     */
    const minForDivergence = PERIODS.rsi + PERIODS.divergenceSpan * 2 + 2;
    evaluated.divergence =
      closes.length >= minForDivergence
        ? scoreDivergence(
            rsiDivergence(closes, rsiSeries, {
              span: PERIODS.divergenceSpan,
              lookback: PERIODS.divergenceLookback,
            }),
          )
        : null;
    evaluated.bollinger = scoreBollinger(bands.percentB[last]);
    evaluated.atr = scoreAtr(atrPct[last], candles[last]);

    /*
     * 거래량 계열만 직전 완결봉으로 판정한다. 종가는 시점 값이라 진행 중인 봉의
     * 값을 그대로 써도 완전하지만, 거래량은 봉 구간에 걸쳐 누적되는 값이다.
     * 봉이 시작된 직후의 누적 거래량을 완결봉 20개의 평균과 비교하면 언제나
     * 낮게 읽혀 지표가 구조적으로 망가진다.
     */
    const closed = last - 1;
    evaluated.volume =
      closed >= 0 ? scoreVolume(volumes20[closed], candles[closed]) : null;
    evaluated.obv =
      closed >= 0
        ? scoreObv(
            obvSlope(obvSeries.slice(0, closed + 1), PERIODS.obv),
            closed >= 1 ? closes[closed] > closes[closed - 1] : null,
          )
        : null;

    /*
     * 거짓 무빙은 지지/저항선 위에 얹혀 계산되므로 레벨을 만들 만큼 봉이
     * 있어야 한다. 부족하면 '없음'이 아니라 '데이터 부족'이 맞다 —
     * 찾아본 것이 아니라 찾아볼 수 없었던 것이다.
     */
    const enoughForTraps = candles.length >= PERIODS.maShort * 2;
    const traps = enoughForTraps ? falseBreakouts(candles) : [];
    evaluated.falseBreak = enoughForTraps
      ? scoreFalseBreak(traps[0] ?? null, Math.max(0, traps.length - 1))
      : null;
    evaluated.whipsaw = enoughForTraps ? scoreWhipsaw(whipsaw(candles)) : null;
  }

  const regime = regimeOf(adxValue);

  const categories = candleCategories().map((category) => {
    const indicators = category.indicators.map((key) => entryOf(key, evaluated[key]));
    return {
      key: category.key,
      label: category.label,
      weight: category.weight,
      adjust: regime.adjust[category.key] ?? 1,
      score: categoryScore(indicators),
      indicators,
    };
  });

  const score = blendCategories(categories);

  return { score, grade: gradeOf(score), categories, regime, adx: adxValue, candles };
}

/**
 * 봉 주기 점수를 종합한다. 값이 있는 주기만으로 가중치를 다시 정규화하므로,
 * 1시간봉만 계산되면 그 점수가 그대로 거래소 점수가 된다.
 */
export function combineTimeframes(scoreByKey) {
  const entries = [];
  for (const timeframe of TIMEFRAMES) {
    const score = scoreByKey[timeframe.key];
    if (!present(score)) continue;
    entries.push({ score, weight: timeframe.weight, adjust: 1 });
  }
  return blendCategories(entries);
}
