import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION_BY_GRADE,
  NEAR_BOUNDARY,
  actionOf,
  categoryForces,
  explainForces,
  gradeGap,
  hasCandleForces,
  isNearBoundary,
  overheatNote,
  withParticle,
} from '../js/explain.js';
import { GRADES } from '../js/config.js';

// ── 조사 ────────────────────────────────────────────────────

test('withParticle: 받침 유무로 조사를 고른다', () => {
  assert.equal(withParticle('추세', '은', '는'), '추세는'); // 받침 없음
  assert.equal(withParticle('모멘텀', '은', '는'), '모멘텀은'); // ㅁ 받침
  assert.equal(withParticle('변동성', '이', '가'), '변동성이'); // ㅇ 받침
  assert.equal(withParticle('시장 심리', '이', '가'), '시장 심리가'); // 받침 없음
});

test('withParticle: 한글이 아니면 받침 있는 쪽을 쓴다', () => {
  assert.equal(withParticle('RSI', '은', '는'), 'RSI은');
  assert.equal(withParticle('', '은', '는'), '은');
});

// ── 행동 언어 ───────────────────────────────────────────────

test('actionOf: 등급마다 무엇을 하라는 말인지 붙는다', () => {
  assert.equal(actionOf(GRADES.neutral), '관망 — 방향이 갈림');
  assert.equal(actionOf(GRADES.strongBuy), '적극 매수 구간');
  // 알 수 없는 등급도 문구가 비지 않아야 한다.
  assert.equal(actionOf(null), ACTION_BY_GRADE.unknown);
  assert.equal(actionOf({ key: 'nope' }), ACTION_BY_GRADE.unknown);
});

// ── 등급 경계까지 남은 거리 ─────────────────────────────────

test('gradeGap: 매수 기준선 바로 아래를 집어낸다', () => {
  // 이 화면에서 '많이 올랐는데 왜 중립이냐'는 질문을 만든 실제 상황이다.
  const gap = gradeGap(19.9);
  assert.deepEqual(gap, { label: '매수', gap: 0.1, direction: 'up' });
  assert.equal(isNearBoundary(gap), true);
});

test('gradeGap: 0점은 경계에서 멀어 강조되지 않는다', () => {
  const gap = gradeGap(0);
  assert.equal(gap.gap, 20);
  assert.equal(isNearBoundary(gap), false);
  // 같은 거리면 매수 쪽을 먼저 잡는다.
  assert.equal(gap.label, '매수');
});

test('gradeGap: 등급을 이미 넘었으면 내려갈 경계를 가리킨다', () => {
  const gap = gradeGap(52);
  assert.equal(gap.direction, 'down');
  assert.equal(gap.gap, 2);
  // 50 아래로 내려가면 강력매수가 아니라 매수가 된다.
  assert.equal(gap.label, '매수');
});

test('gradeGap: 매도 쪽도 대칭으로 잡는다', () => {
  assert.deepEqual(gradeGap(-19.5), { label: '매도', gap: 0.5, direction: 'down' });
});

test('gradeGap: 점수가 없으면 null', () => {
  assert.equal(gradeGap(null), null);
  assert.equal(gradeGap(NaN), null);
  assert.equal(gradeGap(undefined), null);
});

test('NEAR_BOUNDARY 는 경계 강조 기준이다', () => {
  assert.equal(isNearBoundary(gradeGap(20 - NEAR_BOUNDARY)), true);
  assert.equal(isNearBoundary(gradeGap(20 - NEAR_BOUNDARY - 0.1)), false);
  assert.equal(isNearBoundary(null), false);
});

// ── 카테고리 힘 배분 ────────────────────────────────────────

/** 한 봉 주기의 카테고리 묶음을 만든다. */
const timeframe = (entries) => ({
  categories: Object.entries(entries).map(([key, [score, adjust = 1]]) => ({ key, score, adjust })),
});

/** CHIP(+31.6%) 실측을 옮긴 형태 — 추세는 강한 매수, 과매수가 맞선다. */
const overheated = {
  byExchange: {
    upbit: {
      byTimeframe: {
        day: timeframe({ trend: [63.3, 1.5], momentum: [-43.3, 0.7], volatility: [-40, 0.8], volume: [15] }),
        h4: timeframe({ trend: [63.3, 1.5], momentum: [-53.3, 0.7], volatility: [-22.5, 0.8], volume: [55] }),
        h1: timeframe({ trend: [53.3, 1.5], momentum: [-63.3, 0.7], volatility: [-20, 0.8], volume: [30] }),
      },
    },
  },
  flow: { score: 90 },
  sentiment: { score: -5 },
};

test('categoryForces: 봉 주기를 가중으로 접고 수급·심리를 얹는다', () => {
  const forces = categoryForces(overheated, 'upbit');
  const keys = forces.map((force) => force.key).sort();
  assert.deepEqual(keys, ['flow', 'momentum', 'sentiment', 'trend', 'volatility', 'volume']);

  // 추세 = 63.3×0.5 + 63.3×0.3 + 53.3×0.2 = 61.3
  const trend = forces.find((force) => force.key === 'trend');
  assert.equal(trend.score, 61.3);
  // 가중에는 ADX 국면 조정(×1.5)이 이미 반영돼 있다.
  assert.equal(trend.weight, 1.8);
  assert.equal(trend.pull, Math.round(61.3 * 1.8 * 10) / 10);
});

