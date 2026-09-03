/**
 * 시장 심리 — 공포탐욕지수 · 뉴스 키워드 · 커뮤니티 투표 · 검색 관심도.
 *
 * 뉴스 RSS 는 어느 매체도 CORS 를 열어주지 않아 브라우저에서 직접 읽을 수 없다.
 * `serve.py` 가 그 한 가지 구멍만 메우고, 이 모듈은 받아온 결과를 판정한다.
 * 두 엔드포인트가 없어도(순수 정적 서버로 띄운 경우) 이 카테고리만 빠지고
 * 나머지 화면은 그대로 동작해야 한다.
 *
 * 키워드 감성의 한계를 분명히 해 둔다. 브라우저에서 LLM 을 돌릴 수 없으므로
 * 사전 기반이고, 사전은 문맥을 오해한다. 그래서 (1) 가중을 0.6 으로 낮게 두고
 * (2) 부정 해소 표현을 처리하고 (3) 매칭된 헤드라인을 화면에 그대로 보여준다.
 * 사용자가 직접 판단할 수 있어야 한다.
 */

import { SENTIMENT_LABELS, sentimentCategory } from './config.js';

const present = (value) => value !== null && value !== undefined && Number.isFinite(value);

const round1 = (value) => Math.round(value * 10) / 10;

/** 최근 몇 시간까지의 기사를 볼지. 그보다 오래된 뉴스는 이미 가격에 있다. */
const NEWS_WINDOW_HOURS = 24;

/** 종목 언급 기사와 시장 전체 기사의 가중. 종목 기사가 더 직접적이다. */
const COIN_WEIGHT = 1;
const MARKET_WEIGHT = 0.4;

// ── 공포탐욕지수 ────────────────────────────────────────────

/**
 * 역추세로만 쓴다.
 *
 * 이 지수는 BTC 가격 모멘텀 25% + 변동성 25% 로 구성돼 이 화면의 추세·변동성
 * 지표와 성분이 절반 겹친다. 그대로 방향 신호로 더하면 같은 정보를 두 번 세는
 * 셈이다. 반면 '산다 탐욕은 과열 경고' 로 쓰면 중복이 아니라 역발상 지표가 된다.
 */
export function scoreFearGreed(value) {
  if (!present(value)) return null;

  let score;
  let verdict;
  if (value < 25) [score, verdict] = [60, '극단적 공포 · 저가 기회'];
  else if (value < 45) [score, verdict] = [25, '공포'];
  else if (value <= 55) [score, verdict] = [0, '중립'];
  else if (value < 75) [score, verdict] = [-25, '탐욕'];
  else [score, verdict] = [-60, '극단적 탐욕 · 과열 주의'];

  return { score, verdict, display: `${Math.round(value)}` };
}

// ── 키워드 사전 ─────────────────────────────────────────────

/**
 * 가중은 −3~+3 이다. 절대값이 큰 쪽이 시장을 크게 움직이는 사건이다.
 * 한글과 영문을 같은 표에 두어 매체 언어와 무관하게 동작한다.
 */
