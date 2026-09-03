/**
 * 실시간 수급 테스트 — 호가 불균형과 체결강도.
 * 시간 의존 로직이므로 현재 시각을 주입해 결정적으로 검증한다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFlowTracker,
  tradesInWindow,
  scoreOrderbook,
  scoreTaker,
  takerStrength,
} from '../js/flow.js';
import { flowCategory } from '../js/config.js';

// ── 호가 불균형 ──────────────────────────────────────────────

test('scoreOrderbook: 매수 잔량이 많으면 양수, 매도가 많으면 음수', () => {
  assert.ok(scoreOrderbook(0.1).score > 0);
  assert.ok(scoreOrderbook(-0.1).score < 0);
  assert.equal(scoreOrderbook(0).score, 0);
});

test('scoreOrderbook: 불균형 ±0.3 에서 포화한다', () => {
  // 잔량 비율은 이론상 ±1 까지 가능하지만 실전에서 ±0.3 이면 이미 극단이다.
  assert.equal(scoreOrderbook(0.3).score, 100);
  assert.equal(scoreOrderbook(0.9).score, 100, '0.3 을 넘겨도 같은 값');
  assert.equal(scoreOrderbook(-0.3).score, -100);
  assert.equal(scoreOrderbook(0.15).score, 50);
});

test('scoreOrderbook: 값이 없으면 null', () => {
  assert.equal(scoreOrderbook(null), null);
  assert.equal(scoreOrderbook(undefined), null);
});

// ── 체결강도 ────────────────────────────────────────────────

/** 표본 요건을 채우는 체결 목록. 비율은 bid:ask 로 유지한다. */
function tradesOf(bidCount, askCount, at = 1000) {
  return [
    ...Array.from({ length: bidCount }, () => ({ at, side: 'BID', volume: 1 })),
    ...Array.from({ length: askCount }, () => ({ at, side: 'ASK', volume: 1 })),
  ];
}

test('takerStrength: 매수 체결량 ÷ 매도 체결량 × 100', () => {
  assert.equal(takerStrength(tradesOf(9, 3), 2000, 60_000), 300);
});

test('takerStrength: 표본이 부족하면 비율을 믿지 않는다', () => {
  // 60초에 체결 세 건이면 3배든 0.3배든 우연이다.
  assert.equal(takerStrength(tradesOf(2, 1), 2000, 60_000), null);
  assert.equal(takerStrength(tradesOf(7, 3), 2000, 60_000), 233.3, '10건이면 판정한다');
});

test('takerStrength: 균형이면 100', () => {
  assert.equal(takerStrength(tradesOf(6, 6), 2000, 60_000), 100);
});

test('takerStrength: 윈도우를 벗어난 체결은 세지 않는다', () => {
  const trades = [
    { at: 1000, side: 'ASK', volume: 100 }, // 오래된 매도 — 제외돼야 한다
    ...tradesOf(6, 6, 90_000),
  ];
  // 윈도우 60초 기준 now=100_000 이면 40_000 이전 체결은 버린다
  assert.equal(takerStrength(trades, 100_000, 60_000), 100);
});

test('takerStrength: 매도 체결이 하나도 없으면 상한을 씌운다', () => {
  // 0 으로 나누면 Infinity 가 화면까지 번진다. 표본은 충분한 경우다.
  assert.equal(takerStrength(tradesOf(12, 0), 2000, 60_000), 999);
});

test('takerStrength: 윈도우 안에 체결이 없으면 null', () => {
  assert.equal(takerStrength([], 1000, 60_000), null);
  assert.equal(takerStrength(tradesOf(12, 12, 1), 100_000, 60_000), null, '전부 윈도우 밖');
});

test('scoreTaker: 100 이 균형, 140 이상이면 강한 매수', () => {
  assert.equal(scoreTaker(100).score, 0);
  assert.equal(scoreTaker(140).score, 80);
  assert.equal(scoreTaker(200).score, 80, '140 을 넘겨도 같은 값');
  assert.equal(scoreTaker(120).score, 40);
  assert.equal(scoreTaker(80).score, -40);
  assert.equal(scoreTaker(60).score, -80);
  assert.equal(scoreTaker(null), null);
});

// ── 추적기 ──────────────────────────────────────────────────

