/**
 * 감시 종목 관리 — 업비트 KRW 마켓 기준.
 *
 * 업비트를 기준으로 삼는 이유는 원화 마켓이 사용자의 실제 거래 대상이고,
 * 종목 코드가 `KRW-BTC` 처럼 자산명을 그대로 담아 다른 거래소 심볼로 옮기기
 * 쉽기 때문이다. 해외 거래소에 없는 알트코인은 그 거래소만 판정에서 빠진다.
 */

import { DEFAULT_COINS, MAX_COINS } from './config.js';
import { getJson } from './exchanges/shared.js';

const STORAGE_KEY = 'signal-desk.coins';

/** 목록 조회는 페이지당 한 번이면 충분하다. 상장·폐지는 그보다 훨씬 드물다. */
let catalogCache = null;

/**
 * 업비트 KRW 마켓 전체.
 * @returns {Promise<Array<{id, name, code, warning}>>}
 */
export async function fetchCatalog() {
  if (catalogCache) return catalogCache;

  const raw = await getJson('https://api.upbit.com/v1/market/all?isDetails=true', {
    exchange: '업비트',
  });

  catalogCache = raw
    .filter((market) => market.market.startsWith('KRW-'))
    .map((market) => ({
      id: market.market.replace('KRW-', ''),
      name: market.korean_name,
      code: market.market,
      // 업비트가 투자주의를 붙인 종목. 화면에 그대로 드러내야 한다.
      warning: Boolean(market.market_event?.warning),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));

  return catalogCache;
}

/** 한글명·심볼 어느 쪽으로도 찾을 수 있게 한다. */
export function searchCatalog(catalog, query) {
  const term = query.trim().toLowerCase();
  if (!term) return catalog;

  return catalog.filter(
    (market) => market.id.toLowerCase().includes(term) || market.name.toLowerCase().includes(term),
  );
}

function readStorage() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch {
    // 저장 형식이 깨졌으면 기본값으로 돌아간다. 화면이 뜨는 것이 우선이다.
    return null;
  }
}

function writeStorage(coins) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(coins));
  } catch {
    // 사생활 보호 모드 등에서 저장이 막혀도 동작 자체는 계속돼야 한다.
  }
}

/**
 * 선택된 종목 목록을 들고 있는다. 저장은 부수 효과로 처리하고, 목록 자체는
 * 언제나 `{id, name}` 배열이라는 한 가지 형태만 노출한다.
 */
export function createSelection({ max = MAX_COINS } = {}) {
  let coins = readStorage() ?? DEFAULT_COINS.map(({ id, name }) => ({ id, name }));

  const persist = () => writeStorage(coins);

  return {
    list() {
      return coins;
    },

    ids() {
      return coins.map((coin) => coin.id);
    },

    has(id) {
      return coins.some((coin) => coin.id === id);
    },

    isFull() {
      return coins.length >= max;
    },

    max,

    /** @returns {{ok: boolean, reason?: string}} */
    add(market) {
      if (this.has(market.id)) return { ok: false, reason: '이미 담긴 종목입니다' };
      if (this.isFull()) return { ok: false, reason: `최대 ${max}종목까지 볼 수 있습니다` };

      coins = [...coins, { id: market.id, name: market.name }];
      persist();
      return { ok: true };
    },

    /** 마지막 한 종목은 지우지 않는다. 빈 화면은 고장으로 보인다. */
    remove(id) {
      if (coins.length <= 1) return { ok: false, reason: '최소 한 종목은 남겨야 합니다' };

      coins = coins.filter((coin) => coin.id !== id);
      persist();
      return { ok: true };
    },

    reset() {
      coins = DEFAULT_COINS.map(({ id, name }) => ({ id, name }));
      persist();
    },
  };
}
