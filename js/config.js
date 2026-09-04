/**
 * 단일 설정 원본. 종목·봉 주기·가중치·등급 기준을 여기서만 정의한다.
 * 순수 데이터만 두어 브라우저와 Node 테스트가 같은 값을 참조하게 한다.
 */

/** 저장된 선택이 없을 때 쓰는 기본 종목. 런타임 목록은 markets.js 가 관리한다. */
export const DEFAULT_COINS = [
  { id: 'BTC', name: '비트코인' },
  { id: 'XRP', name: '리플' },
  { id: 'ETH', name: '이더리움' },
];

/**
 * 동시 감시 종목 상한.
 *
 * 거래소 7 × 종목 N × 주기 3 이 30초마다 돈다. 한도가 가장 낮은 크라켄은
 * 요청 간격을 600ms 로 벌려야 해서 N=6 이면 한 바퀴에 10.8초가 걸린다.
 * N=20 이면 36초로 갱신 주기를 넘어 캔들이 밀리기 시작한다.
 */
export const MAX_COINS = 6;

/** 실시간 수급(호가·체결) 스트림을 받는 거래소 */
export const FLOW_EXCHANGE = 'upbit';

/** 김치 프리미엄 계산에 쓰는 환율 기준 자산. 업비트 KRW-USDT 시장가를 쓴다. */
export const FX_ASSET = 'USDT';

/** weight = 시그널 점수에서 차지하는 비중, minutes = 봉 길이(분) */
export const TIMEFRAMES = [
  { key: 'day', label: '일봉', short: '1D', weight: 0.5, minutes: 1440 },
  { key: 'h4', label: '4시간', short: '4H', weight: 0.3, minutes: 240 },
  { key: 'h1', label: '1시간', short: '1H', weight: 0.2, minutes: 60 },
];

/**
 * 지표 카테고리.
 *
 * 카테고리 **안에서는 단순 평균**, 카테고리 **사이에만 가중**을 둔다.
 * 지표를 그냥 나열해 가중 평균하면 상관 높은 지표가 같은 근거를 여러 번
 * 투표한다 — MA·MACD·ADX 는 모두 추세를 보고, RSI·스토캐스틱은 모두 모멘텀을
 * 본다. 계층을 두면 지표를 더 넣어도 한 관점이 과대대표되지 않는다.
 *
 * `candleBased: false` 인 카테고리는 봉 주기 차원에 넣지 않는다. 호가·체결은
 * 캔들이 없으므로 일봉/4시간/1시간으로 반복할 대상이 아니다.
 */
export const CATEGORIES = [
  { key: 'trend', label: '추세', weight: 1.2, candleBased: true, indicators: ['ma', 'macd', 'adx'] },
  {
    key: 'momentum',
    label: '모멘텀',
    weight: 1.0,
    candleBased: true,
    indicators: ['rsi', 'stochastic', 'divergence'],
  },
  {
    key: 'volatility',
    label: '변동성',
    weight: 0.8,
    candleBased: true,
    indicators: ['bollinger', 'atr'],
  },
  { key: 'volume', label: '거래량', weight: 0.7, candleBased: true, indicators: ['volume', 'obv'] },
  /*
   * 거짓 무빙은 '돌파가 실패했다' 는 사실만 본다. 다른 카테고리와 달리 평소에는
   * 판정할 것이 없어 **분모에서 통째로 빠진다**(트랩도 휩쏘도 없으면 null).
   * 늘 0점으로 참여하면 아무 일도 없는 종목의 점수를 매번 중립 쪽으로 끌어당긴다.
   *
   * ⚠️ 재료(지지/저항·거래량)가 이미 다른 지표에 들어 있어 근거가 일부 겹친다.
   * 그래도 점수에 넣는 것은 사용자 결정이다 — 겹치는 만큼 가중을 추세(1.2)보다
   * 낮게 두어 완화한다.
   */
  {
    key: 'traps',
    label: '거짓 무빙',
    weight: 0.9,
    candleBased: true,
    indicators: ['falseBreak', 'whipsaw'],
  },
  {
    key: 'flow',
    label: '실시간 수급',
    weight: 1.0,
    candleBased: false,
    indicators: ['orderbook', 'taker'],
  },
  {
    key: 'sentiment',
    label: '시장 심리',
    // 지연·노이즈가 많고 키워드 감성은 문맥을 오해한다. 가중을 가장 낮게 둔다.
    weight: 0.6,
    candleBased: false,
    indicators: ['fearGreed', 'news', 'votes', 'attention'],
  },
];

export const candleCategories = () => CATEGORIES.filter((category) => category.candleBased);
export const flowCategory = () => CATEGORIES.find((category) => !category.candleBased);

