/**
 * 어댑터 파싱 테스트. 실제 응답에서 잡아온 고정 픽스처를 쓴다.
 *
 * 거래소 3곳의 응답 형태가 전부 다르고 그 변환이 이 프로젝트에서 가장 깨지기
 * 쉬운 지점이므로, 네트워크 없이 돌 수 있게 파싱만 떼어 검증한다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as upbit from '../js/exchanges/upbit.js';
import * as bithumb from '../js/exchanges/bithumb.js';
import * as coinone from '../js/exchanges/coinone.js';
import * as binance from '../js/exchanges/binance.js';
import * as bybit from '../js/exchanges/bybit.js';
import * as coinbase from '../js/exchanges/coinbase.js';
import * as kraken from '../js/exchanges/kraken.js';
import { EXCHANGES, exchangeOf, fxExchange } from '../js/exchanges/index.js';
import { aggregateCandles, candleFrom, kstString } from '../js/exchanges/shared.js';
import { DEFAULT_COINS as COINS, MAX_COINS, TIMEFRAMES } from '../js/config.js';

// ── 픽스처 ───────────────────────────────────────────────────

const UPBIT_TICKER = {
  market: 'KRW-XRP',
  trade_price: 1859,
  signed_change_rate: -0.0021,
  signed_change_price: -4,
  change: 'FALL',
  high_price: 1872,
  low_price: 1802,
  acc_trade_price_24h: 156_300_000_000,
};

const UPBIT_CANDLES = [
  {
    candle_date_time_utc: '2026-09-02T00:00:00',
    candle_date_time_kst: '2026-09-02T09:00:00',
    opening_price: 1860,
    high_price: 1872,
    low_price: 1802,
    trade_price: 1859,
    candle_acc_trade_volume: 1000,
  },
  {
    candle_date_time_utc: '2026-09-01T00:00:00',
    candle_date_time_kst: '2026-09-01T09:00:00',
    opening_price: 1800,
    high_price: 1870,
    low_price: 1790,
    trade_price: 1860,
    candle_acc_trade_volume: 900,
  },
];

const BINANCE_TICKER = {
  symbol: 'XRPUSDT',
  priceChange: '0.00170000',
  priceChangePercent: '0.127',
  lastPrice: '1.34550000',
  highPrice: '1.35780000',
  lowPrice: '1.30980000',
  quoteVolume: '157866295.98067000',
};

const BINANCE_SOCKET = {
  s: 'XRPUSDT',
  c: '1.34550000',
  p: '0.00170000',
  P: '0.127',
  h: '1.35780000',
  l: '1.30980000',
  q: '157866295.98067000',
};

const BINANCE_KLINES = [
  [1788307200000, '1.35170000', '1.35800000', '1.31000000', '1.35120000', '28476272.28', 0, '0'],
  [1788393600000, '1.35120000', '1.35480000', '1.34360000', '1.34550000', '3457863.50000000', 0, '0'],
];

const BYBIT_TICKER = {
  symbol: 'XRPUSDT',
  lastPrice: '1.3456',
  prevPrice24h: '1.346',
  price24hPcnt: '-0.0003',
  highPrice24h: '1.358',
  lowPrice24h: '1.31',
  turnover24h: '39133810.61962',
};

const BYBIT_KLINE = {
  retCode: 0,
  result: {
    list: [
      ['1788393600000', '1.3512', '1.355', '1.3438', '1.3456', '1069535.83', '1442587.07'],
      ['1788307200000', '1.3517', '1.358', '1.31', '1.3512', '28476272.28', '38127939.61'],
    ],
  },
};

// ── 공통 계약 ────────────────────────────────────────────────

test('모든 어댑터가 같은 인터페이스를 노출한다', () => {
  for (const exchange of EXCHANGES) {
    for (const member of ['id', 'name', 'quote', 'symbolOf', 'fetchTickers', 'fetchCandles', 'fetchCandleSet', 'openSocket', 'parseTicker', 'parseCandles']) {
      assert.ok(exchange[member] !== undefined, `${exchange.id} 에 ${member} 가 없다`);
    }
  }
});

test('환율 제공 거래소는 업비트 하나뿐이다', () => {
  assert.equal(fxExchange.id, 'upbit');
  assert.equal(EXCHANGES.filter((e) => e.providesFx).length, 1);
});

test('레지스트리에 거래소 7곳이 견적 통화별로 담겨 있다', () => {
  assert.deepEqual(
    EXCHANGES.map((e) => e.id),
    ['upbit', 'bithumb', 'coinone', 'binance', 'bybit', 'coinbase', 'kraken'],
  );
  assert.deepEqual(
    EXCHANGES.map((e) => e.quote),
    ['KRW', 'KRW', 'KRW', 'USDT', 'USDT', 'USD', 'USD'],
  );
});

// ── 봉 합성 (코인베이스 4시간봉) ─────────────────────────────

/** 정시 1시간봉을 만든다. hours[i] 시각의 봉. */
function hourly(hours, values) {
  return hours.map((hour, i) =>
    candleFrom({
      timestampMs: Date.UTC(2026, 8, 3, hour),
      open: values[i].o,
      high: values[i].h,
      low: values[i].l,
      close: values[i].c,
      volume: values[i].v,
    }),
  );
}

