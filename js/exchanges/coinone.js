/**
 * 코인원 어댑터. KRW 마켓.
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

const REST = 'https://api.coinone.co.kr/public/v2';
const SOCKET = 'wss://stream.coinone.co.kr';

const INTERVALS = { day: '1d', h4: '4h', h1: '1h' };

export const id = 'coinone';
export const name = '코인원';
export const quote = 'KRW';
export const providesFx = false;

/**
 * **브라우저에서 REST 를 쓸 수 없다.**
 *
 * 코인원 공개 API 는 어떤 경로도 `access-control-allow-origin` 헤더를 주지 않아
 * (ticker_new · chart · orderbook · 구형 /ticker 전부 확인) 브라우저가 응답을
 * 차단한다. Node 의 fetch 는 CORS 를 무시하므로 서버 쪽 테스트만으로는 드러나지
 * 않는다 — 실제로 이 프로젝트에서도 브라우저 검증에서야 잡혔다.
 *
 * WebSocket 은 CORS 적용 대상이 아니라 정상 동작한다. 그래서 코인원은 시세만
 * 제공하고 캔들·지표는 내지 않는 '시세 전용' 거래소로 다룬다. 프록시 서버를
 * 두면 해결되지만, 백엔드 없는 정적 페이지라는 이 프로젝트의 전제가 깨진다.
 */
export const browserRest = false;

export const note = 'CORS 미허용으로 브라우저에서 캔들을 받을 수 없다';

export const symbolOf = (coin) => `KRW-${coin}`;

/**
 * 코인원은 시가를 `first` 로 준다. 변동률·변동액은 주지 않으므로 직접 만든다.
 *
 * 주의: REST `first/high/low` 는 24시간 기준이고 소켓은 당일 기준이다. 같은
 * 종목의 변동률이 소켓↔폴백 전환 시 조금 달라질 수 있다 — 지표 계산은 캔들로
 * 하므로 시그널에는 영향이 없다.
 */
export function parseTicker(raw) {
  const price = num(raw.last);
  const open = num(raw.first);
  const changePrice = price !== null && open !== null ? price - open : null;

  return {
    exchange: id,
    coin: String(raw.target_currency).toUpperCase(),
    price,
    changeRate: changePrice !== null && open ? changePrice / open : null,
    changePrice,
    direction: directionOf(changePrice),
    dayHigh: num(raw.high),
    dayLow: num(raw.low),
    quoteVolume24h: num(raw.quote_volume),
    at: new Date(),
  };
}

/** chart 응답은 최신순이고 timestamp 는 밀리초다. */
export function parseCandles(payload) {
  const rows = payload?.chart ?? [];
  const candles = rows.map((row) =>
    candleFrom({
      timestampMs: Number(row.timestamp),
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.target_volume,
    }),
  );
  return ascending(candles);
}

function ensureOk(payload, context) {
  if (payload?.result !== 'success') {
    throw new ExchangeError(`${name} ${context} 실패: ${payload?.error_code ?? '알 수 없는 오류'}`, {
      exchange: name,
    });
  }
  return payload;
}

/** ticker_new 는 종목을 하나씩만 받으므로 종목별로 호출한다. */
export async function fetchTickers(coins) {
  const tickers = [];

  for (const [index, coin] of coins.entries()) {
    if (index > 0) await sleep(POLL.candleGapMs);
    const payload = ensureOk(
      await getJson(`${REST}/ticker_new/KRW/${coin}`, { exchange: name }),
      'ticker',
    );
    const row = payload.tickers?.[0];
    if (row) tickers.push(parseTicker(row));
  }

  return tickers;
}

export async function fetchCandles(coin, timeframeKey, count = CANDLE_COUNT) {
  const interval = INTERVALS[timeframeKey];
  if (!interval) throw new ExchangeError(`알 수 없는 봉 주기: ${timeframeKey}`, { exchange: name });

  const payload = ensureOk(
    await getJson(`${REST}/chart/KRW/${coin}?interval=${interval}&size=${count}`, {
      exchange: name,
    }),
    'chart',
  );
  return parseCandles(payload);
}

/**
 * 코인원 소켓은 구독을 종목별로 따로 보내야 한다. 응답은 response_type 으로
 * 종류가 갈리고, 시세는 DATA 만 담고 있다.
 */
export function openSocket(coins, { onTick, onOpen, onClose }) {
  const ws = new WebSocket(SOCKET);

  ws.addEventListener('open', () => {
    for (const coin of coins) {
      ws.send(
        JSON.stringify({
          request_type: 'SUBSCRIBE',
          channel: 'TICKER',
          topic: { quote_currency: 'KRW', target_currency: coin },
        }),
      );
    }
    onOpen?.();
  });

  ws.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.response_type === 'DATA' && message.channel === 'TICKER' && message.data) {
      onTick(parseTicker(message.data));
    }
  });

  ws.addEventListener('close', () => onClose?.());
  ws.addEventListener('error', () => ws.close());

  return { close: () => ws.close() };
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
