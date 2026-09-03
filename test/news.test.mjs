/**
 * 시장 심리 테스트 — 공포탐욕·뉴스 키워드·커뮤니티 투표·검색 관심도.
 *
 * 키워드 감성은 문맥을 오해할 수 있는 방식이므로, 오해하는 지점을 테스트로
 * 명시해 둔다. 어디까지 맞고 어디서 틀리는지가 문서 역할을 한다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  coinsMentioned,
  createSentimentTracker,
  matchKeywords,
  scoreArticle,
  scoreAttention,
  scoreFearGreed,
  scoreNews,
  scoreVotes,
} from '../js/news.js';
import { CATEGORIES } from '../js/config.js';

const coins = [
  { id: 'BTC', name: '비트코인' },
  { id: 'XRP', name: '리플' },
  { id: 'ETH', name: '이더리움' },
];

// ── 공포탐욕지수 (역추세) ────────────────────────────────────

test('scoreFearGreed: 극단적 탐욕은 매도, 극단적 공포는 매수로 읽는다', () => {
  // 이 지수는 가격 모멘텀 25% + 변동성 25% 로 만들어져 기존 지표와 성분이 겹친다.
  // 그대로 더하면 이중 계산이므로 역추세로만 쓴다.
  assert.equal(scoreFearGreed(10).score, 60, '극단적 공포');
  assert.equal(scoreFearGreed(24).score, 60);
  assert.equal(scoreFearGreed(25).score, 25, '공포');
  assert.equal(scoreFearGreed(44).score, 25);
  assert.equal(scoreFearGreed(45).score, 0, '중립');
  assert.equal(scoreFearGreed(55).score, 0);
  assert.equal(scoreFearGreed(56).score, -25, '탐욕');
  assert.equal(scoreFearGreed(74).score, -25);
  assert.equal(scoreFearGreed(75).score, -60, '극단적 탐욕');
  assert.equal(scoreFearGreed(95).score, -60);
});

test('scoreFearGreed: 값이 없으면 null', () => {
  assert.equal(scoreFearGreed(null), null);
  assert.equal(scoreFearGreed(undefined), null);
});

// ── 키워드 사전 ─────────────────────────────────────────────

test('matchKeywords: 한글과 영문을 함께 잡는다', () => {
  const korean = matchKeywords('거래소 해킹으로 자금 유출');
  assert.ok(korean.some((m) => m.word === '해킹'));
  assert.ok(korean.every((m) => m.weight < 0));

  const english = matchKeywords('SEC approves spot ETF for Bitcoin');
  assert.ok(english.some((m) => m.word === 'approve'));
  assert.ok(english.some((m) => m.weight > 0));
});

test('matchKeywords: 걸리는 단어가 없으면 빈 배열', () => {
  assert.deepEqual(matchKeywords('컨퍼런스 일정이 공개됐다'), []);
});

/**
 * 키워드 방식의 대표적 오류를 막는 처리다. '하락 우려 해소' 는 부정어 두 개가
 * 걸리지만 실제로는 긍정이다. 부정어 뒤에 해소·완화 같은 말이 오면 무효화한다.
 */
test('matchKeywords: 부정어가 해소되면 세지 않는다', () => {
  assert.deepEqual(matchKeywords('비트코인 하락 우려 해소'), []);
  assert.deepEqual(matchKeywords('규제 부담 완화'), [], '부담(−1)이 완화로 무효화된다');
  assert.deepEqual(matchKeywords('매도 압력 진정'), []);

  // 해소 표현이 멀리 떨어져 있으면 무효화하지 않는다.
  const far = matchKeywords('해킹 사고 발생, 다른 종목의 규제 부담은 완화되는 국면');
  assert.ok(
    far.some((m) => m.word === '해킹'),
    '앞쪽 부정어는 살아 있어야 한다',
  );
});

test('scoreArticle: 강한 부정 기사는 큰 음수, 강한 긍정은 큰 양수', () => {
  const bad = scoreArticle({ title: '대형 거래소 해킹, 자금 탈취 확인' });
  const good = scoreArticle({ title: '현물 ETF 승인, 기관 자금 유입 기대' });

  assert.ok(bad.score < -40, `실제 ${bad.score}`);
  assert.ok(good.score > 40, `실제 ${good.score}`);
  assert.ok(bad.matches.length >= 2);
});

test('scoreArticle: 걸리는 단어가 없으면 0점이고 중립이다', () => {
  const neutral = scoreArticle({ title: '블록체인 컨퍼런스 참가자 모집' });
  assert.equal(neutral.score, 0);
  assert.deepEqual(neutral.matches, []);
});

