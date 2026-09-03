import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CATEGORY_HELP,
  GREED_COMPONENT_HELP,
  GREED_HELP,
  INDICATOR_HELP,
  SCREEN_HELP,
  TIMEFRAME_HELP,
  allHelpRefs,
  helpRef,
} from '../js/glossary.js';
import { CATEGORIES, SENTIMENT_LABELS, TIMEFRAMES } from '../js/config.js';

const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

// ── 사전이 화면의 모든 지표를 덮는가 ────────────────────────

test('설명이 없는 지표가 없다', () => {
  for (const category of CATEGORIES) {
    for (const key of category.indicators) {
      assert.ok(INDICATOR_HELP[key], `${category.label}의 ${key} 설명이 없습니다`);
    }
  }
});

test('설명이 없는 카테고리가 없다', () => {
  for (const category of CATEGORIES) {
    assert.ok(CATEGORY_HELP[category.key], `${category.key} 카테고리 설명이 없습니다`);
  }
});

test('설명이 없는 봉 주기가 없다', () => {
  for (const timeframe of TIMEFRAMES) {
    assert.ok(TIMEFRAME_HELP[timeframe.key], `${timeframe.key} 주기 설명이 없습니다`);
  }
});

/*
 * 종목별 탐욕지수 성분은 greed.js 의 COMPONENT_META 가 원본이다. 그 표는 export
 * 되지 않으므로 소스에서 키를 뽑아 대조한다 — 성분을 늘렸는데 설명을 빠뜨리는
 * 것을 잡기 위해서다.
 */
test('설명이 없는 탐욕지수 성분이 없다', () => {
  const source = readFileSync(new URL('../js/greed.js', import.meta.url), 'utf8');
  const meta = source.slice(source.indexOf('const COMPONENT_META'));
  const keys = [...meta.matchAll(/key: '([a-z]+)'/g)].map((match) => match[1]);

  assert.ok(keys.length >= 5, '성분 키를 읽지 못했습니다');
  for (const key of keys) {
    assert.ok(GREED_COMPONENT_HELP[key], `탐욕지수 ${key} 성분 설명이 없습니다`);
  }
});

test('사전에 남아도는 항목이 없다', () => {
  const used = new Set([
    ...CATEGORIES.flatMap((category) => category.indicators),
    ...Object.keys(SENTIMENT_LABELS),
  ]);
  for (const key of Object.keys(INDICATOR_HELP)) {
    assert.ok(used.has(key), `${key} 는 화면에서 쓰이지 않는 지표입니다`);
  }
});

// ── 항목의 모양 ─────────────────────────────────────────────

test('모든 항목에 제목과 설명이 있다', () => {
  for (const ref of allHelpRefs()) {
    const help = helpRef(ref);
    assert.ok(help.title?.length, `${ref} 에 제목이 없습니다`);
    assert.ok(help.what?.length, `${ref} 에 설명이 없습니다`);
  }
});

/*
 * 판정 기준표는 [조건, 판정] 두 칸이다. 세 칸짜리를 섞으면 dl 렌더가 조용히
 * 한 칸을 버린다 — 화면에서는 그냥 항목이 빠진 것처럼 보인다.
 */
test('판정 기준표는 두 칸짜리 행으로만 이뤄진다', () => {
  for (const ref of allHelpRefs()) {
    const { scale } = helpRef(ref);
    if (!scale) continue;
    for (const row of scale) {
      assert.equal(row.length, 2, `${ref} 의 기준표 행 칸 수가 2가 아닙니다`);
      assert.ok(row[0]?.length && row[1]?.length, `${ref} 의 기준표에 빈 칸이 있습니다`);
    }
  }
});

test('점수 표기는 화면과 같은 빼기 기호를 쓴다', () => {
  // ASCII 하이픈은 폭이 달라 고정폭 표가 흔들린다. 화면 다른 곳과 맞춘다.
  for (const ref of allHelpRefs()) {
    const help = helpRef(ref);
    const text = [help.note ?? '', help.caveat ?? '', ...(help.scale ?? []).flat()].join(' ');
    assert.equal(/-\d/.test(text), false, `${ref} 에 ASCII 하이픈 음수가 있습니다`);
  }
});

test('helpRef 는 없는 참조에 null 을 준다', () => {
  assert.equal(helpRef('ind:nope'), null);
  assert.equal(helpRef('nope:rsi'), null);
  assert.equal(helpRef(''), null);
  assert.equal(helpRef(null), null);
});

test('시장 탐욕지수 칩은 공포탐욕지수 설명을 그대로 쓴다', () => {
  // 두 곳에 따로 적으면 한쪽만 고쳐져 설명이 갈린다.
  assert.equal(GREED_HELP.market, INDICATOR_HELP.fearGreed);
});

// ── 화면 배선 ───────────────────────────────────────────────

/*
 * 사전에만 있고 화면에 안 붙은 항목은 아무 데서도 보이지 않는다. app.js 가
 * attachHelp 를 부를 때 쓰는 참조 문자열을 뽑아, 사전의 모든 맵이 실제로
 * 쓰이는지 확인한다. 템플릿 리터럴(`ind:${...}`)은 접두사만 남긴다.
 */
test('사전의 모든 맵이 화면에 배선돼 있다', () => {
  const wired = new Set(
    [...app.matchAll(/attachHelp\([^,]+,\s*[`']([a-z]+):/g)].map((match) => match[1]),
  );
  for (const map of ['ind', 'cat', 'tf', 'greed', 'gc', 'screen']) {
    assert.ok(wired.has(map), `${map} 맵이 app.js 어디에도 붙어 있지 않습니다`);
  }
});

test('SCREEN_HELP 의 항목은 저마다 화면에 붙어 있다', () => {
  for (const key of Object.keys(SCREEN_HELP)) {
    assert.ok(app.includes(`'screen:${key}'`), `screen:${key} 가 화면에 붙어 있지 않습니다`);
  }
});

/*
 * 같은 자리에 툴팁과 브라우저 기본 title 이 함께 있으면 설명이 두 번 뜬다.
 * attachHelp 로 옮긴 자리에 title 을 되살리지 않았는지 확인한다.
 */
test('설명을 옮긴 자리에 title 속성이 남아 있지 않다', () => {
  for (const gone of ['badge.title', 'breakdown.title', 'market.title', 'own.title']) {
    assert.equal(app.includes(gone), false, `${gone} 이 남아 있습니다`);
  }
});