const LEXICON = [
  // 강한 부정
  ['해킹', -3], ['탈취', -3], ['유출', -3], ['파산', -3], ['상장폐지', -3], ['상장 폐지', -3],
  ['거래정지', -3], ['압수', -3], ['먹튀', -3], ['러그풀', -3], ['디페깅', -3], ['폭락', -3],
  ['hack', -3], ['exploit', -3], ['stolen', -3], ['bankrupt', -3], ['delist', -3],
  ['seiz', -3], ['rug pull', -3], ['depeg', -3], ['collapse', -3], ['crash', -3],
  // 방향이 정해진 표현은 일반어보다 먼저 걸려야 한다. 길이순 정렬이 그것을 보장한다.
  ['숏 청산', 2], ['숏청산', 2], ['숏 스퀴즈', 2], ['숏스퀴즈', 2],
  ['short liquidation', 2], ['short squeeze', 2],
  ['롱 청산', -2], ['롱청산', -2], ['long liquidation', -2],
  // 중간 부정
  ['소송', -2], ['제재', -2], ['금지', -2], ['규제 강화', -2], ['조사', -2], ['청산', -2],
  ['급락', -2], ['투자주의', -2], ['해제 실패', -2], ['부결', -2],
  ['lawsuit', -2], ['sanction', -2], ['ban ', -2], ['crackdown', -2], ['probe', -2],
  ['liquidat', -2], ['plunge', -2], ['reject', -2],
  // 약한 부정
  ['하락', -1], ['조정', -1], ['매도', -1], ['우려', -1], ['경고', -1], ['지연', -1],
  ['부담', -1], ['약세', -1], ['이탈', -1],
  ['decline', -1], ['fall', -1], ['drop', -1], ['concern', -1], ['warn', -1],
  ['delay', -1], ['outflow', -1], ['bearish', -1],
  // 강한 긍정
  ['승인', 3], ['상장', 3], ['채택', 3], ['제도화', 3], ['신고가', 3], ['사상 최고', 3],
  ['급등', 3], ['호재', 3],
  ['approve', 3], ['approval', 3], ['listing', 3], ['adopt', 3], ['record high', 3],
  ['all-time high', 3], ['surge', 3], ['soar', 3],
  // 중간 긍정
  ['파트너십', 2], ['제휴', 2], ['투자 유치', 2], ['기관 자금', 2], ['유입', 2], ['확대', 2],
  ['partnership', 2], ['funding', 2], ['inflow', 2], ['institutional', 2], ['rally', 2],
  // 약한 긍정
  ['상승', 1], ['반등', 1], ['기대', 1], ['개선', 1], ['강세', 1], ['회복', 1],
  ['rise', 1], ['gain', 1], ['rebound', 1], ['optimis', 1], ['bullish', 1], ['recover', 1],
];

/**
 * 부정어를 무효화하는 표현. '하락 우려 해소' 같은 헤드라인이 흔하다.
 *
 * `끝났·종료·탈출` 계열은 실제 출력을 보고 추가했다 — "비트코인 약세장 끝났다" 가
 * 약세(−1)로 잡혀 부정으로 읽혔다. 헤드라인을 화면에 띄워 두지 않으면 이런
 * 오독은 영원히 드러나지 않는다.
 */
const NEGATION = [
  '해소', '완화', '진정', '축소', '극복', '벗어', '멈춰', '해제',
  '끝났', '끝나', '종료', '마감', '탈출', '중단됐',
  'eases', 'eased', 'resolv', 'over', 'ends', 'ended',
];

/** 부정어 뒤 이 글자 수 안에 해소 표현이 오면 무효로 본다. */
const NEGATION_WINDOW = 12;

/*
 * 긴 표현을 먼저 검사한다. 그러지 않으면 짧은 단어가 겹쳐 걸려 뜻이 뒤집힌다 —
 * `상장폐지`(−3)와 `상장`(+3)이 같은 글자에 동시에 매칭되어 최악의 뉴스가 0점이
 * 되는 것을 실측으로 확인했다. `숏 청산`(+2) 역시 일반 `청산`(−2)보다 먼저
 * 걸려야 숏스퀴즈를 하락으로 오독하지 않는다.
 */
const ORDERED_LEXICON = [...LEXICON].sort((a, b) => b[0].length - a[0].length);

/**
 * @returns {Array<{word: string, weight: number}>} 제목에 나타난 순서대로
 */
export function matchKeywords(title) {
  const text = String(title ?? '').toLowerCase();
  // 이미 더 긴 표현이 차지한 글자 구간을 표시해 중복 매칭을 막는다.
  const consumed = new Array(text.length).fill(false);
  const matches = [];

  for (const [word, weight] of ORDERED_LEXICON) {
    const needle = word.toLowerCase();
    let from = 0;
    let at = text.indexOf(needle, from);

    while (at !== -1) {
      const overlaps = consumed.slice(at, at + needle.length).some(Boolean);
      if (!overlaps) break;
      from = at + 1;
      at = text.indexOf(needle, from);
    }
    if (at === -1) continue;

    for (let i = at; i < at + needle.length; i += 1) consumed[i] = true;

    if (weight < 0) {
      // 부정어 바로 뒤에 해소 표현이 오면 뜻이 뒤집힌다.
      const tail = text.slice(at + needle.length, at + needle.length + NEGATION_WINDOW);
      if (NEGATION.some((n) => tail.includes(n.toLowerCase()))) continue;
    }

    matches.push({ word, weight, at });
  }

  return matches.sort((a, b) => a.at - b.at).map(({ word, weight }) => ({ word, weight }));
}