test('categoryForces: 당기는 힘의 절대값 순으로 정렬한다', () => {
  const forces = categoryForces(overheated, 'upbit');
  const pulls = forces.map((force) => Math.abs(force.pull));
  assert.deepEqual(pulls, [...pulls].sort((a, b) => b - a));
  // 가장 센 힘의 막대가 꽉 찬다.
  assert.equal(forces[0].ratio, 1);
  assert.ok(forces.every((force) => force.ratio > 0 && force.ratio <= 1));
});

test('categoryForces: 봉 주기가 없는 카테고리는 가중을 그대로 쓴다', () => {
  const forces = categoryForces(overheated, 'upbit');
  assert.equal(forces.find((force) => force.key === 'flow').weight, 1);
  assert.equal(forces.find((force) => force.key === 'sentiment').weight, 0.6);
});

test('categoryForces: 값이 없는 카테고리는 아예 빠진다', () => {
  const sparse = {
    byExchange: { upbit: { byTimeframe: { day: timeframe({ trend: [40], momentum: [null] }) } } },
  };
  const forces = categoryForces(sparse, 'upbit');
  assert.deepEqual(forces.map((force) => force.key), ['trend']);
});

test('categoryForces: 아무 데이터도 없으면 빈 배열', () => {
  assert.deepEqual(categoryForces(null, 'upbit'), []);
});

test('hasCandleForces: 캔들 없는 거래소를 길이로 판단하면 안 된다', () => {
  // 수급·심리는 거래소와 무관하게 계산되므로 배열이 비지 않는다.
  const kraken = categoryForces(overheated, 'kraken');
  assert.deepEqual(kraken.map((force) => force.key).sort(), ['flow', 'sentiment']);
  assert.equal(kraken.length > 0, true);
  assert.equal(hasCandleForces(kraken), false);

  assert.equal(hasCandleForces(categoryForces(overheated, 'upbit')), true);
  assert.equal(hasCandleForces([]), false);
  assert.equal(hasCandleForces(null), false);
});

// ── 한 줄 해설 ──────────────────────────────────────────────

test('explainForces: 중립이면 무엇과 무엇이 상쇄됐는지 적는다', () => {
  const forces = categoryForces(overheated, 'upbit');
  const sentence = explainForces(forces, GRADES.neutral);
  assert.match(sentence, /추세는 매수/);
  assert.match(sentence, /상쇄됐습니다/);
});

test('explainForces: 매수면 무엇이 무엇을 이겼는지 적는다', () => {
  const sentence = explainForces(categoryForces(overheated, 'upbit'), GRADES.buy);
  assert.match(sentence, /이겼습니다/);
});

test('explainForces: 매도면 방향이 뒤집힌다', () => {
  const sentence = explainForces(categoryForces(overheated, 'upbit'), GRADES.sell);
  assert.match(sentence, /눌렀습니다/);
});

test('explainForces: 한쪽뿐이면 대결로 적지 않는다', () => {
  const oneSided = {
    byExchange: { upbit: { byTimeframe: { day: timeframe({ trend: [60], volume: [40] }) } } },
  };
  const sentence = explainForces(categoryForces(oneSided, 'upbit'), GRADES.buy);
  assert.match(sentence, /모두 매수를 가리킵니다/);
  assert.doesNotMatch(sentence, /맞서|이겼|눌렀/);
});

test('explainForces: 힘이 없으면 null', () => {
  assert.equal(explainForces([], GRADES.neutral), null);
  assert.equal(explainForces(null, GRADES.neutral), null);
});

// ── 과열·과냉 주석 ──────────────────────────────────────────

test('overheatNote: 추세는 매수인데 과매수면 되돌림 위험을 알린다', () => {
  const note = overheatNote(categoryForces(overheated, 'upbit'));
  assert.equal(note.tone, 'hot');
  assert.match(note.text, /과매수/);
});

test('overheatNote: 하락 추세 + 과매도는 반대로 적는다', () => {
  const oversold = {
    byExchange: {
      upbit: { byTimeframe: { day: timeframe({ trend: [-60], momentum: [70], volatility: [40] }) } },
    },
  };
  const note = overheatNote(categoryForces(oversold, 'upbit'));
  assert.equal(note.tone, 'cold');
  assert.match(note.text, /과매도/);
});

test('overheatNote: 추세와 모멘텀이 같은 방향이면 주석이 없다', () => {
  const aligned = {
    byExchange: { upbit: { byTimeframe: { day: timeframe({ trend: [60], momentum: [50] }) } } },
  };
  assert.equal(overheatNote(categoryForces(aligned, 'upbit')), null);
});

test('overheatNote: 추세가 약하면 과열로 부르지 않는다', () => {
  const mild = {
    byExchange: { upbit: { byTimeframe: { day: timeframe({ trend: [20], momentum: [-60] }) } } },
  };
  assert.equal(overheatNote(categoryForces(mild, 'upbit')), null);
  assert.equal(overheatNote([]), null);
});