test('aggregateCandles: 1시간봉 4개를 4시간봉 하나로 묶는다', () => {
  const candles = hourly(
    [0, 1, 2, 3, 4, 5, 6, 7],
    [
      { o: 100, h: 105, l: 99, c: 104, v: 1 },
      { o: 104, h: 110, l: 103, c: 108, v: 2 },
      { o: 108, h: 109, l: 95, c: 97, v: 3 },
      { o: 97, h: 102, l: 96, c: 101, v: 4 },
      { o: 101, h: 103, l: 100, c: 102, v: 5 },
      { o: 102, h: 104, l: 101, c: 103, v: 6 },
      { o: 103, h: 106, l: 102, c: 105, v: 7 },
      { o: 105, h: 107, l: 104, c: 106, v: 8 },
    ],
  );

  const four = aggregateCandles(candles, 240);

  assert.equal(four.length, 2);
  assert.equal(four[0].open, 100, '첫 봉의 시가');
  assert.equal(four[0].close, 101, '마지막 봉의 종가');
  assert.equal(four[0].high, 110, '구간 최고가');
  assert.equal(four[0].low, 95, '구간 최저가');
  assert.equal(four[0].volume, 10, '거래량 합');
  assert.equal(four[0].kst, '2026-09-03T09:00:00', 'UTC 00:00 → KST 09:00');
  assert.equal(four[1].open, 101);
  assert.equal(four[1].close, 106);
});

test('aggregateCandles: 앞쪽이 덜 찬 구간은 버린다', () => {
  // 02시부터 시작하면 00시 구간에 2개뿐이라 시가가 실제 시가가 아니다.
  const candles = hourly(
    [2, 3, 4, 5, 6, 7],
    Array.from({ length: 6 }, (_, i) => ({ o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i, v: 1 })),
  );

  const four = aggregateCandles(candles, 240);

  assert.equal(four.length, 1, '불완전한 앞 구간은 제외');
  assert.equal(four[0].open, 102, '04시 봉의 시가');
});

test('aggregateCandles: 빈 입력은 빈 배열', () => {
  assert.deepEqual(aggregateCandles([], 240), []);
  assert.deepEqual(aggregateCandles(null, 240), []);
});

test('거래소마다 세 종목의 심볼을 만들 수 있다', () => {
  assert.deepEqual(
    COINS.map((c) => upbit.symbolOf(c.id)),
    ['KRW-BTC', 'KRW-XRP', 'KRW-ETH'],
  );
  assert.deepEqual(
    COINS.map((c) => binance.symbolOf(c.id)),
    ['BTCUSDT', 'XRPUSDT', 'ETHUSDT'],
  );
  assert.deepEqual(
    COINS.map((c) => bybit.symbolOf(c.id)),
    ['BTCUSDT', 'XRPUSDT', 'ETHUSDT'],
  );
});

test('exchangeOf: 없는 id 는 undefined', () => {
  assert.equal(exchangeOf('upbit').name, '업비트');
  assert.equal(exchangeOf('없는거래소'), undefined);
});

test('kstString: UTC 자정은 KST 오전 9시다', () => {
  assert.equal(kstString(new Date('2026-09-02T00:00:00Z')), '2026-09-02T09:00:00');
  assert.equal(kstString(new Date('2026-09-02T15:30:00Z')), '2026-09-03T00:30:00');
});

// ── 업비트 ───────────────────────────────────────────────────

