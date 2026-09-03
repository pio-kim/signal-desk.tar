/**
 * 업비트 프로토콜 어댑터 공장.
 *
 * 빗썸이 업비트의 공개 API 를 그대로 복제해 제공하므로(경로·필드·소켓 프로토콜이
 * 동일) 두 거래소를 한 구현으로 다룬다. 한쪽이 갈라지면 그때 분리하면 된다.
 */

import { CANDLE_COUNT, FX_ASSET, POLL, TIMEFRAMES } from '../config.js';
import { ExchangeError, ascending, buildCandleSet, candleFrom, getJson, num } from './shared.js';

const ENDPOINTS = {
  day: 'candles/days',
  h4: 'candles/minutes/240',
  h1: 'candles/minutes/60',
};

export function createUpbitStyle({
  id,
  name,
  rest,
  socket,
  providesFx = false,
  gapMs = POLL.candleGapMs,
  note = '',
  /** 호가·체결 스트림까지 구독할지. 실시간 수급 지표를 내는 거래소만 켠다. */
  streamsFlow = false,
}) {
  const symbolOf = (coin) => `KRW-${coin}`;
  const coinOf = (symbol) => String(symbol).replace('KRW-', '');

  /**
   * REST 와 WebSocket 이 같은 필드 이름을 쓰므로 파서를 공유한다.
   * signed_* 는 부호가 붙은 값이라 change 필드로 방향을 다시 계산할 필요가 없다.
   */
  function parseTicker(raw) {
    return {
      exchange: id,
      coin: coinOf(raw.code ?? raw.market),
      price: num(raw.trade_price),
      changeRate: num(raw.signed_change_rate),
      changePrice: num(raw.signed_change_price),
      direction: raw.change,
      // 고가·저가는 당일 기준이다. 24시간 롤링이 아니다.
      dayHigh: num(raw.high_price),
      dayLow: num(raw.low_price),
      quoteVolume24h: num(raw.acc_trade_price_24h),
      at: new Date(),
    };
  }

  /** 응답은 최신순이다. 한 번 뒤집어 오래된→최신으로 맞춘다. */
  function parseCandles(raw) {
    const candles = raw.map((row) => ({
      ...candleFrom({
        timestampMs: Date.parse(`${row.candle_date_time_utc}Z`),
        open: row.opening_price,
        high: row.high_price,
        low: row.low_price,
        close: row.trade_price,
        volume: row.candle_acc_trade_volume,
      }),
      // KST 문자열을 직접 주므로 변환 오차 없이 그대로 쓴다.
      kst: row.candle_date_time_kst,
    }));
    return ascending(candles);
  }

  /** 호가 30단계의 총 잔량. 단계별 값은 불균형 계산에 쓰지 않는다. */
  function parseOrderbook(raw) {
    return {
      exchange: id,
      coin: coinOf(raw.code),
      totalBidSize: num(raw.total_bid_size),
      totalAskSize: num(raw.total_ask_size),
      at: raw.timestamp ?? Date.now(),
    };
  }

  /** ask_bid 는 체결을 일으킨 쪽이다. BID 면 매수가 시장가로 받아간 체결이다. */
  function parseTrade(raw) {
    return {
      exchange: id,
      coin: coinOf(raw.code),
      side: raw.ask_bid,
      volume: num(raw.trade_volume),
      price: num(raw.trade_price),
      at: raw.trade_timestamp ?? raw.timestamp ?? Date.now(),
    };
  }

  const codesFor = (coins) =>
    providesFx ? [...coins.map(symbolOf), symbolOf(FX_ASSET)] : coins.map(symbolOf);

  async function fetchTickers(coins) {
    const raw = await getJson(`${rest}/ticker?markets=${codesFor(coins).join(',')}`, {
      exchange: name,
    });
    return raw.map(parseTicker);
  }

  async function fetchCandles(coin, timeframeKey, count = CANDLE_COUNT) {
    const endpoint = ENDPOINTS[timeframeKey];
    if (!endpoint) throw new ExchangeError(`알 수 없는 봉 주기: ${timeframeKey}`, { exchange: name });

    const raw = await getJson(`${rest}/${endpoint}?market=${symbolOf(coin)}&count=${count}`, {
      exchange: name,
    });
    return parseCandles(raw);
  }

  /**
   * 업비트 계열 소켓은 응답을 **바이너리 프레임**으로 보낸다. binaryType 을
   * arraybuffer 로 두고 직접 디코딩하지 않으면 메시지가 통째로 버려진다.
   */
  function openSocket(coins, { onTick, onOpen, onClose, onOrderbook, onTrade }) {
    const ws = new WebSocket(socket);
    ws.binaryType = 'arraybuffer';
    const decoder = new TextDecoder();

    ws.addEventListener('open', () => {
      const request = [
        { ticket: `signal-desk-${Date.now()}` },
        { type: 'ticker', codes: codesFor(coins) },
      ];

      /*
       * 호가·체결은 티커보다 훨씬 자주 오므로 필요한 거래소에서만 구독한다.
       * 환율용 KRW-USDT 는 수급 판정 대상이 아니라 제외한다.
       */
      if (streamsFlow) {
        const codes = coins.map(symbolOf);
        request.push({ type: 'orderbook', codes });
        request.push({ type: 'trade', codes });
      }

      request.push({ format: 'DEFAULT' });
      ws.send(JSON.stringify(request));
      onOpen?.();
    });

    ws.addEventListener('message', (event) => {
      const text = typeof event.data === 'string' ? event.data : decoder.decode(event.data);
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return; // 하트비트 등 JSON 이 아닌 프레임은 무시한다.
      }

      if (message.type === 'ticker') onTick(parseTicker(message));
      else if (message.type === 'orderbook') onOrderbook?.(parseOrderbook(message));
      else if (message.type === 'trade') onTrade?.(parseTrade(message));
    });

    ws.addEventListener('close', () => onClose?.());
    ws.addEventListener('error', () => ws.close());

    return { close: () => ws.close() };
  }

  const adapter = {
    id,
    name,
    quote: 'KRW',
    providesFx,
    browserRest: true,
    note,
    symbolOf,
    parseTicker,
    parseOrderbook,
    parseTrade,
    parseCandles,
    fetchTickers,
    fetchCandles,
    openSocket,
  };

  adapter.fetchCandleSet = (coins) => buildCandleSet(adapter, coins, TIMEFRAMES, gapMs);
  return adapter;
}