// ── 종목 매칭 ───────────────────────────────────────────────

test('coinsMentioned: 심볼과 한글명 어느 쪽으로도 잡는다', () => {
  assert.deepEqual(coinsMentioned('비트코인 7만 달러 돌파', coins), ['BTC']);
  assert.deepEqual(coinsMentioned('XRP 급등, 리플 소송 마무리', coins), ['XRP']);
  assert.deepEqual(coinsMentioned('ETH·BTC 동반 상승', coins), ['BTC', 'ETH']);
});

test('coinsMentioned: 언급이 없으면 시장 전체 뉴스다', () => {
  assert.deepEqual(coinsMentioned('암호화폐 시장 전반 조정 국면', coins), []);
});

test('coinsMentioned: 다른 단어에 심볼이 섞여 들어가지 않는다', () => {
  // 'ETH' 가 'ETHOS' 같은 다른 단어의 일부로 걸리면 오탐이 쏟아진다.
  assert.deepEqual(coinsMentioned('ETHOS 프로젝트 로드맵 공개', coins), []);
  assert.deepEqual(coinsMentioned('BTCUSD 선물 거래량 증가', coins), ['BTC']);
});

// ── 뉴스 심리 집계 ──────────────────────────────────────────

const article = (title, hoursAgo = 1) => ({
  title,
  source: 'TokenPost',
  at: Date.now() - hoursAgo * 3_600_000,
});

test('scoreNews: 종목 언급 기사와 시장 전체 기사를 함께 본다', () => {
  const articles = [
    article('비트코인 현물 ETF 승인'),
    article('암호화폐 시장 규제 강화 우려'),
    article('리플 소송 패소'),
  ];

  const btc = scoreNews(articles, 'BTC', coins);
  assert.ok(btc.score !== null);
  assert.ok(
    btc.articles.some((a) => a.title.includes('비트코인')),
    '종목 기사가 포함돼야 한다',
  );
  assert.ok(
    btc.articles.some((a) => a.title.includes('시장')),
    '시장 전체 기사도 참고한다',
  );
  assert.ok(
    !btc.articles.some((a) => a.title.includes('리플')),
    '다른 종목 기사는 제외한다',
  );
});

test('scoreNews: 종목 기사가 시장 기사보다 크게 반영된다', () => {
  const coinBad = scoreNews(
    [article('비트코인 해킹 피해'), article('암호화폐 시장 ETF 승인 기대')],
    'BTC',
    coins,
  );
  const marketBad = scoreNews(
    [article('비트코인 ETF 승인 기대'), article('암호화폐 시장 해킹 피해')],
    'BTC',
    coins,
  );

  assert.ok(coinBad.score < marketBad.score, '같은 단어라도 종목 기사가 더 무겁다');
});

test('scoreNews: 오래된 기사는 가중이 줄어든다', () => {
  const fresh = scoreNews([article('비트코인 해킹', 0.2)], 'BTC', coins);
  const old = scoreNews([article('비트코인 해킹', 20)], 'BTC', coins);

  assert.ok(Math.abs(fresh.score) > Math.abs(old.score), `${fresh.score} vs ${old.score}`);
});

test('scoreNews: 관련 기사가 없으면 판정하지 않는다', () => {
  const result = scoreNews([article('리플 소송')], 'BTC', coins);
  assert.equal(result.score, null);
  assert.equal(result.articles.length, 0);
});

test('scoreNews: 기사가 없으면 판정하지 않는다', () => {
  assert.equal(scoreNews([], 'BTC', coins).score, null);
  assert.equal(scoreNews(null, 'BTC', coins).score, null);
});

// ── 커뮤니티 투표 ───────────────────────────────────────────

test('scoreVotes: 50% 를 기준으로 ±30 안에서 움직인다', () => {
  assert.equal(scoreVotes(50).score, 0);
  assert.equal(scoreVotes(100).score, 30);
  assert.equal(scoreVotes(0).score, -30);
  assert.equal(scoreVotes(75).score, 15);
  assert.equal(scoreVotes(null), null);
});

// ── 검색 관심도 ─────────────────────────────────────────────

test('scoreAttention: 관심도는 방향을 모르므로 가격과 짝지어야 한다', () => {
  // ATR·거래량과 같은 원칙이다. 없는 방향을 만들어내지 않는다.
  assert.equal(scoreAttention(true, 3).score, 30, '트렌딩 + 상승');
  assert.equal(scoreAttention(true, -3).score, -30, '트렌딩 + 하락');
  assert.equal(scoreAttention(true, 0).score, 0, '방향이 없으면 0');
  assert.equal(scoreAttention(false, 5).score, 0, '트렌딩 아니면 0');
  assert.equal(scoreAttention(false, 5).verdict, '평범');
});