test('업비트 티커: signed_* 를 그대로 쓰고 방향은 change 필드를 따른다', () => {
  const ticker = upbit.parseTicker(UPBIT_TICKER);

  assert.equal(ticker.exchange, 'upbit');
  assert.equal(ticker.coin, 'XRP');
  assert.equal(ticker.price, 1859);
  assert.equal(ticker.changeRate, -0.0021);
  assert.equal(ticker.changePrice, -4);
  assert.equal(ticker.direction, 'FALL');
  assert.equal(ticker.quoteVolume24h, 156_300_000_000);
});

test('업비트 티커: WebSocket 은 market 대신 code 로 온다', () => {
  const ticker = upbit.parseTicker({ ...UPBIT_TICKER, market: undefined, code: 'KRW-BTC' });
  assert.equal(ticker.coin, 'BTC');
});

test('업비트 캔들: 최신순 응답을 뒤집고 KST 문자열을 그대로 보존한다', () => {
  const candles = upbit.parseCandles(UPBIT_CANDLES);

  assert.equal(candles.length, 2);
  assert.equal(candles[0].kst, '2026-09-01T09:00:00', '오래된 봉이 먼저 와야 한다');
  assert.equal(candles[1].kst, '2026-09-02T09:00:00');
  assert.equal(candles[1].open, 1860);
  assert.equal(candles[1].close, 1859);
  assert.equal(candles[1].volume, 1000);
});

// ── 바이낸스 ─────────────────────────────────────────────────

test('바이낸스 티커: 퍼센트값을 비율로 바꾼다', () => {
  const ticker = binance.parseTicker(BINANCE_TICKER);

  assert.equal(ticker.exchange, 'binance');
  assert.equal(ticker.coin, 'XRP');
  assert.equal(ticker.price, 1.3455);
  // 0.127% 는 0.00127 이다. 100 으로 나누지 않으면 변동률이 127배로 부풀어 보인다.
  assert.ok(Math.abs(ticker.changeRate - 0.00127) < 1e-12, `실제 ${ticker.changeRate}`);
  assert.equal(ticker.direction, 'RISE');
  assert.equal(ticker.quoteVolume24h, 157866295.98067);
});

test('바이낸스 소켓: 한 글자 필드도 같은 결과를 낸다', () => {
  const fromRest = binance.parseTicker(BINANCE_TICKER);
  const fromSocket = binance.parseSocketTicker(BINANCE_SOCKET);

  assert.equal(fromSocket.coin, fromRest.coin);
  assert.equal(fromSocket.price, fromRest.price);
  assert.equal(fromSocket.changeRate, fromRest.changeRate);
  assert.equal(fromSocket.dayHigh, fromRest.dayHigh);
});

test('바이낸스 캔들: 배열의 배열을 정규화하고 순서를 유지한다', () => {
  const candles = binance.parseCandles(BINANCE_KLINES);

  assert.equal(candles.length, 2);
  assert.ok(candles[0].time < candles[1].time);
  assert.equal(candles[1].open, 1.3512);
  assert.equal(candles[1].high, 1.3548);
  assert.equal(candles[1].low, 1.3436);
  assert.equal(candles[1].close, 1.3455);
  // 1788393600000 = 2026-09-03T00:00:00Z → KST 는 같은 날 오전 9시
  assert.equal(candles[1].kst, '2026-09-03T09:00:00');
});

// ── Bybit ────────────────────────────────────────────────────

test('Bybit 티커: 변화 금액을 prevPrice24h 로 직접 만든다', () => {
  const ticker = bybit.parseTicker(BYBIT_TICKER);

  assert.equal(ticker.exchange, 'bybit');
  assert.equal(ticker.coin, 'XRP');
  assert.equal(ticker.price, 1.3456);
  assert.equal(ticker.changeRate, -0.0003, 'price24hPcnt 는 이미 비율이다');
  assert.ok(Math.abs(ticker.changePrice + 0.0004) < 1e-9, `실제 ${ticker.changePrice}`);
  assert.equal(ticker.direction, 'FALL');
});

test('Bybit 캔들: 문자열 타임스탬프와 최신순 정렬을 모두 처리한다', () => {
  const candles = bybit.parseCandles(BYBIT_KLINE);

  assert.equal(candles.length, 2);
  assert.ok(candles[0].time < candles[1].time, '오래된 봉이 먼저 와야 한다');
  assert.equal(candles[1].close, 1.3456);
  assert.equal(candles[1].volume, 1069535.83);
});

