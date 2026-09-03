/**
 * 크라켄 어댑터. USD 마켓.
 */

import { TIMEFRAMES } from '../config.js';
import {
  ExchangeError,
  ascending,
  buildCandleSet,
  candleFrom,
  directionOf,
  getJson,
  num,
} from './shared.js';

const REST = 'https://api.kraken.com/0/public';
const SOCKET = 'wss://ws.kraken.com/v2';

const INTERVALS = { day: 1440, h4: 240, h1: 60 };

/**
 * 크라켄에서 비트코인은 BTC 가 아니라 **XBT** 다. 게다가 요청한 `XBTUSD` 가
 * 응답에서는 `XXBTZUSD` 로 정규화돼 돌아오므로 응답 키를 가정할 수 없다.
 * 반면 WebSocket v2 는 `BTC/USD` 표기를 쓴다 — 같은 거래소인데 표기가 셋이다.
 */
const REST_ASSET = { BTC: 'XBT', XRP: 'XRP', ETH: 'ETH' };

/** 공개 API 는 카운터 방식이라 지속적으로 초당 1회를 넘기면 막힌다. */
const GAP_MS = 600;

export const id = 'kraken';
export const name = '크라켄';
export const quote = 'USD';
export const providesFx = false;
export const browserRest = true;
export const note = '비트코인 표기가 XBT 이고 공개 API 한도가 낮다';

export const symbolOf = (coin) => `${REST_ASSET[coin] ?? coin}USD`;
export const socketSymbolOf = (coin) => `${coin}/USD`;

/** 정규화된 응답 키에서 종목을 되찾는다. XXBTZUSD → BTC */
export function coinOfPairKey(key, coins) {
  const upper = String(key).toUpperCase();
  return (
    coins.find((coin) => upper.includes(REST_ASSET[coin] ?? coin)) ?? null
  );
}

/**
 * ticker 응답 필드는 한 글자다.
 * c=마지막 체결[가격, 수량] · o=당일 시가 · h/l=[당일, 24시간] · v=거래량[당일, 24시간]
 * · p=VWAP[당일, 24시간]
 */
export function parseRestTicker(raw, coin) {
  const price = num(raw.c?.[0]);
  const open = num(raw.o);
  const changePrice = price !== null && open !== null ? price - open : null;
  const volume24h = num(raw.v?.[1]);
  const vwap24h = num(raw.p?.[1]);

  return {
    exchange: id,
    coin,
    price,
    changeRate: changePrice !== null && open ? changePrice / open : null,
    changePrice,
    direction: directionOf(changePrice),
    dayHigh: num(raw.h?.[1]),
    dayLow: num(raw.l?.[1]),
    // 거래대금을 직접 주지 않으므로 24시간 거래량 × VWAP 로 환산한다.
    quoteVolume24h: volume24h !== null && vwap24h !== null ? volume24h * vwap24h : null,
    at: new Date(),
  };
}

/** OHLC 행은 [시각(초), 시가, 고가, 저가, 종가, VWAP, 거래량, 체결수] 이고 오래된 순이다. */
export function parseCandles(payload, coins = []) {
  const result = payload?.result ?? {};
  const key = Object.keys(result).find((name) => name !== 'last');
  const rows = key ? result[key] : [];

  const candles = rows.map((row) =>
    candleFrom({
      timestampMs: Number(row[0]) * 1000,
      open: row[1],
      high: row[2],
      low: row[3],
      close: row[4],
      volume: row[6],
    }),
  );
  return ascending(candles);
}

function ensureOk(payload, context) {
  if (payload?.error?.length) {
    throw new ExchangeError(`${name} ${context} 실패: ${payload.error.join(', ')}`, {
      exchange: name,
      // EAPI:Rate limit exceeded 는 잠시 뒤 풀리므로 재시도할 값이 있다.
      retryable: payload.error.some((message) => String(message).includes('Rate limit')),
    });
  }
  return payload;
}

/** 세 종목을 쉼표로 묶어 한 번에 가져온다. 한도가 낮으므로 호출을 아낀다. */
export async function fetchTickers(coins) {
  const pairs = coins.map(symbolOf).join(',');
  const payload = ensureOk(await getJson(`${REST}/Ticker?pair=${pairs}`, { exchange: name }), 'Ticker');

  const tickers = [];
  for (const [key, raw] of Object.entries(payload.result ?? {})) {
    const coin = coinOfPairKey(key, coins);
    if (coin) tickers.push(parseRestTicker(raw, coin));
  }
  return tickers;
}

export async function fetchCandles(coin, timeframeKey) {
  const interval = INTERVALS[timeframeKey];
  if (!interval) throw new ExchangeError(`알 수 없는 봉 주기: ${timeframeKey}`, { exchange: name });

  const payload = ensureOk(
    await getJson(`${REST}/OHLC?pair=${symbolOf(coin)}&interval=${interval}`, { exchange: name }),
    'OHLC',
  );
  return parseCandles(payload);
}

/** WebSocket v2 는 REST 와 달리 BTC/USD 표기를 쓴다. */
export function parseSocketTicker(data) {
  const coin = String(data.symbol).split('/')[0].toUpperCase();
  const price = num(data.last);
  const changePrice = num(data.change);

  return {
    exchange: id,
    coin,
    price,
    changeRate: num(data.change_pct) === null ? null : num(data.change_pct) / 100,
    changePrice,
    direction: directionOf(changePrice),
    dayHigh: num(data.high),
    dayLow: num(data.low),
    quoteVolume24h:
      num(data.volume) !== null && num(data.vwap) !== null ? num(data.volume) * num(data.vwap) : null,
    at: new Date(),
  };
}

export function openSocket(coins, { onTick, onOpen, onClose }) {
  const ws = new WebSocket(SOCKET);

  ws.addEventListener('open', () => {
    ws.send(
      JSON.stringify({
        method: 'subscribe',
        params: { channel: 'ticker', symbol: coins.map(socketSymbolOf) },
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
    if (message.channel !== 'ticker' || !Array.isArray(message.data)) return;
    for (const entry of message.data) {
      if (entry?.symbol) onTick(parseSocketTicker(entry));
    }
  });

  ws.addEventListener('close', () => onClose?.());
  ws.addEventListener('error', () => ws.close());

  return { close: () => ws.close() };
}

/** 계약상 parseTicker 는 '실시간 피드 페이로드 파서'다. REST 쪽은 parseRestTicker 를 쓴다. */
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

export const fetchCandleSet = (coins) => buildCandleSet(adapter, coins, TIMEFRAMES, GAP_MS);
