/**
 * 코인베이스(Coinbase Exchange) 어댑터. USD 마켓.
 */

import { POLL, TIMEFRAMES } from '../config.js';
import {
  ExchangeError,
  aggregateCandles,
  ascending,
  buildCandleSet,
  candleFrom,
  directionOf,
  getJson,
  num,
} from './shared.js';

const REST = 'https://api.exchange.coinbase.com';
const SOCKET = 'wss://ws-feed.exchange.coinbase.com';

/**
 * 코인베이스는 4시간 granularity 를 지원하지 않는다(`400 Unsupported granularity`).
 * 지원 값은 60·300·900·3600·21600·86400 뿐이므로 1시간봉을 4개씩 묶어 만든다.
 */
const GRANULARITY = { day: 86400, h1: 3600 };
const DERIVED = { h4: { from: 'h1', minutes: 240 } };

export const id = 'coinbase';
export const name = '코인베이스';
export const quote = 'USD';
export const providesFx = false;
export const browserRest = true;
export const note = '4시간봉은 1시간봉을 합성해 만든다';

export const symbolOf = (coin) => `${coin}-USD`;
const coinOf = (productId) => String(productId).replace('-USD', '').toUpperCase();

/** /products/stats 는 모든 상품의 24시간 통계를 한 번에 준다. */
export function parseStats(productId, stats) {
  const day = stats?.stats_24hour ?? {};
  const price = num(day.last);
  const open = num(day.open);
  const changePrice = price !== null && open !== null ? price - open : null;

  return {
    exchange: id,
    coin: coinOf(productId),
    price,
    changeRate: changePrice !== null && open ? changePrice / open : null,
    changePrice,
    direction: directionOf(changePrice),
    dayHigh: num(day.high),
    dayLow: num(day.low),
    // volume 은 기준 자산 수량이다. 달러 거래대금으로 바꿔 다른 거래소와 맞춘다.
    quoteVolume24h: num(day.volume) !== null && price !== null ? num(day.volume) * price : null,
    at: new Date(),
  };
}

/** 소켓 ticker 페이로드. 필드 이름이 REST 통계와 다르다. */
export function parseSocketTicker(data) {
  const price = num(data.price);
  const open = num(data.open_24h);
  const changePrice = price !== null && open !== null ? price - open : null;

  return {
    exchange: id,
    coin: coinOf(data.product_id),
    price,
    changeRate: changePrice !== null && open ? changePrice / open : null,
    changePrice,
    direction: directionOf(changePrice),
    dayHigh: num(data.high_24h),
    dayLow: num(data.low_24h),
    quoteVolume24h:
      num(data.volume_24h) !== null && price !== null ? num(data.volume_24h) * price : null,
    at: new Date(),
  };
}

/**
 * 캔들 행은 `[시각, 저가, 고가, 시가, 종가, 거래량]` 이다.
 * 흔한 o,h,l,c 순서가 아니므로 그대로 읽으면 시가와 저가가 뒤바뀐다.
 * 시각은 초 단위이고 응답은 최신순이다.
 */
export function parseCandles(raw) {
  const candles = raw.map((row) =>
    candleFrom({
      timestampMs: Number(row[0]) * 1000,
      low: row[1],
      high: row[2],
      open: row[3],
      close: row[4],
      volume: row[5],
    }),
  );
  return ascending(candles);
}

export async function fetchTickers(coins) {
  const all = await getJson(`${REST}/products/stats`, { exchange: name });
  const wanted = new Set(coins.map(symbolOf));

  return Object.entries(all)
    .filter(([productId]) => wanted.has(productId))
    .map(([productId, stats]) => parseStats(productId, stats));
}

export async function fetchCandles(coin, timeframeKey) {
  const derived = DERIVED[timeframeKey];
  if (derived) {
    const base = await fetchCandles(coin, derived.from);
    return aggregateCandles(base, derived.minutes);
  }

  const granularity = GRANULARITY[timeframeKey];
  if (!granularity) {
    throw new ExchangeError(`알 수 없는 봉 주기: ${timeframeKey}`, { exchange: name });
  }

  const raw = await getJson(
    `${REST}/products/${symbolOf(coin)}/candles?granularity=${granularity}`,
    { exchange: name },
  );
  return parseCandles(raw);
}

export function openSocket(coins, { onTick, onOpen, onClose }) {
  const ws = new WebSocket(SOCKET);

  ws.addEventListener('open', () => {
    ws.send(
      JSON.stringify({
        type: 'subscribe',
        product_ids: coins.map(symbolOf),
        channels: ['ticker'],
      }),
    );
    onOpen?.();
  });

  ws.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === 'ticker' && message.product_id) onTick(parseSocketTicker(message));
  });

  ws.addEventListener('close', () => onClose?.());
  ws.addEventListener('error', () => ws.close());

  return { close: () => ws.close() };
}

/** 계약상 parseTicker 는 '실시간 피드 페이로드 파서'다. REST 쪽은 parseStats 를 쓴다. */
export const parseTicker = parseSocketTicker;

const adapter = {
  id,
  name,
  quote,
  providesFx,
  note,
  symbolOf,
  parseTicker,
  parseCandles,
  fetchTickers,
  fetchCandles,
  openSocket,
};

export const fetchCandleSet = (coins) =>
  buildCandleSet(adapter, coins, TIMEFRAMES, POLL.candleGapMs);