test('Bybit 캔들: 응답이 비어도 예외를 던지지 않는다', () => {
  assert.deepEqual(bybit.parseCandles({ retCode: 0, result: { list: [] } }), []);
  assert.deepEqual(bybit.parseCandles({}), []);
});

test('Bybit 소켓: 델타는 스냅샷에 병합해야 필드가 사라지지 않는다', () => {
  const cache = new Map();

  const snapshot = bybit.mergeSocketMessage(cache, {
    topic: 'tickers.XRPUSDT',
    type: 'snapshot',
    data: BYBIT_TICKER,
  });
  assert.equal(snapshot.dayHigh, 1.358);

  // 델타에는 바뀐 필드만 온다. 병합하지 않으면 고가·저가가 null 이 된다.
  const delta = bybit.mergeSocketMessage(cache, {
    topic: 'tickers.XRPUSDT',
    type: 'delta',
    data: { symbol: 'XRPUSDT', lastPrice: '1.4000' },
  });

  assert.equal(delta.price, 1.4);
  assert.equal(delta.dayHigh, 1.358, '델타에 없던 고가가 유지돼야 한다');
  assert.equal(delta.dayLow, 1.31);
});

test('Bybit 소켓: 티커가 아닌 메시지는 무시한다', () => {
  const cache = new Map();
  assert.equal(bybit.mergeSocketMessage(cache, { op: 'pong', success: true }), null);
  assert.equal(bybit.mergeSocketMessage(cache, { topic: 'orderbook.1.XRPUSDT', data: {} }), null);
});

// ── 빗썸 (업비트 프로토콜 공유) ──────────────────────────────

test('빗썸: 업비트와 같은 파서를 쓰지만 환율은 제공하지 않는다', () => {
  const ticker = bithumb.parseTicker({ ...UPBIT_TICKER, market: 'KRW-ETH' });

  assert.equal(ticker.exchange, 'bithumb', '거래소 id 가 섞이면 안 된다');
  assert.equal(ticker.coin, 'ETH');
  assert.equal(bithumb.quote, 'KRW');
  assert.equal(bithumb.providesFx, undefined || false);
  assert.ok(!bithumb.providesFx);
});

test('빗썸: 일봉 경계가 업비트와 다르다는 사실을 note 로 남긴다', () => {
  assert.match(upbit.note, /09:00/);
  assert.match(bithumb.note, /00:00/);
});

// ── 코인원 ───────────────────────────────────────────────────

const COINONE_TICKER = {
  quote_currency: 'krw',
  target_currency: 'btc',
  high: '107090000.0',
  low: '104890000.0',
  first: '106590000.0',
  last: '106150000.0',
  quote_volume: '9767035260.0724',
  target_volume: '92.09790301',
};

const COINONE_CHART = {
  result: 'success',
  chart: [
    { timestamp: 1788397200000, open: '105970000.0', high: '106010000.0', low: '105900000.0', close: '106010000.0', target_volume: '0.32946747' },
    { timestamp: 1788393600000, open: '106360000.0', high: '106440000.0', low: '105830000.0', close: '105990000.0', target_volume: '1.96110867' },
  ],
};

test('코인원 티커: 변동액·변동률을 first 로 직접 만든다', () => {
  const ticker = coinone.parseTicker(COINONE_TICKER);

  assert.equal(ticker.exchange, 'coinone');
  assert.equal(ticker.coin, 'BTC', '소문자 target_currency 를 대문자로');
  assert.equal(ticker.price, 106_150_000);
  assert.equal(ticker.changePrice, -440_000);
  assert.ok(Math.abs(ticker.changeRate + 440_000 / 106_590_000) < 1e-12);
  assert.equal(ticker.direction, 'FALL');
  assert.equal(ticker.quoteVolume24h, 9_767_035_260.0724);
});

test('코인원 캔들: 최신순 응답을 뒤집고 밀리초 타임스탬프를 쓴다', () => {
  const candles = coinone.parseCandles(COINONE_CHART);

  assert.equal(candles.length, 2);
  assert.ok(candles[0].time < candles[1].time);
  assert.equal(candles[1].open, 105_970_000);
  assert.equal(candles[1].volume, 0.32946747);
});

// ── 코인베이스 ───────────────────────────────────────────────

const COINBASE_STATS = {
  stats_24hour: {
    open: '76965.73',
    high: '77750',
    low: '76219.18',
    last: '77069.02',
    volume: '4746.03020671',
  },
};