/**
 * 실시간 수급 지표 라벨. signal.js 의 라벨 표와 분리해 둔 이유는 flow.js 가
 * 캔들 계층에 의존하지 않아야 하기 때문이다.
 */
const FLOW_LABELS = { orderbook: '호가 불균형', taker: '체결강도' };

export const labelOfFlowIndicator = (key) => FLOW_LABELS[key] ?? key;

export const sentimentCategory = () => CATEGORIES.find((category) => category.key === 'sentiment');

export const SENTIMENT_LABELS = {
  fearGreed: '공포탐욕지수',
  news: '뉴스 심리',
  votes: '커뮤니티 투표',
  attention: '검색 관심도',
};

/**
 * 뉴스·심리 중계 엔드포인트. `serve.py` 가 제공한다.
 * 없어도(순수 정적 서버) 시장 심리 카테고리만 빠지고 화면은 그대로 동작한다.
 */
export const SENTIMENT_API = {
  news: '/api/news',
  sentiment: '/api/sentiment',
  /** 서버가 5분 캐싱하므로 그보다 자주 부를 이유가 없다. */
  refreshMs: 300_000,
};

/**
 * ADX 동적 가중 — 추세가 있을 때만 추세 지표를 신뢰한다.
 *
 * 강한 추세에서 RSI 70 은 '비싸다'가 아니라 '계속 오른다'는 뜻인데, 평탄
 * 가중에서는 이것이 매도 표로 세어져 추세 신호를 상쇄해 버린다(실제로 이
 * 프로젝트에서 관측했다). 반대로 횡보장에서는 이동평균 신호가 톱질의 원인이다.
 */
export const ADX_REGIMES = {
  trending: { min: 25, label: '추세장', adjust: { trend: 1.5, momentum: 0.7, volatility: 0.8 } },
  ranging: { max: 20, label: '횡보장', adjust: { trend: 0.6, momentum: 1.3, volatility: 1.2 } },
  neutral: { label: '전환 구간', adjust: { trend: 1, momentum: 1, volatility: 1 } },
};

export const PERIODS = {
  rsi: 14,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  bollinger: 20,
  bollingerSigma: 2,
  maShort: 20,
  maLong: 60,
  volume: 20,
  adx: 14,
  stochastic: 14,
  stochasticSignal: 3,
  atr: 14,
  atrLookback: 100,
  obv: 20,
  divergenceSpan: 3,
  divergenceLookback: 60,
};

/**
 * 등급 경계. ±20 은 중립이 아니라 행동(매수/매도) 쪽으로 붙는다 —
 * 경계에 정확히 걸친 점수를 '아무 신호 없음'으로 버리지 않기 위한 선택이다.
 * 그래서 한 방향 비교만으로는 표현되지 않고 양쪽에서 좁혀 들어간다.
 */
export const GRADE_THRESHOLDS = {
  strongBuy: 50,
  buy: 20,
  sell: -20,
  strongSell: -50,
};

export const GRADES = {
  strongBuy: { key: 'strong-buy', label: '강력매수' },
  buy: { key: 'buy', label: '매수' },
  neutral: { key: 'neutral', label: '중립' },
  sell: { key: 'sell', label: '매도' },
  strongSell: { key: 'strong-sell', label: '강력매도' },
};

export const UNKNOWN_GRADE = { key: 'unknown', label: '판정 불가' };

/** 캔들 200개면 MA60·볼린저 계산에 넉넉하고 차트 축척도 안정적이다. */
export const CANDLE_COUNT = 200;

export const POLL = {
  /** 캔들 재조회 주기. 가격은 WebSocket 으로 받으므로 이 주기와 무관하다. */
  candleMs: 30_000,
  /** 한 거래소 안에서 캔들 요청을 흘리는 간격. 거래소별 초당 한도를 넘지 않게 한다. */
  candleGapMs: 150,
  /** WebSocket 이 죽어 REST 로 강등됐을 때의 시세 폴링 주기 */
  fallbackTickerMs: 5_000,
  retryBaseMs: 400,
  retryMax: 3,
  /** 이 시간을 넘도록 틱이 없으면 '낡음'으로 표시한다. */
  staleMs: 60_000,
};

export const REALTIME = {
  /** 재연결 백오프 상한 */
  reconnectMaxMs: 30_000,
  /** 이 횟수만큼 연달아 실패하면 해당 거래소만 REST 폴링으로 강등한다. */
  failuresBeforeFallback: 3,
  /** 강등된 뒤에도 이 주기로 소켓 복귀를 시도한다. */
  recoveryMs: 60_000,
  /** 체결이 몰릴 때 지표 재계산·카드 렌더 간격 */
  recomputeMs: 400,
  /** 차트는 노드가 많으므로 더 느리게 다시 그린다. */
  chartMs: 2_000,
};

/** 차트에 그릴 최근 봉 수 */
export const CHART_BARS = 80;