/** 기사 하나의 점수. 가중 합을 −100~100 으로 눌러 담는다. */
export function scoreArticle(article) {
  const matches = matchKeywords(article?.title);
  const sum = matches.reduce((total, match) => total + match.weight, 0);
  // 가중 3짜리 한 건이면 이미 큰 사건이므로 그 지점에서 포화시킨다.
  const score = Math.max(-100, Math.min(100, Math.round((sum / 3) * 60)));
  return { score, matches };
}

// ── 종목 매칭 ───────────────────────────────────────────────

/** 심볼 뒤에 붙어도 같은 종목을 뜻하는 견적 접미사. BTCUSD·ETHKRW 등. */
const QUOTE_SUFFIXES = ['USDT', 'USDC', 'USD', 'KRW', 'PERP', 'BUSD'];

/**
 * 제목에 언급된 종목.
 *
 * 심볼은 단어 경계를 확인해야 한다 — `ETH` 가 `ETHOS` 의 일부로 걸리면 오탐이
 * 쏟아진다. 다만 `BTCUSD` 처럼 견적 통화가 붙은 표기는 같은 종목을 뜻하므로
 * 알려진 접미사만 예외로 허용한다. 접미사를 열어 두지 않으면 오탐을 막는 대신
 * 정탐도 함께 놓친다.
 */
export function coinsMentioned(title, coins) {
  const text = String(title ?? '');
  const upper = text.toUpperCase();
  const found = [];

  for (const coin of coins) {
    if (coin.name && text.includes(coin.name)) {
      found.push(coin.id);
      continue;
    }

    const suffixes = ['', ...QUOTE_SUFFIXES].join('|');
    const pattern = new RegExp(`(^|[^A-Z])${coin.id}(${suffixes})([^A-Z]|$)`);
    if (pattern.test(upper)) found.push(coin.id);
  }

  return found;
}

// ── 뉴스 심리 집계 ──────────────────────────────────────────

/** 시간이 지날수록 가중을 줄인다. 반나절 지난 뉴스는 이미 가격에 있다. */
function recencyWeight(at, now) {
  if (!present(at)) return 0.3;
  const hours = (now - at) / 3_600_000;
  if (hours < 0) return 1;
  if (hours > NEWS_WINDOW_HOURS) return 0;
  return Math.max(0.15, 1 - hours / NEWS_WINDOW_HOURS);
}

/**
 * 종목 하나에 대한 뉴스 심리.
 * @returns {{score, articles, count}} articles 는 근거로 화면에 보여줄 기사다.
 */
export function scoreNews(articles, coin, coins, now = Date.now()) {
  if (!Array.isArray(articles) || !articles.length) {
    return { score: null, articles: [], count: 0 };
  }

  const related = [];
  let total = 0;
  let weightSum = 0;

  for (const article of articles) {
    const mentioned = coinsMentioned(article.title, coins);
    const isCoin = mentioned.includes(coin);
    // 다른 종목만 언급한 기사는 이 종목과 무관하다.
    const isMarket = mentioned.length === 0;
    if (!isCoin && !isMarket) continue;

    const recency = recencyWeight(article.at, now);
    if (recency === 0) continue;

    const { score, matches } = scoreArticle(article);
    const weight = (isCoin ? COIN_WEIGHT : MARKET_WEIGHT) * recency;

    related.push({ ...article, score, matches, scope: isCoin ? 'coin' : 'market' });

    // 걸리는 단어가 없는 기사는 분모에도 넣지 않는다. 중립 표를 만들지 않기 위해서다.
    if (!matches.length) continue;
    total += score * weight;
    weightSum += weight;
  }

  if (weightSum === 0) {
    return { score: null, articles: related, count: related.length };
  }

  /*
   * 분모를 max(가중합, 1) 로 둔다. 그냥 가중 평균을 쓰면 분모가 가중을 상쇄해
   * 기사가 한 건일 때 최신성이 아무 효과가 없다 — 20시간 전 기사가 방금 나온
   * 기사와 같은 점수를 냈다. 최신성은 상대 비중이 아니라 크기를 줄여야 한다.
   * 이렇게 두면 오래된 기사 한 건은 거의 못 움직이고, 신선한 기사가 여럿이면
   * 평균처럼 동작해 온전한 세기를 낸다.
   */
  return {
    score: round1(Math.max(-100, Math.min(100, total / Math.max(weightSum, 1)))),
    articles: related,
    count: related.length,
  };
}

