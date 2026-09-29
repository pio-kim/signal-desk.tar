/**
 * OKX 어댑터. USDT 현물 마켓.
 *
 * 파이코인(PI)이 이 거래소에만 있어서 추가됐다(config.js 의 EXTRA_COINS 참고) —
 * 업비트 카탈로그 기준인 다른 종목들과 달리, PI 는 다른 7개 거래소에는 아예
 * 요청조차 하지 않는다.
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

const REST = 'https://www.okx.com/api/v5';
const SOCKET = 'wss://ws.okx.com:8443/ws/v5/public';

const BARS = { day: '1D', h4: '4H', h1: '1H' };

export const id = 'okx';
export const name = 'OKX';
export const quote = 'USDT';
export const providesFx = false;
export const browserRest = true;
export const note = '핑퐁이 JSON 이 아니라 평문(ping/pong)이다';

export const symbolOf = (coin) => `${coin}-USDT`;
const coinOf = (instId) => instId.replace(/-USDT$/i, '').toUpperCase();

/**
 * OKX 는 변화 금액·비율을 직접 주지 않고 24시간 전 시가(open24h)만 준다.
 * Bybit·크라켄과 같은 이유로 직접 뺄셈해서 만든다.
 */
export function parseTicker(raw) {
  const price = num(raw.last);
  const open = num(raw.open24h);
  const changePrice = price !== null && open !== null ? price - open : null;
  const changeRate = changePrice !== null && open ? changePrice / open : null;

  return {
    exchange: id,
    coin: coinOf(raw.instId),
    price,
    changeRate,
    changePrice,
    direction: directionOf(changePrice),
    dayHigh: num(raw.high24h),
    dayLow: num(raw.low24h),
    quoteVolume24h: num(raw.volCcy24h),
    at: new Date(),
  };
}

/** candles 행은 [ts, open, high, low, close, vol, volCcy, volCcyQuote, confirm] 이고 최신순이다. */
export function parseCandles(payload) {
  const rows = payload?.data ?? [];
  const candles = rows.map((row) =>
    candleFrom({
      timestampMs: Number(row[0]),
      open: row[1],
      high: row[2],
      low: row[3],
      close: row[4],
      volume: row[5],
    }),
  );
  return ascending(candles);
}

function ensureOk(payload, context) {
  if (payload?.code !== '0') {
    throw new ExchangeError(`${name} ${context} 실패: ${payload?.msg ?? '알 수 없는 오류'}`, {
      exchange: name,
      // 51001 = 없는 심볼. 재시도해도 같은 답이라 즉시 포기한다.
      retryable: payload?.code !== '51001',
    });
  }
  return payload;
}

/**
 * 종목별로 한 번씩 호출한다(OKX 티커 엔드포인트는 instId 하나만 받는다).
 * 한 종목이 실패해도(예: 이 거래소에 없는 종목) 나머지는 계속 받는다 —
 * 배치 하나로 묶는 거래소(업비트·바이낸스)와 달리 한 종목의 실패가 전체를
 * 무너뜨리지 않는다.
 */
export async function fetchTickers(coins) {
  const results = [];
  for (const [index, coin] of coins.entries()) {
    if (index > 0) await sleep(POLL.candleGapMs);
    try {
      const payload = ensureOk(
        await getJson(`${REST}/market/ticker?instId=${symbolOf(coin)}`, { exchange: name }),
        'ticker',
      );
      const row = payload.data?.[0];
      if (row) results.push(parseTicker(row));
    } catch (error) {
      if (error instanceof ExchangeError && !error.retryable) continue; // 없는 종목 — 조용히 건너뛴다.
      throw error;
    }
  }
  return results;
}

export async function fetchCandles(coin, timeframeKey, count = CANDLE_COUNT) {
  const bar = BARS[timeframeKey];
  if (!bar) throw new ExchangeError(`알 수 없는 봉 주기: ${timeframeKey}`, { exchange: name });

  // OKX 는 한 번에 최대 300개까지만 준다.
  const limit = Math.min(count, 300);
  const payload = ensureOk(
    await getJson(`${REST}/market/candles?instId=${symbolOf(coin)}&bar=${bar}&limit=${limit}`, {
      exchange: name,
    }),
    'candles',
  );
  return parseCandles(payload);
}

/**
 * OKX 는 20~30초 안에 프레임이 없으면 연결을 끊는다. 다른 거래소와 달리
 * JSON 이 아니라 평문 "ping"/"pong" 을 주고받는다 — JSON.parse 전에 먼저
 * 걸러내야 한다(그대로 넘기면 매번 파싱 실패로 조용히 메시지를 버린다).
 */
export function openSocket(coins, { onTick, onOpen, onClose }) {
  const socket = new WebSocket(SOCKET);
  let heartbeat = null;

  socket.addEventListener('open', () => {
    socket.send(
      JSON.stringify({
        op: 'subscribe',
        args: coins.map((coin) => ({ channel: 'tickers', instId: symbolOf(coin) })),
      }),
    );
    heartbeat = setInterval(() => socket.send('ping'), 20_000);
    onOpen?.();
  });

  socket.addEventListener('message', (event) => {
    if (event.data === 'pong') return;

    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message?.arg?.channel !== 'tickers' || !message.data?.length) return;
    for (const row of message.data) onTick(parseTicker(row));
  });

  const stop = () => {
    clearInterval(heartbeat);
    heartbeat = null;
  };

  socket.addEventListener('close', () => {
    stop();
    onClose?.();
  });
  socket.addEventListener('error', () => socket.close());

  return {
    close: () => {
      stop();
      socket.close();
    },
  };
}

const adapter = {
  id,
  name,
  quote,
  providesFx,
  browserRest,
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