test('scoreAttention: 변동률을 모르면 판정하지 않는다', () => {
  assert.equal(scoreAttention(true, null), null);
});

// ── 추적기 ──────────────────────────────────────────────────

test('createSentimentTracker: 네 지표를 모아 카테고리 점수를 낸다', () => {
  const tracker = createSentimentTracker();

  tracker.applyNews([article('비트코인 현물 ETF 승인, 기관 자금 유입')]);
  tracker.applySentiment({
    fearGreed: { value: 80, label: 'Extreme Greed' },
    trending: ['BTC'],
    coins: { BTC: { up: 75, change24h: 2.5 } },
  });

  const result = tracker.evaluate('BTC', coins);

  assert.deepEqual(
    result.indicators.map((d) => d.key),
    ['fearGreed', 'news', 'votes', 'attention'],
  );
  assert.ok(result.indicators.every((d) => d.available), '네 지표 모두 계산돼야 한다');
  assert.equal(result.score, null === result.score ? null : result.score);
  assert.ok(result.score >= -100 && result.score <= 100);
  assert.ok(result.articles.length >= 1, '근거 기사를 함께 돌려준다');
});

test('createSentimentTracker: 데이터가 없으면 판정하지 않는다', () => {
  const tracker = createSentimentTracker();
  const result = tracker.evaluate('BTC', coins);

  assert.equal(result.score, null);
  assert.ok(result.indicators.every((d) => !d.available));
});

test('createSentimentTracker: 공포탐욕만 있어도 그것만으로 점수를 낸다', () => {
  const tracker = createSentimentTracker();
  tracker.applySentiment({ fearGreed: { value: 80 }, trending: [], coins: {} });

  const result = tracker.evaluate('BTC', coins);
  assert.equal(result.score, -60, '지수 하나만으로 카테고리 점수를 만든다');
});

test('시장 심리 카테고리가 설정에 정의돼 있다', () => {
  const category = CATEGORIES.find((c) => c.key === 'sentiment');
  assert.ok(category, 'CATEGORIES 에 sentiment 가 있어야 한다');
  assert.equal(category.weight, 0.6, '지연·노이즈가 많아 가중을 낮게 둔다');
  assert.equal(category.candleBased, false);
  assert.deepEqual(category.indicators, ['fearGreed', 'news', 'votes', 'attention']);
});

/*
 * 실측으로 잡은 결함이다. 긴 표현을 먼저 검사하지 않으면 짧은 단어가 겹쳐 걸려
 * 뜻이 뒤집힌다. 두 사례 모두 잘못된 방향으로 크게 벗어나는 종류다.
 */
test('matchKeywords: 긴 표현이 짧은 단어를 덮는다', () => {
  const delist = matchKeywords('거래소 상장폐지 결정');
  assert.deepEqual(
    delist.map((m) => m.word),
    ['상장폐지'],
    '상장폐지와 상장이 함께 걸리면 −3 과 +3 이 상쇄돼 0점이 된다',
  );
  assert.ok(scoreArticle({ title: '거래소 상장폐지 결정' }).score < -40);
});

test('matchKeywords: 청산은 방향을 구분한다', () => {
  // 숏 청산은 숏스퀴즈로 상승 신호다. 일반 '청산' 으로 읽으면 반대가 된다.
  const shortLiq = matchKeywords('BTC 숏 청산 늘며 방향 전환 시도');
  assert.ok(
    shortLiq.some((m) => m.word === '숏 청산' && m.weight > 0),
    `실제 ${JSON.stringify(shortLiq)}`,
  );
  assert.ok(scoreArticle({ title: 'BTC 숏 청산 급증' }).score > 0);

  const longLiq = matchKeywords('롱 청산 물량 쏟아짐');
  assert.ok(longLiq.some((m) => m.word === '롱 청산' && m.weight < 0));
});

test('matchKeywords: 결과는 제목에 나타난 순서다', () => {
  const matches = matchKeywords('규제 우려에 급락');
  assert.deepEqual(
    matches.map((m) => m.word),
    ['우려', '급락'],
  );
});

test('matchKeywords: 국면이 끝났다는 표현도 무효화한다', () => {
  // 실제 헤드라인에서 잡은 오독이다. '약세장 끝났다' 는 긍정 기사다.
  assert.deepEqual(matchKeywords('비트코인 약세장 끝났다…연말 10만 달러 가능'), []);
  assert.deepEqual(matchKeywords('규제 조사 종료'), []);
  assert.ok(scoreArticle({ title: '비트코인 약세장 끝났다' }).score === 0);
});
