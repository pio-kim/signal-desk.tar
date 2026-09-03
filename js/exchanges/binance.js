/**
 * 바이낸스 어댑터. USDT 마켓.
 */

import { CANDLE_COUNT, POLL, TIMEFRAMES } from '../config.js';
import {
  ExchangeError,
  ascending,
  buildCandleSet,
  candleFrom,
  directionOf,
  getJson,
  num,
  sleep,
} from './shared.js';

const REST = 'https://api.binance.com/api/v3';
const SOCKET = 'wss://stream.binance.com:9443/stream';

const INTERVALS = { day: '1d', h4: '4h', h1: '1h' };

export const id = 'binance';
export const name = '바이낸스';
export const quote = 'USDT';
export const providesFx = false;
export const browserRest = true;
export const note = 'combined stream 하나로 세 종목을 받는다';

export const symbolOf = (coin) => `${coin}USDT`;
const coinOf = (symbol) => symbol.replace(/USDT$/i, '').toUpperCase();

/** REST /ticker/24hr 응답. 모든 수치가 문자열로 온다. */
export function parseTicker(raw) {
  const changePrice = num(raw.priceChange);
  return {
    exchange: id,
    coin: coinOf(raw.symbol),
    price: num(raw.lastPrice),
    // priceChangePercent 는 퍼센트값(-0.324)이므로 비율로 바꾼다.
    changeRate: num(raw.priceChangePercent) === null ? null : num(raw.priceChangePercent) / 100,
    changePrice,
    direction: directionOf(changePrice),
    dayHigh: num(raw.highPrice),
    dayLow: num(raw.lowPrice),
    quoteVolume24h: num(raw.quoteVolume),
    at: new Date(),
  };
}

/** WebSocket !ticker 페이로드는 필드 이름이 한 글자로 줄어 있다. */
export function parseSocketTicker(data) {
  const changePrice = num(data.p);
  return {
    exchange: id,
    coin: coinOf(data.s),
    price: num(data.c),
    changeRate: num(data.P) === null ? null : num(data.P) / 100,
    changePrice,
    direction: directionOf(changePrice),
    dayHigh: num(data.h),
    dayLow: num(data.l),
    quoteVolume24h: num(data.q),
    at: new Date(),
  };
}

/** klines 는 배열의 배열이다: [openTime, open, high, low, close, volume, ...] */
export function parseCandles(raw) {
  const candles = raw.map((row) =>
    candleFrom({
      timestampMs: row[0],
      open: row[1],
      high: row[2],
      low: row[3],
      close: row[4],
      volume: row[5],
    }),
  );
  return ascending(candles);
}

export async function fetchTickers(coins) {
  // symbols 파라미터는 JSON 배열 문자열이어야 한다.
  const symbols = JSON.stringify(coins.map(symbolOf));
  const raw = await getJson(`${REST}/ticker/24hr?symbols=${encodeURIComponent(symbols)}`, {
    exchange: name,
  });
  return raw.map(parseTicker);
}

export async function fetchCandles(coin, timeframeKey, count = CANDLE_COUNT) {
  const interval = INTERVALS[timeframeKey];
  if (!interval) throw new ExchangeError(`알 수 없는 봉 주기: ${timeframeKey}`, { exchange: name });

  const raw = await getJson(
    `${REST}/klines?symbol=${symbolOf(coin)}&interval=${interval}&limit=${count}`,
    { exchange: name },
  );
  return parseCandles(raw);
}


/** 종목별로 소켓을 따로 열지 않고 combined stream 하나로 묶는다. */
export function openSocket(coins, { onTick, onOpen, onClose }) {
  const streams = coins.map((coin) => `${symbolOf(coin).toLowerCase()}@ticker`).join('/');
  const socket = new WebSocket(`${SOCKET}?streams=${streams}`);

  socket.addEventListener('open', () => onOpen?.());

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.data?.s) onTick(parseSocketTicker(message.data));
  });

  socket.addEventListener('close', () => onClose?.());
  socket.addEventListener('error', () => socket.close());

  return { close: () => socket.close() };
}

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
