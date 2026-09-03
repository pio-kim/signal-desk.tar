/**
 * Bybit 어댑터. USDT 현물 마켓.
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

const REST = 'https://api.bybit.com/v5';
const SOCKET = 'wss://stream.bybit.com/v5/public/spot';

const INTERVALS = { day: 'D', h4: '240', h1: '60' };

export const id = 'bybit';
export const name = 'Bybit';
export const quote = 'USDT';
export const providesFx = false;
export const browserRest = true;
export const note = '소켓이 스냅샷 뒤 델타를 보낼 수 있다';

export const symbolOf = (coin) => `${coin}USDT`;
const coinOf = (symbol) => symbol.replace(/USDT$/i, '').toUpperCase();

/**
 * Bybit 은 24시간 변화를 비율(price24hPcnt)로만 주고 변화 금액은 주지 않는다.
 * prevPrice24h 와의 차이로 직접 만든다.
 */
export function parseTicker(raw) {
  const price = num(raw.lastPrice);
  const previous = num(raw.prevPrice24h);
  const changePrice = price !== null && previous !== null ? price - previous : null;

  return {
    exchange: id,
    coin: coinOf(raw.symbol),
    price,
    changeRate: num(raw.price24hPcnt),
    changePrice,
    direction: directionOf(changePrice),
    dayHigh: num(raw.highPrice24h),
    dayLow: num(raw.lowPrice24h),
    quoteVolume24h: num(raw.turnover24h),
    at: new Date(),
  };
}

/** kline 은 [start, open, high, low, close, volume, turnover] 이고 최신순이다. */
export function parseCandles(payload) {
  const rows = payload?.result?.list ?? [];
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
  if (payload?.retCode !== 0) {
    throw new ExchangeError(`${name} ${context} 실패: ${payload?.retMsg ?? '알 수 없는 오류'}`, {
      exchange: name,
    });
  }
  return payload;
}

export async function fetchTickers(coins) {
  // v5 tickers 는 symbol 을 하나씩만 받으므로 종목별로 호출한다.
  const results = [];
  for (const [index, coin] of coins.entries()) {
    if (index > 0) await sleep(POLL.candleGapMs);
    const payload = ensureOk(
      await getJson(`${REST}/market/tickers?category=spot&symbol=${symbolOf(coin)}`, {
        exchange: name,
      }),
      'tickers',
    );
    const row = payload.result?.list?.[0];
    if (row) results.push(parseTicker(row));
  }
  return results;
}

export async function fetchCandles(coin, timeframeKey, count = CANDLE_COUNT) {
  const interval = INTERVALS[timeframeKey];
  if (!interval) throw new ExchangeError(`알 수 없는 봉 주기: ${timeframeKey}`, { exchange: name });

  const payload = ensureOk(
    await getJson(
      `${REST}/market/kline?category=spot&symbol=${symbolOf(coin)}&interval=${interval}&limit=${count}`,
      { exchange: name },
    ),
    'kline',
  );
  return parseCandles(payload);
}


/**
 * Bybit 은 스냅샷 뒤에 **변경된 필드만** 델타로 보낼 수 있다. 델타를 그대로
 * 쓰면 price 만 있고 고가·저가가 사라진 티커가 화면에 올라간다. 심볼별 최신
 * 상태를 들고 있으면서 병합해야 한다.
 *
 * @param {Map<string, object>} cache 심볼 → 마지막 원본 페이로드
 */
export function mergeSocketMessage(cache, message) {
  const topic = message?.topic ?? '';
  if (!topic.startsWith('tickers.') || !message.data?.symbol) return null;

  const symbol = message.data.symbol;
  const merged =
    message.type === 'delta' && cache.has(symbol)
      ? { ...cache.get(symbol), ...message.data }
      : { ...message.data };

  cache.set(symbol, merged);
  return parseTicker(merged);
}

export function openSocket(coins, { onTick, onOpen, onClose }) {
  const socket = new WebSocket(SOCKET);
  const cache = new Map();
  let heartbeat = null;

  socket.addEventListener('open', () => {
    socket.send(
      JSON.stringify({ op: 'subscribe', args: coins.map((coin) => `tickers.${symbolOf(coin)}`) }),
    );
    // Bybit 은 20초 안에 프레임이 없으면 연결을 끊는다.
    heartbeat = setInterval(() => socket.send(JSON.stringify({ op: 'ping' })), 20_000);
    onOpen?.();
  });

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    const ticker = mergeSocketMessage(cache, message);
    if (ticker) onTick(ticker);
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
