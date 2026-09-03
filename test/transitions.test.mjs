import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTransitionLog, topContributors } from '../js/transitions.js';

const evaluation = (score, gradeKey, gradeLabel) => ({
  consensus: { score },
  grade: { key: gradeKey, label: gradeLabel },
});

test('createTransitionLog: 첫 관측은 전환이 아니다', () => {
  const log = createTransitionLog();
  const added = log.observe('BTC', evaluation(30, 'buy', '매수'), [], 1000);

  assert.equal(added, null, '이전 등급이 없으면 비교할 대상이 없다');
  assert.equal(log.entries().length, 0);
});

test('createTransitionLog: 등급이 바뀔 때만 기록한다', () => {
  const log = createTransitionLog();

  log.observe('BTC', evaluation(30, 'buy', '매수'), [], 1000);
  log.observe('BTC', evaluation(35, 'buy', '매수'), [], 2000);
  log.observe('BTC', evaluation(40, 'buy', '매수'), [], 3000);

  assert.equal(log.entries().length, 0, '점수가 움직여도 등급이 같으면 기록하지 않는다');

  const added = log.observe('BTC', evaluation(5, 'neutral', '중립'), [], 4000);
  assert.ok(added);
  assert.equal(log.entries().length, 1);

  const [record] = log.entries();
  assert.equal(record.coin, 'BTC');
  assert.equal(record.from.key, 'buy');
  assert.equal(record.to.key, 'neutral');
  assert.equal(record.score, 5);
  assert.equal(record.at, 4000);
});

test('createTransitionLog: 종목별로 따로 추적한다', () => {
  const log = createTransitionLog();

  log.observe('BTC', evaluation(30, 'buy', '매수'), [], 1000);
  log.observe('XRP', evaluation(-30, 'sell', '매도'), [], 1000);
  log.observe('XRP', evaluation(0, 'neutral', '중립'), [], 2000);

  assert.equal(log.entries().length, 1);
  assert.equal(log.entries()[0].coin, 'XRP');
});

test('createTransitionLog: 최신 기록이 앞에 오고 상한을 넘지 않는다', () => {
  const log = createTransitionLog({ limit: 3 });

  const grades = ['buy', 'neutral', 'sell', 'neutral', 'buy'];
  grades.forEach((key, i) => log.observe('BTC', evaluation(i, key, key), [], i * 1000));

  const entries = log.entries();
  assert.equal(entries.length, 3, '상한 유지');
  assert.equal(entries[0].to.key, 'buy', '가장 최근 전환이 앞');
  assert.equal(entries[0].at, 4000);
  assert.equal(entries[2].at, 2000, '오래된 기록이 밀려난다');
});

test('createTransitionLog: 판정 불가로 바뀌는 것은 전환으로 세지 않는다', () => {
  const log = createTransitionLog();

  log.observe('BTC', evaluation(30, 'buy', '매수'), [], 1000);
  log.observe('BTC', evaluation(null, 'unknown', '판정 불가'), [], 2000);

  // 연결이 끊겨 데이터가 빈 것과 시그널이 바뀐 것은 다르다.
  assert.equal(log.entries().length, 0);

  // 데이터가 돌아와 같은 등급이면 역시 전환이 아니다.
  log.observe('BTC', evaluation(32, 'buy', '매수'), [], 3000);
  assert.equal(log.entries().length, 0);
});

test('createTransitionLog: 종목이 빠지면 추적 상태도 정리한다', () => {
  const log = createTransitionLog();

  log.observe('BTC', evaluation(30, 'buy', '매수'), [], 1000);
  log.observe('DOGE', evaluation(30, 'buy', '매수'), [], 1000);
  log.retain(['BTC']);

  // DOGE 는 이전 등급이 지워졌으므로 다시 첫 관측이 된다.
  assert.equal(log.observe('DOGE', evaluation(-30, 'sell', '매도'), [], 2000), null);
  assert.ok(log.observe('BTC', evaluation(-30, 'sell', '매도'), [], 2000));
});

test('topContributors: 절대값이 큰 지표를 순서대로 고른다', () => {
  const indicators = [
    { label: 'RSI', score: -20, verdict: '강세권', available: true },
    { label: 'MACD', score: 90, verdict: '골든크로스', available: true },
    { label: '체결강도', score: -60, verdict: '매도 우위', available: true },
    { label: 'OBV', score: null, verdict: '—', available: false },
  ];

  const top = topContributors(indicators, 2);
  assert.deepEqual(
    top.map((entry) => entry.label),
    ['MACD', '체결강도'],
  );
  assert.equal(top[0].verdict, '골든크로스');
});

test('topContributors: 0점과 계산 불가 지표는 근거가 아니다', () => {
  const indicators = [
    { label: 'RSI', score: 0, verdict: '중립', available: true },
    { label: 'ATR', score: null, verdict: '—', available: false },
  ];
  assert.deepEqual(topContributors(indicators, 2), []);
});
