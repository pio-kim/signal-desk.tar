/**
 * 거래소 레지스트리. 화면과 집계 계층은 이 목록만 보고 동작하므로
 * 거래소를 추가·제거할 때 여기와 어댑터 파일만 건드리면 된다.
 *
 * 순서는 화면 표시 순서다. 원화 마켓을 앞에, 견적 통화별로 묶었다.
 */

import * as upbit from './upbit.js';
import * as bithumb from './bithumb.js';
import * as coinone from './coinone.js';
import * as binance from './binance.js';
import * as bybit from './bybit.js';
import * as coinbase from './coinbase.js';
import * as kraken from './kraken.js';

export const EXCHANGES = [upbit, bithumb, coinone, binance, bybit, coinbase, kraken];

export const exchangeOf = (id) => EXCHANGES.find((exchange) => exchange.id === id);

/** 김치 프리미엄의 기준 환율을 제공하는 거래소(업비트) */
export const fxExchange = EXCHANGES.find((exchange) => exchange.providesFx);

export { upbit, bithumb, coinone, binance, bybit, coinbase, kraken };
