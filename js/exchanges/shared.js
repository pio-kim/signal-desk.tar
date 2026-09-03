/**
 * 거래소 어댑터 공통 유틸. 네트워크 계층이지만 순수 함수만 둔다.
 */

import { POLL } from '../config.js';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ExchangeError extends Error {
  constructor(message, { exchange = null, status = null, retryable = false } = {}) {
    super(message);
    this.name = 'ExchangeError';
    this.exchange = exchange;
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * 재시도 정책: 429와 5xx, 그리고 네트워크 단절만 다시 시도한다.
 * 잘못된 심볼 같은 4xx 는 몇 번 더 던져도 같은 답이 오므로 즉시 포기한다.
 */
export async function getJson(url, { exchange } = {}) {
  let lastError = null;

  for (let attempt = 0; attempt <= POLL.retryMax; attempt += 1) {
    if (attempt > 0) await sleep(POLL.retryBaseMs * 2 ** (attempt - 1));

    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      if (response.ok) return await response.json();

      const retryable = response.status === 429 || response.status >= 500;
      const error = new ExchangeError(`${exchange} 응답 ${response.status}`, {
        exchange,
        status: response.status,
        retryable,
      });
      if (!retryable) throw error;
      lastError = error;
    } catch (error) {
      if (error instanceof ExchangeError && !error.retryable) throw error;
      lastError =
        error instanceof ExchangeError
          ? error
          : new ExchangeError(`${exchange} 에 연결할 수 없습니다`, { exchange, retryable: true });
    }
  }

  throw lastError;
}

/*
 * 업비트만 KST 문자열을 직접 준다. 나머지 거래소는 epoch 밀리초를 주므로
 * 같은 형태로 맞춰야 차트 축과 툴팁이 거래소와 무관하게 동작한다.
 * 'sv-SE' 로케일이 'YYYY-MM-DD HH:mm:ss' 를 내주므로 공백만 T 로 바꾼다.
 */
const kstFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function kstString(date) {
  return kstFormat.format(date).replace(' ', 'T');
}

/** 거래소들은 숫자를 문자열로 준다. 조용히 NaN 이 번지지 않게 한곳에서 변환한다. */
export function num(value) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function candleFrom({ timestampMs, open, high, low, close, volume }) {
  const time = new Date(timestampMs);
  return {
    time,
    kst: kstString(time),
    open: num(open),
    high: num(high),
    low: num(low),
    close: num(close),
    volume: num(volume),
  };
}

/** 변화량 부호를 화면이 쓰는 방향 문자열로 바꾼다. */
export function directionOf(changePrice) {
  if (changePrice === null) return 'EVEN';
  if (changePrice > 0) return 'RISE';
  if (changePrice < 0) return 'FALL';
  return 'EVEN';
}

/** 캔들이 오래된→최신 순인지 확인하고, 뒤집혀 있으면 바로잡는다. */
export function ascending(candles) {
  if (candles.length < 2) return candles;
  return candles[0].time > candles[1].time ? [...candles].reverse() : candles;
}

/**
 * 짧은 봉을 묶어 긴 봉을 만든다. 코인베이스가 4시간봉을 지원하지 않아
 * (`400 Unsupported granularity`) 1시간봉 4개로 합성하는 데 쓴다.
 *
 * 구간 경계는 epoch 기준으로 자르므로 거래소마다 다른 '하루의 시작' 논쟁이
 * 끼어들지 않는다. 앞쪽 구간이 덜 찬 경우는 버린다 — 시가가 실제 시가가
 * 아니어서 지표를 왜곡한다. 맨 뒤 구간은 진행 중이므로 그대로 남긴다.
 */
export function aggregateCandles(candles, minutes) {
  if (!candles?.length) return [];

  const bucketMs = minutes * 60_000;
  const groups = new Map();

  for (const candle of ascending(candles)) {
    const start = Math.floor(candle.time.getTime() / bucketMs) * bucketMs;
    const group = groups.get(start);

    if (!group) {
      groups.set(start, {
        start,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume ?? 0,
        count: 1,
      });
      continue;
    }

    group.high = Math.max(group.high, candle.high);
    group.low = Math.min(group.low, candle.low);
    group.close = candle.close;
    group.volume += candle.volume ?? 0;
    group.count += 1;
  }

  const ordered = [...groups.values()].sort((a, b) => a.start - b.start);
  const expected = Math.max(1, Math.round(bucketMs / ((candles[1]?.time - candles[0]?.time) || bucketMs)));
  while (ordered.length > 1 && ordered[0].count < expected) ordered.shift();

  return ordered.map((group) =>
    candleFrom({
      timestampMs: group.start,
      open: group.open,
      high: group.high,
      low: group.low,
      close: group.close,
      volume: group.volume,
    }),
  );
}

/**
 * 종목 × 봉 주기 캔들을 한 거래소 안에서 직렬로 가져온다.
 *
 * 어댑터 7개가 같은 루프를 각자 들고 있으면 한 곳을 고칠 때 나머지가 어긋난다.
 * 간격만 거래소별로 다르게 받는다 — 크라켄은 공개 API 한도가 초당 1회 수준이라
 * 업비트와 같은 150ms 로 흘리면 막힌다.
 */
export async function buildCandleSet(exchange, coins, timeframes, gapMs) {
  const data = {};
  const failures = [];
  let first = true;

  for (const coin of coins) {
    data[coin] = {};
    for (const timeframe of timeframes) {
      if (!first) await sleep(gapMs);
      first = false;

      try {
        data[coin][timeframe.key] = await exchange.fetchCandles(coin, timeframe.key);
      } catch (error) {
        data[coin][timeframe.key] = null;
        failures.push({
          exchange: exchange.id,
          coin,
          timeframe: timeframe.key,
          message: error.message,
        });
      }
    }
  }

  return { data, failures };
}