test('createFlowTracker: 호가와 체결을 종목별로 따로 모은다', () => {
  const tracker = createFlowTracker({ windowMs: 60_000 });

  tracker.applyOrderbook({ coin: 'BTC', totalBidSize: 130, totalAskSize: 70 });
  tracker.applyOrderbook({ coin: 'XRP', totalBidSize: 70, totalAskSize: 130 });
  for (let i = 0; i < 9; i += 1) tracker.applyTrade({ coin: 'BTC', side: 'BID', volume: 1, at: 1000 });
  for (let i = 0; i < 3; i += 1) tracker.applyTrade({ coin: 'BTC', side: 'ASK', volume: 1, at: 1000 });

  const btc = tracker.evaluate('BTC', 2000);
  const xrp = tracker.evaluate('XRP', 2000);

  // (130−70)/200 = 0.3 → 포화
  assert.equal(btc.imbalance, 0.3);
  assert.equal(btc.indicators.find((d) => d.key === 'orderbook').score, 100);
  assert.equal(btc.strength, 300);
  assert.equal(btc.score, 90, '(100 + 80) / 2');

  assert.equal(xrp.imbalance, -0.3);
  assert.equal(xrp.strength, null, 'XRP 는 체결이 없다');
  assert.equal(
    xrp.indicators.find((d) => d.key === 'taker').display,
    '데이터 대기',
    '체결이 아예 없으면 대기로 적는다',
  );
  assert.equal(xrp.score, -100, '체결이 없으면 호가만으로 낸다');
});

test('createFlowTracker: 데이터가 없으면 판정하지 않는다', () => {
  const tracker = createFlowTracker({ windowMs: 60_000 });
  const result = tracker.evaluate('BTC', 1000);

  assert.equal(result.score, null);
  assert.equal(result.imbalance, null);
  assert.ok(result.indicators.every((d) => !d.available));
});

test('createFlowTracker: 오래된 체결은 버려 메모리가 무한히 늘지 않는다', () => {
  const tracker = createFlowTracker({ windowMs: 10_000 });
  for (let i = 0; i < 500; i += 1) {
    tracker.applyTrade({ coin: 'BTC', side: 'BID', volume: 1, at: i * 100 });
  }
  tracker.evaluate('BTC', 50_000);
  assert.ok(tracker.tradeCount('BTC') <= 101, `보관 건수 ${tracker.tradeCount('BTC')}`);
});

test('createFlowTracker: 종목 목록이 바뀌면 남은 상태를 정리한다', () => {
  const tracker = createFlowTracker({ windowMs: 60_000 });
  tracker.applyOrderbook({ coin: 'BTC', totalBidSize: 100, totalAskSize: 100 });
  tracker.applyOrderbook({ coin: 'DOGE', totalBidSize: 100, totalAskSize: 100 });

  tracker.retain(['BTC']);

  assert.notEqual(tracker.evaluate('BTC', 1000).imbalance, null);
  assert.equal(tracker.evaluate('DOGE', 1000).imbalance, null, '빠진 종목 상태는 지운다');
});

test('flowCategory: 지시서에 정한 실시간 수급 카테고리', () => {
  const category = flowCategory();
  assert.equal(category.key, 'flow');
  assert.equal(category.weight, 1.0);
  assert.equal(category.candleBased, false);
  assert.deepEqual(category.indicators, ['orderbook', 'taker']);
});

test('createFlowTracker: 표본이 부족하면 왜 판정하지 않는지 적는다', () => {
  const tracker = createFlowTracker({ windowMs: 60_000 });
  for (let i = 0; i < 3; i += 1) {
    tracker.applyTrade({ coin: 'BTC', side: 'BID', volume: 1, at: 1000 });
  }

  const taker = tracker.evaluate('BTC', 2000).indicators.find((d) => d.key === 'taker');
  assert.equal(taker.available, false);
  assert.equal(taker.display, '체결 3건 (10건 필요)');
});

test('tradesInWindow: 윈도우 안 체결 건수만 센다', () => {
  const trades = [
    { at: 1000, side: 'BID', volume: 1 },
    { at: 95_000, side: 'BID', volume: 1 },
  ];
  assert.equal(tradesInWindow(trades, 100_000, 60_000), 1);
});
