/**
 * 빗썸 어댑터. KRW 마켓.
 *
 * 빗썸은 업비트 호환 v1 API 를 제공하므로 프로토콜 구현을 공유한다. 구형
 * `/public/*` 와 `pubwss.bithumb.com` 도 살아 있지만 v1 쪽 필드가 정규화돼 있다.
 *
 * 안정성 실측(2026-09-03): REST 30/30 성공(5~114ms), 신규·구형 소켓 모두 45~58초
 * 무중단. 한도는 초당 약 150회로 업비트(초당 10회)보다 15배 관대하다. 다만 429
 * 응답의 **본문이 비어 있어서**, res.ok 를 확인하지 않고 json() 을 호출하면
 * 파싱 오류가 나고 원인이 '연결 끊김'으로 오인된다. shared.js 의 getJson 은
 * 상태 코드를 먼저 본다.
 */

import { createUpbitStyle } from './upbit-style.js';

const adapter = createUpbitStyle({
  id: 'bithumb',
  name: '빗썸',
  rest: 'https://api.bithumb.com/v1',
  socket: 'wss://ws-api.bithumb.com/websocket/v1',
  // 일봉 경계가 업비트와 다르다. 같은 종목의 일봉 지표가 정당하게 달라진다.
  note: '일봉이 00:00 KST 에 시작',
});

export const {
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
  fetchCandleSet,
  openSocket,
} = adapter;