const COINBASE_SOCKET = {
  type: 'ticker',
  product_id: 'XRP-USD',
  price: '1.3477',
  open_24h: '1.3339',
  volume_24h: '89886330.56943100',
  low_24h: '1.3093',
  high_24h: '1.3578',
};

// [시각(초), 저가, 고가, 시가, 종가, 거래량] — o,h,l,c 순서가 아니다
const COINBASE_CANDLES = [
  [1788397200, 76929.29, 77118.92, 77026.99, 77082.11, 10],
  [1788393600, 76945.79, 77364, 77307.36, 77026.98, 20],
];

test('코인베이스 통계: 24시간 시가로 변동을 만들고 거래대금을 달러로 환산한다', () => {
  const ticker = coinbase.parseStats('BTC-USD', COINBASE_STATS);

  assert.equal(ticker.exchange, 'coinbase');
  assert.equal(ticker.coin, 'BTC');
  assert.equal(ticker.price, 77069.02);
  assert.ok(Math.abs(ticker.changePrice - 103.29) < 1e-9);
  assert.equal(ticker.direction, 'RISE');
  // volume 은 기준 자산 수량이므로 가격을 곱해야 다른 거래소와 비교된다.
  assert.ok(Math.abs(ticker.quoteVolume24h - 4746.03020671 * 77069.02) < 1e-6);
});

test('코인베이스 소켓: 필드 이름이 통계와 다르지만 같은 형태를 낸다', () => {
  const ticker = coinbase.parseSocketTicker(COINBASE_SOCKET);

  assert.equal(ticker.coin, 'XRP');
  assert.equal(ticker.price, 1.3477);
  assert.equal(ticker.dayHigh, 1.3578);
  assert.equal(ticker.direction, 'RISE');
});

test('코인베이스 캔들: [시각, 저가, 고가, 시가, 종가] 순서를 올바르게 읽는다', () => {
  const candles = coinbase.parseCandles(COINBASE_CANDLES);

  assert.equal(candles.length, 2);
  assert.ok(candles[0].time < candles[1].time, '최신순 응답을 뒤집는다');

  const last = candles[1];
  // 순서를 o,h,l,c 로 잘못 읽으면 open 77026.99 대신 76929.29 가 들어간다.
  assert.equal(last.open, 77026.99, '시가는 네 번째 값이다');
  assert.equal(last.low, 76929.29, '저가는 두 번째 값이다');
  assert.equal(last.high, 77118.92);
  assert.equal(last.close, 77082.11);
  assert.ok(last.high >= last.open && last.open >= last.low, '고저 범위 정합성');
});

// ── 크라켄 ───────────────────────────────────────────────────

const KRAKEN_TICKER = {
  c: ['77075.20000', '0.00011540'],
  o: '76965.70000',
  h: ['77300.00000', '77750.00000'],
  l: ['76900.00000', '76219.00000'],
  v: ['1000.0', '4746.0'],
  p: ['77000.0', '77100.0'],
};

const KRAKEN_OHLC = {
  error: [],
  result: {
    XXBTZUSD: [
      [1788307200, '76219.18', '77750.00', '76100.00', '77307.36', '77000.0', '4983.63', 32440],
      [1788393600, '77307.36', '77364.00', '76945.79', '77026.98', '77100.0', '193.40', 3244],
    ],
    last: 1788393600,
  },
};

test('크라켄 심볼: 비트코인은 BTC 가 아니라 XBT 다', () => {
  assert.equal(kraken.symbolOf('BTC'), 'XBTUSD');
  assert.equal(kraken.symbolOf('XRP'), 'XRPUSD');
  assert.equal(kraken.symbolOf('ETH'), 'ETHUSD');
  // 소켓 v2 는 또 다른 표기를 쓴다.
  assert.equal(kraken.socketSymbolOf('BTC'), 'BTC/USD');
});

test('크라켄: 정규화된 응답 키에서 종목을 되찾는다', () => {
  const coins = ['BTC', 'XRP', 'ETH'];
  assert.equal(kraken.coinOfPairKey('XXBTZUSD', coins), 'BTC');
  assert.equal(kraken.coinOfPairKey('XXRPZUSD', coins), 'XRP');
  assert.equal(kraken.coinOfPairKey('XETHZUSD', coins), 'ETH');
  assert.equal(kraken.coinOfPairKey('SOLUSD', coins), null);
});