// ── 커뮤니티 투표 ───────────────────────────────────────────

/**
 * CoinGecko 의 상승/하락 투표 비율. 분석이 아니라 인기 투표이므로 크기를
 * ±30 으로 묶어 둔다. 군중 심리라 방향이 확실하지 않다.
 */
export function scoreVotes(upPercentage) {
  if (!present(upPercentage)) return null;

  const score = Math.round(((upPercentage - 50) / 50) * 30);
  const verdict = score >= 12 ? '상승 우세' : score <= -12 ? '하락 우세' : '팽팽';
  return { score, verdict, display: `상승 ${Math.round(upPercentage)}%` };
}

// ── 검색 관심도 ─────────────────────────────────────────────

/**
 * 관심이 몰린다는 사실만으로는 방향을 모른다. ATR·거래량과 같은 원칙으로
 * 가격 방향과 짝지어야 뜻이 생긴다.
 */
export function scoreAttention(trending, change24h) {
  if (!present(change24h)) return null;

  if (!trending) return { score: 0, verdict: '평범', display: '검색 상위 아님' };
  if (change24h === 0) return { score: 0, verdict: '방향 없음', display: '검색 상위' };

  return change24h > 0
    ? { score: 30, verdict: '관심 · 상승', display: '검색 상위' }
    : { score: -30, verdict: '관심 · 하락', display: '검색 상위' };
}

// ── 추적기 ──────────────────────────────────────────────────

const unavailable = (key) => ({
  key,
  label: SENTIMENT_LABELS[key] ?? key,
  score: null,
  verdict: '—',
  display: '데이터 없음',
  available: false,
});

const entry = (key, evaluated) =>
  evaluated ? { key, label: SENTIMENT_LABELS[key] ?? key, available: true, ...evaluated } : unavailable(key);

/**
 * 서버에서 받은 뉴스·심리를 들고 있으면서 종목별 카테고리 점수를 낸다.
 * 수집은 app.js 가 맡고 이 모듈은 상태 보관과 판정만 한다.
 */
export function createSentimentTracker() {
  let articles = [];
  let market = { fearGreed: null, trending: [], coins: {} };
  let newsFetchedAt = null;
  let newsFailures = [];

  return {
    applyNews(payload) {
      if (Array.isArray(payload)) {
        articles = payload;
        newsFetchedAt = Date.now();
        return;
      }
      articles = payload?.articles ?? [];
      newsFailures = payload?.failures ?? [];
      newsFetchedAt = payload?.fetchedAt ?? Date.now();
    },

    applySentiment(payload) {
      market = {
        fearGreed: payload?.fearGreed ?? null,
        trending: payload?.trending ?? [],
        coins: payload?.coins ?? {},
      };
    },

    fearGreed() {
      return market.fearGreed;
    },

    news() {
      return { articles, fetchedAt: newsFetchedAt, failures: newsFailures };
    },

    /** 종목별 탐욕지수가 소셜·관심도 성분으로 쓴다. */
    votesOf(coin) {
      return market.coins?.[coin] ?? null;
    },

    /** 검색 상위 진입 여부. 데이터를 아직 못 받았으면 null 이다. */
    isTrending(coin) {
      if (!market.trending?.length && !market.fearGreed) return null;
      return market.trending?.includes(coin) ?? null;
    },

    evaluate(coin, coins, now = Date.now()) {
      const votes = market.coins?.[coin] ?? null;
      const newsResult = scoreNews(articles, coin, coins, now);

      const indicators = [
        entry('fearGreed', scoreFearGreed(market.fearGreed?.value)),
        entry(
          'news',
          newsResult.score === null
            ? null
            : {
                score: newsResult.score,
                verdict:
                  newsResult.score >= 20 ? '긍정' : newsResult.score <= -20 ? '부정' : '중립',
                display: `기사 ${newsResult.count}건`,
              },
        ),
        entry('votes', scoreVotes(votes?.up)),
        entry('attention', scoreAttention(market.trending?.includes(coin), votes?.change24h)),
      ];

      const usable = indicators.filter((item) => item.available);
      const score = usable.length
        ? round1(usable.reduce((sum, item) => sum + item.score, 0) / usable.length)
        : null;

      return {
        score,
        indicators,
        articles: newsResult.articles,
        fearGreed: market.fearGreed,
        weight: sentimentCategory().weight,
      };
    },
  };
}
