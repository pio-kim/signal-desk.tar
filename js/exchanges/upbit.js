/**
 * 업비트 어댑터. KRW 마켓이며 김치 프리미엄 기준 환율(KRW-USDT)도 제공한다.
 * 프로토콜 구현은 upbit-style.js 가 담당한다.
 */

import { createUpbitStyle } from './upbit-style.js';

const adapter = createUpbitStyle({
  id: 'upbit',
  name: '업비트',
  rest: 'https://api.upbit.com/v1',
  socket: 'wss://api.upbit.com/websocket/v1',
  providesFx: true,
  streamsFlow: true,
  note: '일봉이 09:00 KST 에 시작',
});

export const {
  id,
  name,
  quote,
  providesFx,
  browserRest,
  parseOrderbook,
  parseTrade,
  note,
  symbolOf,
  parseTicker,
  parseCandles,
  fetchTickers,
  fetchCandles,
  fetchCandleSet,
  openSocket,
} = adapter;