test('크라켄 티커: 한 글자 필드에서 24시간 값을 골라 쓴다', () => {
  const ticker = kraken.parseRestTicker(KRAKEN_TICKER, 'BTC');

  assert.equal(ticker.price, 77075.2, 'c[0] 이 마지막 체결가다');
  assert.ok(Math.abs(ticker.changePrice - 109.5) < 1e-9, 'o 는 당일 시가다');
  assert.equal(ticker.dayHigh, 77750, 'h[1] 이 24시간 고가다');
  assert.equal(ticker.dayLow, 76219, 'l[1] 이 24시간 저가다');
  // 거래대금을 주지 않으므로 거래량 × VWAP 로 환산한다.
  assert.ok(Math.abs(ticker.quoteVolume24h - 4746 * 77100) < 1e-6);
});

test('크라켄 캔들: result 의 last 키를 캔들로 오해하지 않는다', () => {
  const candles = kraken.parseCandles(KRAKEN_OHLC);

  assert.equal(candles.length, 2);
  assert.ok(candles[0].time < candles[1].time);
  assert.equal(candles[1].open, 77307.36);
  assert.equal(candles[1].volume, 193.4, '거래량은 일곱 번째 값이다');
});

test('크라켄 캔들: 응답이 비어도 예외를 던지지 않는다', () => {
  assert.deepEqual(kraken.parseCandles({ result: { last: 1 } }), []);
  assert.deepEqual(kraken.parseCandles({}), []);
});

// ── 실응답 스모크 ────────────────────────────────────────────

async function online() {
  try {
    const response = await fetch('https://api.upbit.com/v1/market/all', {
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const skip = (await online()) ? false : '거래소에 연결할 수 없어 건너뜀';

for (const exchange of EXCHANGES) {
  test(`${exchange.name}: 실제 티커에 필수 필드가 채워진다`, { skip }, async () => {
    const tickers = await exchange.fetchTickers(COINS.map((c) => c.id));
    const found = new Set(tickers.map((t) => t.coin));

    for (const coin of COINS) {
      assert.ok(found.has(coin.id), `${coin.id} 가 응답에 없다`);
    }
    for (const ticker of tickers) {
      assert.ok(Number.isFinite(ticker.price) && ticker.price > 0, `${ticker.coin} 현재가`);
      assert.ok(Number.isFinite(ticker.changeRate), `${ticker.coin} 변동률`);
      assert.ok(['RISE', 'FALL', 'EVEN'].includes(ticker.direction), `${ticker.coin} 방향`);
    }
  });

  test(`${exchange.name}: 실제 캔들이 오래된→최신 순이다`, { skip }, async () => {
    for (const timeframe of TIMEFRAMES) {
      const candles = await exchange.fetchCandles('BTC', timeframe.key, 60);
      assert.ok(candles.length > 50, `${timeframe.label} 봉 수가 ${candles.length}개뿐이다`);

      for (let i = 1; i < candles.length; i += 1) {
        assert.ok(
          candles[i].time > candles[i - 1].time,
          `${timeframe.label} ${i}번째 봉의 시각이 앞 봉보다 빠르다`,
        );
      }
      const last = candles.at(-1);
      assert.ok(last.high >= last.low, `${timeframe.label} 고가 >= 저가`);
      assert.ok(last.high >= last.close && last.close >= last.low, `${timeframe.label} 종가 범위`);
    }
  });
}

test('업비트: 김치 프리미엄 기준 환율(KRW-USDT)이 함께 온다', { skip }, async () => {
  const tickers = await upbit.fetchTickers(COINS.map((c) => c.id));
  const usdt = tickers.find((t) => t.coin === 'USDT');

  assert.ok(usdt, 'KRW-USDT 가 응답에 없다');
  assert.ok(usdt.price > 500 && usdt.price < 5000, `환율이 비상식적이다: ${usdt.price}`);
});

test('MAX_COINS: 갱신 주기를 넘지 않는 상한을 유지한다', () => {
  // 거래소 7 × 종목 N × 주기 3 을 30초마다 돈다. 크라켄 간격 600ms 기준
  // N=6 이면 한 바퀴 10.8초로 여유가 있고, 그 이상은 갱신이 밀린다.
  const krakenRoundTripMs = MAX_COINS * TIMEFRAMES.length * 600;
  assert.ok(krakenRoundTripMs < 30_000, `크라켄 한 바퀴 ${krakenRoundTripMs}ms`);
  assert.equal(MAX_COINS, 6);
});
