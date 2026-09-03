/**
 * 종목별 탐욕지수 — **표시 전용**.
 *
 * alternative.me 의 공포탐욕지수는 BTC 기준 시장 전체 값 하나뿐이라, 리플 카드에도
 * 이더리움 카드에도 같은 숫자가 찍힌다. 그 산출 방식을 따라 종목별 지수를 만들면
 * '시장은 탐욕인데 이 종목만 공포' 같은 어긋남이 보인다.
 *
 * **점수에는 반영하지 않는다.** 이 지수의 재료(RSI·ATR·거래량·투표·트렌딩)가 이미
 * 시그널 점수에 들어간 지표들이므로 다시 넣으면 같은 정보를 두 번 세게 된다.
 * USDT 기준 괴리를 점수에서 뺀 것과 같은 이유다.
 *
 * 원 지수의 성분 중 설문(15%)과 도미넌스(10%)는 종목별로 만들 수 없어 제외하고
 * 남은 성분을 재정규화했다. 표시 문자열을 파싱하지 않고 캔들에서 다시 계산한다 —
 * 표시 형식이 바뀔 때 조용히 깨지는 결합을 만들지 않기 위해서다.
 */

import { PERIODS } from './config.js';
import { atrPercentile, rsi, volumeRatio } from './indicators.js';

const present = (value) => value !== null && value !== undefined && Number.isFinite(value);

const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, value));

/** RSI 는 이미 0~100 이고 과열·침체를 그대로 나타내므로 변환하지 않는다. */
export function momentumComponent(rsiValue) {
  return present(rsiValue) ? clamp(rsiValue) : null;
}

/**
 * 변동성은 **역방향**이다. 원 지수도 '이례적 변동성은 공포' 로 본다.
 * 그대로 넣으면 급락장이 탐욕으로 읽힌다.
 */
export function volatilityComponent(percentile) {
  return present(percentile) ? clamp(100 - percentile * 100) : null;
}

/**
 * 거래량비를 0~100 으로 눌러 담는다. 평균(1배)이 중립 50 이고, 절반 이하는 0,
 * 2배 이상은 100 이다. 거래가 몰리는 것을 탐욕으로 본다.
 */
export function volumeComponent(ratio) {
  if (!present(ratio)) return null;
  if (ratio <= 0.5) return 0;
  if (ratio >= 2) return 100;
  // 0.5~1 구간과 1~2 구간의 기울기가 달라 나눠 계산한다.
  return ratio <= 1 ? clamp(((ratio - 0.5) / 0.5) * 50) : clamp(50 + ((ratio - 1) / 1) * 50);
}

/** CoinGecko 상승 투표 비율. 원 지수의 소셜 성분 자리다. */
export function socialComponent(upPercentage) {
  return present(upPercentage) ? clamp(upPercentage) : null;
}

/** 검색 상위 진입 여부만 알 수 있어 두 단계뿐이다. */
export function attentionComponent(trending) {
  if (trending === null || trending === undefined) return null;
  return trending ? 75 : 45;
}

/** 없는 성분은 분모에서도 빠져 남은 성분끼리 재정규화된다. */
export function blendComponents(components) {
  let total = 0;
  let weightSum = 0;

  for (const component of components) {
    if (!present(component.value)) continue;
    total += component.value * component.weight;
    weightSum += component.weight;
  }

  return weightSum === 0 ? null : Math.round((total / weightSum) * 10) / 10;
}

/** 등급 구간은 원 지수와 같게 맞춘다. */
export function greedLabel(value) {
  if (!present(value)) return { key: 'unknown', label: '판정 불가' };
  if (value < 25) return { key: 'extreme-fear', label: '극단적 공포' };
  if (value < 50) return { key: 'fear', label: '공포' };
  if (value < 75) return { key: 'greed', label: '탐욕' };
  return { key: 'extreme-greed', label: '극단적 탐욕' };
}

const COMPONENT_META = [
  { key: 'momentum', label: '모멘텀', weight: 0.35 },
  { key: 'volatility', label: '변동성', weight: 0.25 },
  { key: 'volume', label: '거래량', weight: 0.2 },
  { key: 'social', label: '소셜', weight: 0.12 },
  { key: 'attention', label: '관심도', weight: 0.08 },
];

/**
 * @param {{candles?: object[], votes?: {up?: number}|null, trending?: boolean|null}} input
 *   candles 는 일봉을 넘긴다. 원 지수도 일 단위로 산출된다.
 * @returns {{value: number|null, label: string, key: string, components: Array}}
 */
export function greedIndex({ candles = null, votes = null, trending = null } = {}) {
  const values = {
    momentum: null,
    volatility: null,
    volume: null,
    social: socialComponent(votes?.up),
    attention: attentionComponent(trending),
  };

  if (candles?.length) {
    const closes = candles.map((candle) => candle.close);
    const last = candles.length - 1;

    values.momentum = momentumComponent(rsi(closes, PERIODS.rsi)[last]);
    values.volatility = volatilityComponent(
      atrPercentile(candles, PERIODS.atr, PERIODS.atrLookback)[last],
    );

    /*
     * 거래량만 직전 완결봉으로 본다. signal.js 와 같은 이유다 — 종가는 시점
     * 값이지만 거래량은 봉 구간에 걸쳐 누적되므로, 진행 중인 일봉의 누적량을
     * 완결봉 20개 평균과 비교하면 언제나 낮게 읽힌다. 실제로 이 파일에서 세
     * 종목 모두 거래량 성분이 0 으로 나오는 것을 관측하고 고쳤다.
     */
    const closed = last - 1;
    values.volume =
      closed >= 0
        ? volumeComponent(
            volumeRatio(
              candles.map((candle) => candle.volume),
              PERIODS.volume,
            )[closed],
          )
        : null;
  }

  const components = COMPONENT_META.map((meta) => ({ ...meta, value: values[meta.key] }));
  const value = blendComponents(components);
  const grade = greedLabel(value);

  return { value, label: grade.label, key: grade.key, components };
}
