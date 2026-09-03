/**
 * 화면 조립부. 상태를 들고 있고, 다른 모듈을 엮어 DOM 에 반영한다.
 *
 * 지표 계산은 signal.js, 거래소 집계는 aggregate.js, 통신은 js/exchanges/*,
 * 실시간 연결은 realtime.js, 그리기는 chart.js 가 맡는다.
 */

import {
  CATEGORIES,
  CHART_BARS,
  FLOW_EXCHANGE,
  FX_ASSET,
  GRADES,
  GRADE_THRESHOLDS,
  POLL,
  REALTIME,
  TIMEFRAMES,
  SENTIMENT_API,
  candleCategories,
  flowCategory,
  sentimentCategory,
} from './config.js';
import { EXCHANGES, exchangeOf, fxExchange } from './exchanges/index.js';
import { combineTimeframes, evaluateTimeframe, gradeOf } from './signal.js';
import { consensus, crossExchangeGap, directionLabel, withExternal } from './aggregate.js';
import { STATUS, createRealtime } from './realtime.js';
import { createFlowTracker } from './flow.js';
import { coinsMentioned, createSentimentTracker, scoreArticle } from './news.js';
import { greedIndex, greedLabel as greedLabelOf } from './greed.js';
import { createTransitionLog, topContributors } from './transitions.js';
import {
  actionOf,
  categoryForces,
  explainForces,
  gradeGap,
  hasCandleForces,
  isNearBoundary,
  overheatNote,
} from './explain.js';
import { createSelection, fetchCatalog, searchCatalog } from './markets.js';
import { attachHelp, initTooltips } from './tooltip.js';
import { renderChart } from './chart.js';
import {
  formatClock,
  formatElapsed,
  formatPrice,
  formatRate,
  formatScore,
  formatSignedRate,
  formatTradeValue,
  quoteSuffix,
} from './format.js';

let realtime = null;

/** 주기 작업 핸들. 일시정지·탭 전환 때 멈추려면 이름이 있어야 한다. */
const timers = { candles: null, sentiment: null, banner: null };

const selection = createSelection();
const flowTracker = createFlowTracker({ windowMs: 60_000 });
const sentimentTracker = createSentimentTracker();
const transitions = createTransitionLog({ limit: 50 });

/** 카테고리·지표 골격. 캔들이 하나도 없을 때 표를 그리는 데 쓴다. */
const TEMPLATE = evaluateTimeframe([]);

/** 프리미엄 비교 기준이 되는 해외 거래소. 거래대금이 가장 큰 곳을 쓴다. */
const REFERENCE_EXCHANGE = 'binance';

const state = {
  tickers: Object.fromEntries(EXCHANGES.map((exchange) => [exchange.id, new Map()])),
  candles: Object.fromEntries(EXCHANGES.map((exchange) => [exchange.id, {}])),
  evaluations: {},
  status: Object.fromEntries(EXCHANGES.map((exchange) => [exchange.id, STATUS.connecting])),
  fxRate: null,
  coins: selection.list(),
  catalog: [],
  catalogQuery: '',
  panelOpen: false,
  helpOpen: false,
  newsError: null,
  paused: false,
  hidden: false,
  selectedCoin: selection.ids()[0],
  selectedExchange: EXCHANGES[0].id,
  chartTimeframe: TIMEFRAMES[0].key,
  subPanel: 'rsi',
  /** 'live' | CHART_PERIODS 의 key. live 가 아니면 별도로 받아온 periodCandles 를 그린다. */
  chartPeriod: 'live',
  periodCandles: null,
  periodLoading: false,
  periodError: null,
  /** 확대 상태. null = 자동(기간 없으면 CHART_BARS, 기간 있으면 전체). 숫자면 그만큼만 그린다. */
  chartZoomBars: null,
  /** 마지막으로 그린 캔들 총 개수 — 줌 상/하한을 정하는 기준(zoomChart 가 읽는다). */
  chartMaxBars: CHART_BARS,
  /** 참고용 차트선 카테고리. 기본은 전부 꺼짐 — 흐릿한 패턴 매칭까지 기본 노출하지 않는다. */
  patternCategories: new Set(),
  lastTickAt: null,
  notice: null,
  ready: false,
  /** 직전 렌더 시점의 가격. 체결 플래시 방향을 정하는 데만 쓴다. */
  renderedPrices: new Map(),
};

const dom = {
  cards: document.getElementById('cards'),
  chart: document.getElementById('chart'),
  chartTitle: document.getElementById('chart-title'),
  exchangeTabs: document.getElementById('exchange-tabs'),
  timeframeTabs: document.getElementById('timeframe-tabs'),
  subTabs: document.getElementById('sub-tabs'),
  periodTabs: document.getElementById('period-tabs'),
  patternToggles: document.getElementById('pattern-toggles'),
  zoomIn: document.getElementById('zoom-in'),
  zoomOut: document.getElementById('zoom-out'),
  zoomReset: document.getElementById('zoom-reset'),
  zoomLevel: document.getElementById('zoom-level'),
  grid: document.getElementById('grid'),
  detail: document.getElementById('detail'),
  detailTitle: document.getElementById('detail-title'),
  clock: document.getElementById('clock'),
  fx: document.getElementById('fx-rate'),
  status: document.getElementById('exchange-status'),
  banner: document.getElementById('banner'),
  transitions: document.getElementById('transitions'),
  transitionsClear: document.getElementById('transitions-clear'),
  news: document.getElementById('news'),
  newsTitle: document.getElementById('news-title'),
  panel: document.getElementById('coin-panel'),
  panelToggle: document.getElementById('coin-toggle'),
  help: document.getElementById('help-panel'),
  helpToggle: document.getElementById('help-toggle'),
  pause: document.getElementById('pause-toggle'),
  search: null,
};

/*
 * 검색 입력은 렌더마다 새로 만들면 타이핑 중에 포커스와 커서가 날아간다.
 * 한 번만 만들어 두고 패널을 다시 그릴 때 같은 노드를 재사용한다.
 */
function createSearchInput() {
  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'panel-search';
  input.placeholder = '종목명 또는 심볼 검색 (예: 도지, SOL)';
  input.setAttribute('aria-label', '종목 검색');
  input.addEventListener('input', () => {
    state.catalogQuery = input.value;
    renderCoinPanel();
  });
  return input;
}
dom.search = createSearchInput();

const gaugePosition = (score) => ((score + 100) / 200) * 100;

const toneOf = (score) => {
  if (score === null || score === undefined) return 'flat';
  if (score > 0) return 'buyish';
  if (score < 0) return 'sellish';
  return 'flat';
};

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * 마지막 캔들의 종가를 실시간 현재가로 덮어쓴다.
 * 이걸 하지 않으면 캔들 갱신 주기(30초) 사이에 시그널이 굳고, 일봉은 하루
 * 내내 전일 종가 기준 판정을 보여준다.
 */
function withLivePrice(candles, price) {
  if (!candles || !candles.length || !Number.isFinite(price)) return candles;

  const last = candles.at(-1);
  return [
    ...candles.slice(0, -1),
    { ...last, close: price, high: Math.max(last.high, price), low: Math.min(last.low, price) },
  ];
}

function coinIds() {
  return state.coins.map((coin) => coin.id);
}

const coinName = (id) => state.coins.find((coin) => coin.id === id)?.name ?? id;

function recompute() {
  const fxTicker = state.tickers[fxExchange.id]?.get(FX_ASSET);
  state.fxRate = fxTicker?.price ?? state.fxRate;

  for (const coin of coinIds()) {
    const byExchange = {};
    const scoreByExchange = {};

    for (const exchange of EXCHANGES) {
      const price = state.tickers[exchange.id]?.get(coin)?.price;
      const byTimeframe = {};
      const scores = {};

      for (const timeframe of TIMEFRAMES) {
        const candles = withLivePrice(state.candles[exchange.id]?.[coin]?.[timeframe.key], price);
        byTimeframe[timeframe.key] = candles ? evaluateTimeframe(candles) : null;
        scores[timeframe.key] = byTimeframe[timeframe.key]?.score ?? null;
      }

      const score = combineTimeframes(scores);
      byExchange[exchange.id] = { byTimeframe, score, grade: gradeOf(score) };
      scoreByExchange[exchange.id] = score;
    }

    const agreement = consensus(scoreByExchange);
    const flow = flowTracker.evaluate(coin);
    const sentiment = sentimentTracker.evaluate(coin, state.coins);
    // 봉 주기가 없는 카테고리는 캔들 계층을 끝까지 접은 뒤 한 번만 얹는다.
    const finalScore = withExternal(agreement.score, {
      flow: flow.score,
      sentiment: sentiment.score,
    });

    /*
     * 종목별 탐욕지수는 **표시 전용**이다. 재료가 이미 점수에 들어간 지표들이라
     * finalScore 에 넣으면 같은 정보를 두 번 세게 된다. 그래서 evaluation 에만
     * 담고 withExternal 에는 넘기지 않는다.
     */
    const greed = greedIndex({
      candles: state.candles[fxExchange.id]?.[coin]?.day ?? null,
      votes: sentimentTracker.votesOf(coin),
      trending: sentimentTracker.isTrending(coin),
    });

    // 전환 근거·카드 요약이 함께 쓰는 지표 모음. 선택된 거래소 지표를 우선하고
    // 없으면 대표 거래소(업비트)로 대체한다.
    const reference = byExchange[state.selectedExchange] ?? byExchange[fxExchange.id];
    const dayIndicators =
      reference?.byTimeframe?.day?.categories?.flatMap((category) => category.indicators) ?? [];
    const allIndicators = [...dayIndicators, ...flow.indicators, ...sentiment.indicators];

    const evaluation = {
      byExchange,
      consensus: { ...agreement, score: finalScore, candleScore: agreement.score },
      flow,
      sentiment,
      greed,
      grade: gradeOf(finalScore),
      // 점수를 가장 크게 움직인 지표 1~2개 — 카드 한 줄 요약의 근거.
      reasons: topContributors(allIndicators, 2),
      premium: crossExchangeGap({
        krwPrice: state.tickers[fxExchange.id]?.get(coin)?.price ?? null,
        usdtPrice: state.tickers[REFERENCE_EXCHANGE]?.get(coin)?.price ?? null,
        usdtKrw: state.fxRate,
      }),
    };
    state.evaluations[coin] = evaluation;

    transitions.observe(coin, evaluation, allIndicators);
  }
}

// ── 헤더 ─────────────────────────────────────────────────────

function renderHeader() {
  dom.clock.textContent = state.lastTickAt ? `${formatClock(state.lastTickAt)} KST` : '연결 중';
  dom.fx.textContent = state.fxRate
    ? `${FX_ASSET} ${formatPrice(state.fxRate, 'KRW')}원`
    : `${FX_ASSET} —`;

  const chips = document.createDocumentFragment();
  for (const exchange of EXCHANGES) {
    const status = state.status[exchange.id] ?? STATUS.down;
    const chip = el('span', `feed feed-${status.key}`);
    chip.append(el('i', 'feed-dot'), el('span', 'feed-name', exchange.name));
    chip.append(el('span', 'feed-state', status.label));
    chip.title = `${exchange.name} · ${status.label} (${exchange.quote} 마켓)`;
    chips.append(chip);
  }
  dom.status.replaceChildren(chips);

  const paused = state.paused;
  dom.pause.setAttribute('aria-pressed', String(paused));
  dom.pause.classList.toggle('paused', paused);
  dom.pause.textContent = paused ? '재개' : '일시정지';
  dom.pause.title = paused
    ? '소켓을 다시 열고 캔들 조회를 재개합니다'
    : '소켓을 끊고 캔들 조회를 멈춥니다. 화면의 값은 그대로 남습니다';
}

function renderBanner() {
  const stale =
    state.lastTickAt && Date.now() - state.lastTickAt.getTime() > POLL.staleMs
      ? `마지막 체결 ${formatElapsed(Date.now() - state.lastTickAt.getTime())}`
      : null;

  const message = state.notice ?? stale;
  if (!message) {
    dom.banner.hidden = true;
    dom.banner.replaceChildren();
    return;
  }

  const retry = el('button', 'banner-retry', '다시 시도');
  retry.type = 'button';
  retry.addEventListener('click', () => loadCandles().then(refreshAll));

  dom.banner.replaceChildren(el('span', null, message), retry);
  dom.banner.hidden = false;
}

// ── 종목 카드 ────────────────────────────────────────────────

function renderCards() {
  const fragment = document.createDocumentFragment();

  for (const coin of state.coins) {
    const evaluation = state.evaluations[coin.id];
    const agreement = evaluation?.consensus;
    const grade = evaluation?.grade ?? gradeOf(null);
    const primary = state.tickers[fxExchange.id]?.get(coin.id);

    const card = el('article', 'card');
    card.dataset.coin = coin.id;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-pressed', String(state.selectedCoin === coin.id));
    if (state.selectedCoin === coin.id) card.classList.add('selected');

    card.append(
      cardHead(coin, grade, evaluation),
      priceRow(coin.id, primary),
      signalRow(coin.id, agreement, grade, evaluation),
      reasonRow(evaluation),
      whyRow(coin.id, evaluation, grade),
      gauge(coin, agreement, grade, evaluation),
      greedRow(coin.id, evaluation),
      flowRow(coin.id, evaluation),
      sentimentRow(coin.id, evaluation),
      exchangeRows(coin.id, evaluation),
      premiumRow(coin.id, evaluation, primary),
    );
    fragment.append(card);
  }

  dom.cards.replaceChildren(fragment);
}

function cardHead(coin, grade, evaluation) {
  const head = el('header', 'card-head');

  const symbol = el('div', 'symbol');
  symbol.append(el('strong', null, coin.id), el('span', null, coin.name));

  /*
   * 알트코인은 해외 거래소에 없는 경우가 많다. 몇 곳이 실제로 판정에 참여했는지
   * 보여주지 않으면 '합의 2/2 완전 일치' 가 근거가 두 곳뿐이라는 사실을 감춘다.
   */
  const total = evaluation?.consensus?.total ?? 0;
  const capable = EXCHANGES.filter((exchange) => exchange.browserRest !== false).length;
  if (total && total < capable) {
    const support = el('span', 'support', `${total}/${capable} 거래소`);
    support.title = `이 종목을 지원하는 거래소가 ${total}곳입니다`;
    symbol.append(support);
  }

  const remove = el('button', 'card-remove', '×');
  remove.type = 'button';
  remove.title = `${coin.name} 제거`;
  remove.setAttribute('aria-label', `${coin.name} 제거`);
  remove.dataset.remove = coin.id;

  /*
   * 등급 라벨만으로는 무엇을 하라는 말인지 전달되지 않는다 — 특히 '중립' 은
   * '신호 없음' 이 아니라 '근거가 양쪽으로 갈렸다' 는 뜻이다. 행동 언어를 함께 적는다.
   */
  const verdict = el('div', 'verdict');
  verdict.append(
    el('span', `grade grade-${grade.key}`, grade.label),
    el('span', 'grade-action', actionOf(grade)),
  );

  head.append(symbol, verdict, remove);
  return head;
}

/**
 * 카드 한 줄 요약 — 점수를 가장 크게 움직인 지표 1~2개를 문장으로 보여준다.
 * 숫자만 늘어선 카드에서 '왜 이 등급인지'를 계산해 보지 않아도 읽히게 한다.
 */
function reasonRow(evaluation) {
  const row = el('div', 'reason-row');
  const reasons = evaluation?.reasons ?? [];

  if (!reasons.length) {
    row.append(el('span', 'reason-text flat', '뚜렷한 근거 지표 없음'));
    return row;
  }

  reasons.forEach((reason, index) => {
    if (index > 0) row.append(el('span', 'reason-sep', '·'));
    row.append(el('span', `reason-text ${toneOf(reason.score)}`, `${reason.label} ${reason.verdict}`));
  });

  return row;
}

/**
 * '왜 이 등급인가' — 카테고리를 매수 편·매도 편으로 갈라 가중만큼의 힘으로 그린다.
 *
 * 이 화면에서 가장 자주 나온 질문이 '가격이 크게 올랐는데 왜 아직 중립이냐'
 * 였다. 답은 추세(매수)와 과매수(매도)가 상쇄됐다는 것인데, 점수 한 줄로는 그
 * 상쇄가 전혀 보이지 않는다. 힘의 방향과 크기를 그대로 드러낸다.
 */
function whyRow(coin, evaluation, grade) {
  const wrap = el('section', 'why');

  // 지표 상세·전환 근거와 같은 기준 거래소를 쓴다. 선택한 곳이 이 종목을
  // 지원하지 않으면 대표 거래소로 물러난다.
  let exchange = exchangeOf(state.selectedExchange) ?? fxExchange;
  let forces = categoryForces(evaluation, exchange.id);
  // 수급·심리는 거래소와 무관하게 남으므로 길이가 아니라 캔들 유무로 판단한다.
  if (!hasCandleForces(forces) && exchange.id !== fxExchange.id) {
    exchange = fxExchange;
    forces = categoryForces(evaluation, exchange.id);
  }

  if (!forces.length) {
    wrap.append(el('p', 'why-empty', '판정 근거를 계산할 데이터가 아직 없습니다.'));
    return wrap;
  }

  const head = el('div', 'why-head');
  head.append(el('span', 'why-title', `왜 ${grade.label}인가`));
  head.append(el('span', 'why-basis', `${exchange.name} 기준`));
  head.title = [
    '캔들 카테고리는 이 거래소의 일봉·4시간·1시간 점수를 주기 가중(0.5·0.3·0.2)으로 접은 값입니다.',
    '최종 시그널은 거래소 여러 곳의 평균이라 이 값과 정확히 같지는 않습니다.',
    '가중에는 ADX 국면 조정이 이미 반영돼 있습니다.',
  ].join(' ');
  wrap.append(head);

  const list = el('div', 'force-list');
  for (const force of forces) {
    const row = el('div', 'force-row');
    row.append(el('span', 'force-label', force.label));

    const track = el('span', 'force-track');
    const left = el('span', 'force-half left');
    const right = el('span', 'force-half right');
    /*
     * 0 을 매수 쪽으로 몰면 '시장 심리 0' 이 빨간 매수 막대로 보인다 — 당기지
     * 않는 것과 약하게 당기는 것은 다르다. 회색으로 따로 그린다.
     */
    const side = force.pull > 0 ? 'buy' : force.pull < 0 ? 'sell' : 'flat';
    const bar = el('i', `force-bar ${side}`);
    // 0점이어도 카테고리가 참여했다는 사실은 보여야 하므로 최소 폭을 준다.
    bar.style.width = `${Math.max(2, Math.round(force.ratio * 100))}%`;
    (force.pull < 0 ? left : right).append(bar);
    track.append(left, el('i', 'force-axis'), right);
    row.append(track);

    row.append(el('span', `force-score ${toneOf(force.pull)}`, formatScore(force.score)));
    attachHelp(row, `cat:${force.key}`, {
      id: `force:${coin}:${force.key}`,
      live: `${formatScore(force.score)}점 × 가중 ${force.weight} = 당기는 힘 ${formatScore(force.pull)}`,
    });
    list.append(row);
  }
  wrap.append(list);

  const sentence = explainForces(forces, grade);
  if (sentence) wrap.append(el('p', 'why-text', sentence));

  const note = overheatNote(forces);
  if (note) wrap.append(el('p', `why-note ${note.tone}`, note.text));

  return wrap;
}

/** 실시간 수급 한 줄 — 캔들 지표와 성질이 달라 따로 보여준다. */
function flowRow(coin, evaluation) {
  const flow = evaluation?.flow;
  const row = el('div', 'flow-row');

  const title = el('span', 'flow-title', flowCategory().label);
  row.append(title);

  for (const indicator of flow?.indicators ?? []) {
    const item = el('span', `flow-item ${toneOf(indicator.score)}`);
    item.append(el('span', 'flow-label', indicator.label));
    item.append(el('span', 'flow-value', indicator.available ? indicator.display : '대기'));
    attachHelp(item, `ind:${indicator.key}`, {
      id: `flow:${coin}:${indicator.key}`,
      live: indicator.available
        ? `지금 ${indicator.display} · ${indicator.verdict} (${formatScore(indicator.score)}점)`
        : '체결 대기 중 — 아직 판정하지 않습니다',
    });
    row.append(item);
  }

  return row;
}

/**
 * 대표 가격은 업비트 원화다. 해외 거래소 시세는 아래 거래소 행에서 각자의
 * 견적 통화로 보여준다 — 환산해서 한 줄로 합치면 어느 값이 실제 체결가인지
 * 알 수 없게 된다.
 */
function priceRow(coin, ticker) {
  const row = el('div', 'price-row');
  const price = el('span');
  const delta = el('span');

  if (!ticker) {
    price.className = 'price';
    price.textContent = '—';
    delta.className = 'delta';
    delta.textContent = '시세 대기 중';
  } else {
    const key = `${fxExchange.id}:${coin}`;
    const previous = state.renderedPrices.get(key);
    const flash =
      previous === undefined || previous === ticker.price
        ? ''
        : ticker.price > previous
          ? ' flash-up'
          : ' flash-down';
    state.renderedPrices.set(key, ticker.price);

    if (ticker.direction === 'EVEN') {
      price.className = `price even${flash}`;
      price.textContent = formatPrice(ticker.price, fxExchange.quote);
      delta.className = 'delta even';
      delta.textContent = '─ 보합';
    } else {
      const tone = ticker.direction === 'RISE' ? 'rise' : 'fall';
      const arrow = ticker.direction === 'RISE' ? '▲' : '▼';
      price.className = `price ${tone}${flash}`;
      price.textContent = formatPrice(ticker.price, fxExchange.quote);
      delta.className = `delta ${tone}`;
      delta.textContent = `${arrow} ${formatPrice(Math.abs(ticker.changePrice), fxExchange.quote)} (${formatRate(ticker.changeRate)})`;
    }
  }

  row.append(price, delta);
  return row;
}

/**
 * 시그널 점수와 합의도를 한 줄에 나란히 둔다. 서로 다른 것을 재는 값들이다.
 *
 * 점수를 캔들과 수급으로 분해해 보여준다. 그러지 않으면 '6/6 완전 일치 · 중립'
 * 옆에 '+20 매수' 가 붙어 모순처럼 읽힌다 — 합의는 거래소들의 캔들 판정이고,
 * 수급은 업비트 단독 신호라 애초에 거래소 간 합의에 참여할 수 없다.
 */
function signalRow(coin, agreement, grade, evaluation) {
  const row = el('div', 'signal-row');

  const score = el('div', `signal-score tone-${grade.key}`);
  score.append(
    el('span', 'signal-label', '시그널'),
    el('strong', null, formatScore(agreement?.score ?? null)),
    el('span', 'unit', '점'),
  );

  const candle = agreement?.candleScore ?? null;
  const flow = evaluation?.flow?.score ?? null;
  const mood = evaluation?.sentiment?.score ?? null;
  if (candle !== null || flow !== null || mood !== null) {
    const parts = [`캔들 ${formatScore(candle)}`];
    if (flow !== null) parts.push(`수급 ${formatScore(flow)}`);
    if (mood !== null) parts.push(`심리 ${formatScore(mood)}`);
    score.append(el('span', 'signal-breakdown', parts.join(' · ')));
  }

  /*
   * 19.9 를 '중립' 이라고만 적으면 매수 기준선(20.0)에서 0.1점 모자란 상태와
   * 0점짜리 중립이 화면에서 똑같아 보인다. 등급 산출은 그대로 두고 표시만 더한다.
   */
  const gap = gradeGap(agreement?.score ?? null);
  if (gap) {
    const chip = el(
      'span',
      `signal-gap${isNearBoundary(gap) ? ' near' : ''}`,
      `${gap.direction === 'up' ? '↑' : '↓'} ${gap.label}까지 ${gap.gap}점`,
    );
    score.append(chip);
  }

  const live = [`현재 ${formatScore(agreement?.score ?? null)}점 · ${grade.label}`];
  if (candle !== null) live.push(`캔들 ${formatScore(candle)}`);
  if (flow !== null) live.push(`수급 ${formatScore(flow)}`);
  if (mood !== null) live.push(`심리 ${formatScore(mood)}`);
  if (gap) live.push(`${gap.label}까지 ${gap.gap}점`);
  attachHelp(score, 'screen:score', { id: `score:${coin}`, live: live.join(' · ') });

  const total = agreement?.total ?? 0;
  const agree = agreement?.agree ?? 0;
  const badge = el('div', `agreement agreement-${agreement?.label === '완전 일치' ? 'full' : agreement?.label === '이견' ? 'split' : 'majority'}`);
  badge.append(el('span', 'agreement-count', total ? `${agree}/${total}` : '—'));

  const dots = el('span', 'agreement-dots');
  for (let index = 0; index < (total || EXCHANGES.length); index += 1) {
    dots.append(el('i', index < agree ? 'dot on' : 'dot'));
  }
  badge.append(dots);

  const label = agreement?.total
    ? `${agreement.label} · 캔들 ${directionLabel(agreement.direction)}`
    : '데이터 없음';
  badge.append(el('span', 'agreement-label', label));
  const capable = EXCHANGES.filter((exchange) => exchange.browserRest !== false).length;
  attachHelp(badge, 'screen:consensus', {
    id: `consensus:${coin}`,
    live: `지표를 낼 수 있는 거래소 ${capable}곳 중 ${total}곳이 참여해 ${label} 입니다`,
  });

  row.append(score, badge);
  return row;
}

/**
 * 시그니처 요소 — 시그널 점수와 세 거래소를 하나의 −100~+100 축에 얹는다.
 * 마커가 모여 있으면 거래소 합의, 흩어져 있으면 이견이라는 사실이 숫자를
 * 읽기 전에 보인다.
 */
function gauge(coin, agreement, grade, evaluation) {
  const wrap = el('div', 'gauge');
  wrap.setAttribute('role', 'img');
  wrap.setAttribute(
    'aria-label',
    agreement?.score === null || agreement?.score === undefined
      ? `${coin.name} 판정 불가`
      : `${coin.name} 시그널 ${formatScore(agreement.score)}점, ${grade.label}, 거래소 합의 ${agreement.agree}/${agreement.total}`,
  );

  const track = el('div', 'gauge-track');
  track.append(el('i', 'gauge-zero'));

  for (const exchange of EXCHANGES) {
    const score = evaluation?.byExchange?.[exchange.id]?.score ?? null;
    if (score === null) continue;
    const tick = el('i', `gauge-tick tick-${exchange.id}`);
    tick.style.left = `${gaugePosition(score)}%`;
    tick.title = `${exchange.name} ${formatScore(score)}점`;
    track.append(tick);
  }

  if (agreement?.score !== null && agreement?.score !== undefined) {
    const marker = el('i', `gauge-marker tone-${grade.key}`);
    marker.style.left = `${gaugePosition(agreement.score)}%`;
    track.append(marker);
  }

  const axis = el('div', 'gauge-axis');
  for (const label of ['−100 매도', '0', '매수 +100']) axis.append(el('span', null, label));

  wrap.append(track, axis);
  return wrap;
}

/**
 * 거래소별 점수를 압축 격자로 보여준다.
 *
 * 거래소가 7곳이 되면서 한 줄씩 쌓는 방식은 카드를 세 배로 늘려 놓았다.
 * 카드에서는 '어디가 몇 점인가'만 남기고, 시세·봉 주기별 점수는 아래 합의
 * 격자로 옮겼다. 같은 정보를 두 곳에 두면 화면만 길어진다.
 */
function exchangeRows(coin, evaluation) {
  const list = el('ul', 'feed-cells');

  for (const exchange of EXCHANGES) {
    const result = evaluation?.byExchange?.[exchange.id];
    const score = result?.score ?? null;
    const grade = result?.grade ?? gradeOf(null);
    const ticker = state.tickers[exchange.id]?.get(coin);

    const priceOnly = exchange.browserRest === false;
    const item = el('li', `feed-cell tick-${exchange.id}${priceOnly ? ' price-only' : ''}`);
    item.append(el('span', 'feed-cell-name', exchange.name));
    item.append(
      el(
        'span',
        `feed-cell-score tone-${grade.key}`,
        priceOnly ? '시세만' : formatScore(score),
      ),
    );
    item.title = priceOnly
      ? `${exchange.name} · ${exchange.note}. 시세는 소켓으로 받지만 캔들을 못 받아 지표를 계산하지 않는다`
      : ticker
        ? `${exchange.name} · ${grade.label} ${formatScore(score)}점 · ${formatPrice(ticker.price, exchange.quote)} ${exchange.quote}`
        : `${exchange.name} · 시세 대기 중`;

    list.append(item);
  }

  return list;
}

function premiumRow(coin, evaluation, primary) {
  const list = el('dl', 'card-meta');
  const premium = evaluation?.premium ?? null;

  const rows = [
    ['USDT 기준 괴리', premium === null ? '—' : formatSignedRate(premium)],
    ['24H 거래대금', primary ? formatTradeValue(primary.quoteVolume24h) : '—'],
  ];

  for (const [term, value] of rows) {
    const dt = el('dt', null, term);
    const dd = el('dd', null, value);
    if (term === 'USDT 기준 괴리') {
      // 김치 프리미엄으로 오해하기 가장 쉬운 값이라 이름과 값 양쪽에 설명을 건다.
      const live = premium === null ? '아직 환산 기준을 못 받았습니다' : `지금 ${value}`;
      attachHelp(dt, 'screen:gap', { id: `gap:${coin}:term`, live });
      attachHelp(dd, 'screen:gap', { id: `gap:${coin}:value`, live });
      if (premium !== null) dd.classList.add(premium > 0 ? 'rise' : premium < 0 ? 'fall' : 'even');
    }
    list.append(dt, dd);
  }

  return list;
}

/**
 * 탐욕지수 한 줄 — 시장 전체 값과 종목별 값을 나란히 둔다.
 *
 * 시장 지수만 보면 세 카드에 같은 숫자가 찍혀 종목 차이를 알 수 없다. 종목 지수를
 * 옆에 두면 '시장은 탐욕인데 이 종목만 공포' 라는 어긋남이 보인다. 점수에는
 * 반영하지 않는 표시 전용 값이므로 그 사실을 툴팁에 적는다.
 */
function greedRow(coin, evaluation) {
  const greed = evaluation?.greed;
  const marketValue = evaluation?.sentiment?.fearGreed?.value ?? null;
  const marketGrade = greedLabelOf(marketValue);

  const row = el('div', 'greed-row');
  row.append(el('span', 'flow-title', '탐욕지수'));

  const market = el('span', `greed-chip greed-${marketGrade.key}`);
  market.append(el('span', 'greed-scope', '시장'));
  market.append(el('span', 'greed-value', marketValue === null ? '—' : String(marketValue)));
  market.append(el('span', 'greed-label', marketGrade.label));
  const marketIndicator = evaluation?.sentiment?.indicators?.find((d) => d.key === 'fearGreed');
  attachHelp(market, 'greed:market', {
    id: `greed:${coin}:market`,
    live: marketIndicator?.available
      ? `지금 ${marketValue} ${marketGrade.label} · 역추세로 읽어 시그널 점수에 ${formatScore(marketIndicator.score)}점 기여합니다`
      : '아직 값을 받지 못했습니다',
  });
  row.append(market);

  const own = el('span', `greed-chip own greed-${greed?.key ?? 'unknown'}`);
  own.append(el('span', 'greed-scope', coin));
  own.append(el('span', 'greed-value', greed?.value === null ? '—' : String(Math.round(greed.value))));
  own.append(el('span', 'greed-label', greed?.label ?? '판정 불가'));
  attachHelp(own, 'greed:own', {
    id: `greed:${coin}:own`,
    live:
      greed?.value === null || greed?.value === undefined
        ? '성분 데이터가 모자라 판정하지 못했습니다'
        : `지금 ${coin} ${Math.round(greed.value)} ${greed.label}`,
  });
  row.append(own);

  if (greed?.value !== null && greed?.value !== undefined) {
    const bar = el('span', 'greed-bar');
    const fill = el('i', `greed-fill greed-${greed.key}`);
    fill.style.width = `${Math.round(greed.value)}%`;
    bar.append(fill);
    row.append(bar);

    /*
     * 성분을 이어 붙인 한 줄이 아니라 성분마다 따로 그린다. 각 성분이 무엇을
     * 재는 값인지 설명을 붙여야 하는데 한 덩어리 문자열에는 붙일 자리가 없다.
     */
    const parts = el('span', 'greed-parts');
    for (const component of greed.components) {
      if (component.value === null) continue;
      const chip = el('span', 'greed-part');
      chip.append(el('span', 'greed-part-label', component.label));
      chip.append(el('span', 'greed-part-value', String(Math.round(component.value))));
      attachHelp(chip, `gc:${component.key}`, {
        id: `greed:${coin}:part:${component.key}`,
        live: `지금 ${Math.round(component.value)} · 가중 ${Math.round(component.weight * 100)}%`,
      });
      parts.append(chip);
    }
    row.append(parts);
  }

  return row;
}

/** 시장 심리 한 줄. 캔들·수급과 성질이 또 달라 따로 보여준다. */
function sentimentRow(coin, evaluation) {
  const sentiment = evaluation?.sentiment;
  const row = el('div', 'flow-row sentiment-row');
  row.append(el('span', 'flow-title', sentimentCategory().label));

  for (const indicator of sentiment?.indicators ?? []) {
    // 공포탐욕지수는 바로 위 탐욕지수 줄이 더 풍부하게 보여준다. 같은 숫자를
    // 두 번 찍지 않는다. 점수 기여도는 그쪽 툴팁에 적는다.
    if (indicator.key === 'fearGreed') continue;

    const item = el('span', `flow-item ${toneOf(indicator.score)}`);
    item.append(el('span', 'flow-label', indicator.label));
    item.append(el('span', 'flow-value', indicator.available ? indicator.display : '없음'));
    attachHelp(item, `ind:${indicator.key}`, {
      id: `sentiment:${coin}:${indicator.key}`,
      live: indicator.available
        ? `지금 ${indicator.display} · ${indicator.verdict} (${formatScore(indicator.score)}점)`
        : '데이터를 받지 못했습니다',
    });
    row.append(item);
  }

  return row;
}

// ── 차트 ─────────────────────────────────────────────────────

function renderTabs() {
  const exchanges = document.createDocumentFragment();
  for (const exchange of EXCHANGES.filter((e) => e.browserRest !== false)) {
    const tab = el('button', 'tab', exchange.name);
    tab.type = 'button';
    tab.dataset.exchange = exchange.id;
    tab.setAttribute('role', 'tab');
    const active = state.selectedExchange === exchange.id;
    tab.setAttribute('aria-selected', String(active));
    if (active) tab.classList.add('active');
    exchanges.append(tab);
  }
  dom.exchangeTabs.replaceChildren(exchanges);

  const timeframes = document.createDocumentFragment();
  for (const timeframe of TIMEFRAMES) {
    const tab = el('button', 'tab', timeframe.label);
    tab.type = 'button';
    tab.dataset.timeframe = timeframe.key;
    tab.setAttribute('role', 'tab');
    const active = state.chartTimeframe === timeframe.key;
    tab.setAttribute('aria-selected', String(active));
    if (active) tab.classList.add('active');
    timeframes.append(tab);
  }
  dom.timeframeTabs.replaceChildren(timeframes);

  const subs = document.createDocumentFragment();
  for (const panel of SUB_PANELS) {
    const tab = el('button', 'tab', panel.label);
    tab.type = 'button';
    tab.dataset.sub = panel.key;
    tab.setAttribute('role', 'tab');
    const active = state.subPanel === panel.key;
    tab.setAttribute('aria-selected', String(active));
    if (active) tab.classList.add('active');
    subs.append(tab);
  }
  dom.subTabs.replaceChildren(subs);

  const periods = document.createDocumentFragment();
  for (const period of CHART_PERIODS) {
    const tab = el('button', 'tab', period.label);
    tab.type = 'button';
    tab.dataset.period = period.key;
    tab.setAttribute('role', 'tab');
    const active = state.chartPeriod === period.key;
    tab.setAttribute('aria-selected', String(active));
    if (active) tab.classList.add('active');
    periods.append(tab);
  }
  dom.periodTabs.replaceChildren(periods);

  const toggles = document.createDocumentFragment();
  for (const category of PATTERN_CATEGORIES) {
    const label = el('label', 'pattern-toggle');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.pattern = category.key;
    input.checked = state.patternCategories.has(category.key);
    label.append(input, document.createTextNode(category.label));
    toggles.append(label);
  }
  dom.patternToggles.replaceChildren(toggles);
}

/** 서브차트로 띄울 수 있는 지표. 0~100 축이 아닌 MACD 는 자체 축척을 쓴다. */
const SUB_PANELS = [
  { key: 'rsi', label: 'RSI' },
  { key: 'macd', label: 'MACD' },
  { key: 'stochastic', label: '스토캐스틱' },
];

/**
 * 차트 조회 기간. live 는 지금처럼 30초마다 도는 실시간 캔들(최근 CHART_BARS 개)을
 * 그대로 쓰고, 나머지는 선택하는 순간 그 기간만큼 일봉을 별도로 받아온다 —
 * 실시간 폴링에 얹지 않는 이유는 loadPeriodCandles 주석 참고.
 */
const CHART_PERIODS = [
  { key: 'live', label: '실시간' },
  { key: 'month', label: '1개월', days: 30 },
  { key: 'half', label: '6개월', days: 182 },
  { key: 'year', label: '1년', days: 365 },
  { key: 'y2', label: '2년', days: 730 },
  { key: 'y3', label: '3년', days: 1095 },
];

/**
 * 참고용 차트선 네 갈래. 기본은 전부 꺼져 있다 — patterns.js 상단 주석대로
 * 반전/지속 패턴은 판정 경계가 흐릿해서, 사용자가 의도적으로 켜야 보이게 했다.
 */
const PATTERN_CATEGORIES = [
  { key: 'lines', label: '라인형' },
  { key: 'volume', label: '거래량' },
  { key: 'reversal', label: '반전' },
  { key: 'continuation', label: '지속' },
];

function renderChartPanel() {
  const exchange = exchangeOf(state.selectedExchange);
  const price = state.tickers[exchange.id]?.get(state.selectedCoin)?.price;

  dom.chartTitle.textContent = `${state.selectedCoin}/${exchange.quote}`;
  renderTabs();

  const periodSpec = CHART_PERIODS.find((p) => p.key === state.chartPeriod);
  const periodActive = Boolean(periodSpec?.days);
  const periodReady =
    periodActive &&
    state.periodCandles?.exchange === exchange.id &&
    state.periodCandles?.coin === state.selectedCoin &&
    state.periodCandles?.period === state.chartPeriod;

  if (periodActive && !periodReady) {
    dom.chart.textContent = '';
    const message = document.createElement('p');
    message.className = 'chart-empty';
    message.textContent = state.periodLoading
      ? `${periodSpec.label} 캔들을 불러오는 중…`
      : (state.periodError ?? `${periodSpec.label} 캔들을 불러오지 못했습니다.`);
    dom.chart.append(message);
    return;
  }

  const candles = periodReady
    ? state.periodCandles.candles
    : withLivePrice(
        state.candles[exchange.id]?.[state.selectedCoin]?.[state.chartTimeframe] ?? null,
        price,
      );

  // 줌 상한은 '지금 실제로 갖고 있는 캔들 개수' — zoomChart 가 이 값을 기준으로 확대/축소한다.
  state.chartMaxBars = candles?.length || CHART_BARS;
  const bars = state.chartZoomBars
    ? Math.min(state.chartZoomBars, state.chartMaxBars)
    : periodReady
      ? candles.length
      : null;

  renderChart(dom.chart, {
    candles,
    timeframeKey: periodReady ? 'day' : state.chartTimeframe,
    quote: exchange.quote,
    subPanel: state.subPanel,
    bars,
    patternCategories: state.patternCategories,
  });
  updateZoomControls(bars);

  if (periodReady) {
    const note = document.createElement('p');
    note.className = 'chart-period-note';
    note.textContent =
      candles.length < periodSpec.days
        ? `${exchange.name} 는 한 번에 최근 캔들 ${candles.length}개까지만 내줍니다 — ${periodSpec.label} 전체가 아닙니다.`
        : `${periodSpec.label} 일봉 ${candles.length}개 · ${exchange.name} 기준 · 이 조회는 실시간으로 갱신되지 않습니다.`;
    dom.chart.append(note);
  }
}

// ── 차트 확대/축소 ───────────────────────────────────────────

const MIN_ZOOM_BARS = 15;

/** 캔들 하나가 4px 밑으로 내려가는 좁은 화면에서는 45봉이 기본이다(chart.js 와 동일 기준). */
function defaultVisibleBars() {
  const width = dom.chart.clientWidth || 720;
  return width < 520 ? 45 : CHART_BARS;
}

/**
 * factor<1 이면 확대(봉이 줄어 하나하나 커짐), factor>1 이면 축소(봉이 늘어 넓게 보임).
 * 상한은 지금 실제로 들고 있는 캔들 개수(state.chartMaxBars) — 없는 데이터를
 * 확대해서 그릴 수는 없다.
 */
function zoomChart(factor) {
  const maxBars = state.chartMaxBars || CHART_BARS;
  const base = state.chartZoomBars ?? Math.min(maxBars, defaultVisibleBars());
  const next = Math.max(MIN_ZOOM_BARS, Math.min(maxBars, Math.round(base * factor)));
  if (next === state.chartZoomBars) return;
  state.chartZoomBars = next;
  renderChartPanel();
}

function resetZoom() {
  if (state.chartZoomBars === null) return;
  state.chartZoomBars = null;
  renderChartPanel();
}

function updateZoomControls(shownBars) {
  const shown = shownBars ?? Math.min(state.chartMaxBars, defaultVisibleBars());
  dom.zoomLevel.textContent = `${shown}봉`;
  dom.zoomIn.disabled = shown <= MIN_ZOOM_BARS;
  dom.zoomOut.disabled = shown >= state.chartMaxBars;
  dom.zoomReset.disabled = state.chartZoomBars === null;
}

/**
 * 기간 선택 시에만 별도로 긴 일봉 히스토리를 받아온다. 실시간 30초 폴링
 * (state.candles)에 그대로 얹지 않는 이유는, 크라켄처럼 이미 한도가 빠듯한
 * 거래소까지 매 주기 긴 요청을 반복하면 그쪽부터 막히기 때문이다 — 그래서
 * 별도 REST 한 번으로 끝낸다.
 *
 * 거래소마다 한 번에 주는 캔들 상한이 다르다(업비트는 최대 200개, 어떤
 * 어댑터는 count 인수 자체를 무시하고 자체 상한만큼만 준다). 여기서 페이지네이션
 * 으로 흉내내 늘리지 않고, 실제로 돌아온 개수를 그대로 쓰고 화면에도 그
 * 개수를 밝힌다(renderChartPanel 의 chart-period-note) — 조용히 자르는
 * 것보다 정직한 쪽을 택했다.
 */
async function loadPeriodCandles(period) {
  const spec = CHART_PERIODS.find((p) => p.key === period);
  state.chartPeriod = period;

  if (!spec?.days) {
    state.periodCandles = null;
    state.periodError = null;
    renderChartPanel();
    return;
  }

  const exchange = exchangeOf(state.selectedExchange);
  const coin = state.selectedCoin;
  state.periodLoading = true;
  state.periodError = null;
  renderChartPanel();

  try {
    const candles = await exchange.fetchCandles(coin, 'day', spec.days);
    state.periodCandles = { exchange: exchange.id, coin, period, candles };
  } catch (error) {
    state.periodCandles = null;
    state.periodError = `${exchange.name} 기간 데이터를 받지 못했습니다: ${error?.message ?? '알 수 없는 오류'}`;
  } finally {
    state.periodLoading = false;
    renderChartPanel();
  }
}

// ── 거래소 × 봉 주기 격자 ────────────────────────────────────

function renderGrid() {
  const evaluation = state.evaluations[state.selectedCoin];

  const table = el('table', 'grid-table');
  table.append(
    el('caption', null, `${coinName(state.selectedCoin)} 거래소별 봉 주기 점수`),
  );

  const head = el('thead');
  const headRow = el('tr');
  for (const label of ['거래소', ...TIMEFRAMES.map((t) => t.label), '거래소 점수', '현재가']) {
    const th = el('th', null, label);
    th.scope = 'col';
    headRow.append(th);
  }
  head.append(headRow);
  table.append(head);

  const body = el('tbody');
  for (const exchange of EXCHANGES) {
    const result = evaluation?.byExchange?.[exchange.id];
    const row = el('tr');
    if (exchange.id === state.selectedExchange) row.classList.add('selected');

    const name = el('th');
    name.scope = 'row';
    name.append(el('span', `grid-swatch tick-${exchange.id}`));
    name.append(el('span', 'grid-name', exchange.name));
    name.append(el('span', 'grid-quote', exchange.quote));
    if (exchange.note) name.title = `${exchange.name} — ${exchange.note}`;
    row.append(name);

    if (exchange.browserRest === false) {
      /*
       * 빈 칸을 네 개 늘어놓으면 고장으로 보인다. 왜 점수가 없는지 한 칸에
       * 적는 편이 정직하고 읽기도 쉽다.
       */
      const reason = el('td', 'grid-unavailable');
      reason.colSpan = TIMEFRAMES.length + 1;
      reason.textContent = `시세 전용 — ${exchange.note}`;
      row.append(reason);
    } else {
      for (const timeframe of TIMEFRAMES) {
        const score = result?.byTimeframe?.[timeframe.key]?.score ?? null;
        const grade = result?.byTimeframe?.[timeframe.key]?.grade ?? gradeOf(null);
        const cell = el('td', `grid-cell ${toneOf(score)}`);
        cell.append(el('span', 'grid-score', formatScore(score)));
        cell.append(el('span', 'grid-grade', grade.label));
        row.append(cell);
      }

      const total = el('td', `grid-cell total ${toneOf(result?.score ?? null)}`);
      total.append(el('span', 'grid-score', formatScore(result?.score ?? null)));
      total.append(el('span', 'grid-grade', (result?.grade ?? gradeOf(null)).label));
      row.append(total);
    }

    // 시세는 거래소마다 견적 통화가 다르므로 단위를 함께 적는다.
    const ticker = state.tickers[exchange.id]?.get(state.selectedCoin);
    const price = el('td', 'grid-price');
    price.append(
      el('span', 'grid-price-value', ticker ? formatPrice(ticker.price, exchange.quote) : '—'),
    );
    price.append(el('span', 'grid-price-unit', exchange.quote === 'KRW' ? '원' : exchange.quote));
    row.append(price);

    body.append(row);
  }
  table.append(body);

  const foot = el('tfoot');
  const footRow = el('tr');
  const footLabel = el('th', null, '시그널 점수');
  footLabel.scope = 'row';
  footRow.append(footLabel);

  // 종합 점수가 '거래소 점수' 열 아래에 정렬되도록 칸 수를 맞춘다.
  const spacer = el('td', 'grid-note');
  spacer.colSpan = TIMEFRAMES.length;
  spacer.textContent = evaluation?.consensus?.total
    ? `거래소 ${evaluation.consensus.total}곳 등가중 평균 · 합의 ${evaluation.consensus.agree}/${evaluation.consensus.total} ${evaluation.consensus.label}`
    : '데이터 없음';
  footRow.append(spacer);

  const combined = el('td', `grid-cell total ${toneOf(evaluation?.consensus?.score ?? null)}`);
  combined.append(el('span', 'grid-score', formatScore(evaluation?.consensus?.score ?? null)));
  combined.append(el('span', 'grid-grade', (evaluation?.grade ?? gradeOf(null)).label));
  footRow.append(combined, el('td', 'grid-price'));

  foot.append(footRow);
  table.append(foot);

  dom.grid.replaceChildren(table);
}

// ── 지표 상세 ────────────────────────────────────────────────

function renderDetail() {
  const exchange = exchangeOf(state.selectedExchange);
  const evaluation = state.evaluations[state.selectedCoin];
  const result = evaluation?.byExchange?.[exchange.id];

  dom.detailTitle.textContent = `지표 상세 · ${coinName(state.selectedCoin)} · ${exchange.name}`;

  const table = el('table', 'matrix');

  const head = el('thead');
  const headRow = el('tr');
  for (const label of ['지표', '가중']) {
    const th = el('th', null, label);
    th.scope = 'col';
    headRow.append(th);
  }
  // 봉 주기 열은 주기마다 비중과 주의사항이 달라 설명을 따로 붙인다.
  for (const timeframe of TIMEFRAMES) {
    const th = el('th', null, timeframe.label);
    th.scope = 'col';
    const score = result?.byTimeframe?.[timeframe.key]?.score ?? null;
    attachHelp(th, `tf:${timeframe.key}`, {
      id: `detail:tf:${timeframe.key}`,
      live: `${exchange.name} ${timeframe.label} ${formatScore(score)}점`,
    });
    headRow.append(th);
  }
  head.append(headRow);
  table.append(head);

  const body = el('tbody');

  TEMPLATE.categories.forEach((template, categoryIndex) => {
    body.append(categoryRow(template, result, categoryIndex));

    template.indicators.forEach((indicatorTemplate, indicatorIndex) => {
      const row = el('tr', 'indicator-row');
      const name = el('th', null, indicatorTemplate.label);
      name.scope = 'row';
      attachHelp(name, `ind:${indicatorTemplate.key}`, {
        id: `detail:ind:${indicatorTemplate.key}`,
      });
      row.append(name, el('td', 'weight', ''));

      for (const timeframe of TIMEFRAMES) {
        const indicator =
          result?.byTimeframe?.[timeframe.key]?.categories?.[categoryIndex]?.indicators?.[
            indicatorIndex
          ];
        row.append(matrixCell(indicator));
      }
      body.append(row);
    });
  });

  // 봉 주기가 없는 카테고리는 칸을 합쳐 한 줄로 적는다.
  body.append(externalSection(evaluation?.flow, flowCategory(), '업비트 호가·체결 기준'));
  body.append(
    externalSection(evaluation?.sentiment, sentimentCategory(), '뉴스·심리 · 5분마다 갱신'),
  );

  table.append(body);

  const foot = el('tfoot');
  const footRow = el('tr');
  const footLabel = el('th', null, '봉 주기 점수');
  footLabel.scope = 'row';
  footRow.append(footLabel, el('td', 'weight', '가중 평균'));

  for (const timeframe of TIMEFRAMES) {
    const timeframeResult = result?.byTimeframe?.[timeframe.key];
    const score = timeframeResult?.score ?? null;
    const grade = timeframeResult?.grade ?? gradeOf(null);

    const cell = el('td', `cell total ${toneOf(score)}`);
    cell.append(el('span', 'cell-total-score', formatScore(score)));
    cell.append(
      el('span', 'cell-verdict', `${grade.label} · 비중 ${Math.round(timeframe.weight * 100)}%`),
    );
    footRow.append(cell);
  }
  foot.append(footRow);
  table.append(foot);

  dom.detail.replaceChildren(table);
}

/**
 * 카테고리 머리 행. 봉 주기마다 ADX 국면이 다를 수 있으므로 조정된 가중을
 * 주기별로 보여준다 — 같은 지표가 왜 주기마다 다른 무게를 갖는지 드러난다.
 */
function categoryRow(template, result, categoryIndex) {
  const row = el('tr', 'category-row');

  const name = el('th', null, template.label);
  name.scope = 'row';
  attachHelp(name, `cat:${template.key}`, { id: `detail:cat:${template.key}` });
  row.append(name, el('td', 'weight', `×${template.weight}`));

  for (const timeframe of TIMEFRAMES) {
    const category = result?.byTimeframe?.[timeframe.key]?.categories?.[categoryIndex];
    const regime = result?.byTimeframe?.[timeframe.key]?.regime;
    const cell = el('td', `cell category ${toneOf(category?.score ?? null)}`);

    cell.append(el('span', 'cell-category-score', formatScore(category?.score ?? null)));

    const adjust = category?.adjust ?? 1;
    if (adjust !== 1) {
      const badge = el('span', `adjust ${adjust > 1 ? 'up' : 'down'}`, `×${adjust}`);
      attachHelp(badge, 'screen:regime', {
        id: `detail:regime:${template.key}:${timeframe.key}`,
        live: `${timeframe.label} ${regime?.label ?? '판정 불가'} — ${template.label} 가중을 ×${adjust} 로 ${adjust > 1 ? '키웠' : '줄였'}습니다`,
      });
      cell.append(badge);
    }
    row.append(cell);
  }

  return row;
}

/**
 * 봉 주기가 없는 카테고리(실시간 수급·시장 심리) 한 행.
 * 봉 주기 칸을 합쳐 지표 칩을 늘어놓는다.
 */
function externalSection(result, category, note) {
  const row = el('tr', `category-row external ${category.key}`);

  const name = el('th', null, category.label);
  name.scope = 'row';
  attachHelp(name, `cat:${category.key}`, {
    id: `detail:cat:${category.key}`,
    live: `이 종목 ${formatScore(result?.score ?? null)}점`,
  });
  row.append(name, el('td', 'weight', `×${category.weight}`));

  const cell = el('td', 'cell flow-cell');
  cell.colSpan = TIMEFRAMES.length;

  if (!result?.indicators?.length) {
    cell.append(el('span', 'cell-verdict', '데이터 대기 중'));
  } else {
    for (const indicator of result.indicators) {
      const item = el('span', `flow-chip ${toneOf(indicator.score)}`);
      item.append(el('span', 'flow-chip-label', indicator.label));
      item.append(el('span', 'flow-chip-value', indicator.available ? indicator.display : '없음'));
      item.append(
        el('span', 'flow-chip-score', indicator.available ? formatScore(indicator.score) : '—'),
      );
      attachHelp(item, `ind:${indicator.key}`, {
        id: `detail:ext:${indicator.key}`,
        live: indicator.available
          ? `지금 ${indicator.display} · ${indicator.verdict} (${formatScore(indicator.score)}점)`
          : indicator.display,
      });
      cell.append(item);
    }
    cell.append(el('span', 'flow-note', `${note} · 봉 주기 무관`));
  }

  row.append(cell);
  return row;
}

function matrixCell(indicator) {
  if (!indicator) {
    const cell = el('td', 'cell flat');
    cell.append(el('span', 'cell-verdict', '데이터 없음'));
    return cell;
  }

  const cell = el('td', `cell ${toneOf(indicator.score)}`);
  cell.append(el('span', 'cell-verdict', indicator.verdict));
  cell.append(el('span', 'cell-value', indicator.display));
  cell.append(el('span', 'cell-score', indicator.available ? formatScore(indicator.score) : '—'));
  return cell;
}

// ── 전환 기록 ────────────────────────────────────────────────

function renderTransitions() {
  const entries = transitions.entries();
  dom.transitionsClear.hidden = entries.length === 0;

  if (!entries.length) {
    dom.transitions.replaceChildren(
      el('p', 'empty', '등급이 바뀌면 여기에 쌓입니다. 화면을 계속 보지 않아도 됩니다.'),
    );
    return;
  }

  const list = el('ol', 'timeline');
  for (const record of entries) {
    const item = el('li', 'timeline-item');

    item.append(el('span', 'timeline-time', formatClock(new Date(record.at))));

    const body = el('div', 'timeline-body');
    const headline = el('div', 'timeline-headline');
    headline.append(el('strong', null, record.coin));
    headline.append(el('span', `tone-${record.from.key}`, record.from.label));
    headline.append(el('span', 'timeline-arrow', '→'));
    headline.append(el('span', `tone-${record.to.key}`, record.to.label));
    headline.append(el('span', 'timeline-score', `${formatScore(record.score)}점`));
    body.append(headline);

    if (record.reasons.length) {
      const reasons = record.reasons
        .map((reason) => `${reason.label} ${reason.verdict}`)
        .join(' · ');
      body.append(el('div', 'timeline-reasons', reasons));
    }

    item.append(body);
    list.append(item);
  }

  dom.transitions.replaceChildren(list);
}

// ── 뉴스 패널 ────────────────────────────────────────────────

/**
 * 매칭된 헤드라인을 그대로 보여준다.
 *
 * 키워드 감성은 문맥을 오해할 수 있으므로 점수만 내놓으면 검증할 방법이 없다.
 * 어떤 단어가 걸려서 그 점수가 나왔는지 드러내면 사용자가 직접 판단할 수 있다.
 * 뉴스 반영의 실질적 가치는 이 패널에 있다.
 */
function renderNews() {
  const { articles, fetchedAt, failures } = sentimentTracker.news();
  const selected = state.selectedCoin;

  dom.newsTitle.textContent = fetchedAt
    ? `코인 뉴스 · ${formatClock(new Date(fetchedAt))} 기준`
    : '코인 뉴스';

  if (!articles.length) {
    dom.news.replaceChildren(
      el(
        'p',
        'empty',
        state.newsError ??
          '뉴스를 받으려면 `python3 serve.py` 로 띄워야 합니다. RSS 는 CORS 를 열어주지 않아 브라우저가 직접 읽을 수 없습니다.',
      ),
    );
    return;
  }

  // 선택 종목이 언급된 기사를 위로 올린다. 나머지는 최신순을 유지한다.
  const scored = articles.map((article) => ({
    article,
    mentions: coinsMentioned(article.title, state.coins),
    ...scoreArticle(article),
  }));
  scored.sort((a, b) => {
    const aHit = a.mentions.includes(selected) ? 1 : 0;
    const bHit = b.mentions.includes(selected) ? 1 : 0;
    if (aHit !== bHit) return bHit - aHit;
    return (b.article.at ?? 0) - (a.article.at ?? 0);
  });

  const list = el('ol', 'news-list');
  for (const item of scored.slice(0, 30)) {
    const entry = el('li', `news-item ${toneOf(item.score)}`);

    const meta = el('div', 'news-meta');
    meta.append(el('span', 'news-time', item.article.at ? formatClock(new Date(item.article.at)) : '—'));
    meta.append(el('span', 'news-source', item.article.source));
    for (const coin of item.mentions) {
      meta.append(el('span', `news-coin${coin === selected ? ' current' : ''}`, coin));
    }
    if (item.matches.length) {
      meta.append(el('span', 'news-score', formatScore(item.score)));
    }
    entry.append(meta);

    const title = el('a', 'news-title', item.article.title);
    title.href = item.article.link || '#';
    title.target = '_blank';
    title.rel = 'noopener noreferrer';
    entry.append(title);

    if (item.matches.length) {
      const words = el('div', 'news-words');
      for (const match of item.matches) {
        words.append(el('span', `news-word ${match.weight > 0 ? 'buyish' : 'sellish'}`, match.word));
      }
      entry.append(words);
    }

    list.append(entry);
  }

  const children = [list];
  if (failures?.length) {
    children.push(
      el('p', 'panel-hint', `일부 매체를 불러오지 못했습니다 — ${failures.map((f) => f.source).join(', ')}`),
    );
  }
  dom.news.replaceChildren(...children);
}

// ── 종목 선택 패널 ───────────────────────────────────────────

/**
 * 시그널 읽는 법. 접이식이라 평소 화면을 밀어내지 않는다.
 *
 * 등급 구간·카테고리 가중은 config 에서 그대로 읽어 만든다. 문구에 숫자를
 * 적어 두면 기준을 바꿨을 때 설명만 옛 값으로 남는다.
 */
function renderHelpPanel() {
  dom.help.hidden = !state.helpOpen;
  dom.helpToggle.setAttribute('aria-expanded', String(state.helpOpen));
  if (!state.helpOpen) return;

  const t = GRADE_THRESHOLDS;
  // 화면 다른 곳과 같은 진짜 빼기 기호(−)를 쓴다. ASCII 하이픈은 폭이 달라 표가 흔들린다.
  const point = (value) => (value < 0 ? `−${Math.abs(value)}` : `+${value}`);
  const bands = [
    { grade: GRADES.strongBuy, range: `${point(t.strongBuy)}점 이상` },
    { grade: GRADES.buy, range: `${point(t.buy)} ~ ${point(t.strongBuy)}점` },
    { grade: GRADES.neutral, range: `${point(t.sell)} ~ ${point(t.buy)}점` },
    { grade: GRADES.sell, range: `${point(t.strongSell)} ~ ${point(t.sell)}점` },
    { grade: GRADES.strongSell, range: `${point(t.strongSell)}점 이하` },
  ];

  const grades = el('div', 'help-grades');
  for (const band of bands) {
    const row = el('div', 'help-grade-row');
    row.append(
      el('span', `grade grade-${band.grade.key}`, band.grade.label),
      el('span', 'help-grade-range', band.range),
      el('span', 'help-grade-action', actionOf(band.grade)),
    );
    grades.append(row);
  }

  const weights = el('ul', 'help-weights');
  for (const category of CATEGORIES) {
    const item = el('li');
    item.append(
      el('span', 'help-weight-label', category.label),
      el('span', 'help-weight-value', `가중 ${category.weight}`),
      el('span', 'help-weight-note', category.indicators.length + '개 지표'),
    );
    weights.append(item);
  }

  const section = (title, ...children) => {
    const node = el('section', 'help-section');
    node.append(el('h3', null, title));
    node.append(...children);
    return node;
  };

  const paragraph = (text) => el('p', null, text);

  dom.help.replaceChildren(
    section('등급이 뜻하는 것', grades, paragraph(
      `점수는 −100 ~ +100 입니다. 경계값은 중립이 아니라 행동 쪽에 붙습니다 — 정확히 ${point(t.buy)}이면 매수, ${point(t.sell)}이면 매도, ${point(t.strongBuy)}이면 강력매수입니다. 경계에 걸친 점수를 '신호 없음'으로 버리지 않기 위해서입니다.`,
    )),

    section(
      '가격이 크게 올랐는데 왜 매수가 아닌가요?',
      paragraph(
        '이 화면은 "올랐나?"가 아니라 "지금 사도 되나?"를 잽니다. 그래서 많이 오를수록 지금 진입은 오히려 불리하게 잡힙니다.',
      ),
      paragraph(
        '크게 오르면 추세 지표(이동평균·MACD·ADX)는 강한 매수를 가리키지만, 같은 상승이 모멘텀 지표를 과매수(RSI 70 이상)로, 변동성 지표를 볼린저 상단 이탈로 밀어 올립니다. 둘이 서로 상쇄되면 합계는 중립 근처에 머뭅니다.',
      ),
      paragraph(
        '카드의 「왜 이 등급인가」 막대가 그 상쇄를 그대로 보여줍니다. 오른쪽으로 뻗은 막대가 매수 힘, 왼쪽이 매도 힘이고 길이는 가중까지 반영한 크기입니다.',
      ),
      paragraph(
        `점수 옆의 '${'↑'} 매수까지 N점'은 다음 등급 경계까지 남은 거리입니다. ${t.buy - 0.1}점과 0점은 둘 다 중립이지만 뜻이 전혀 다릅니다.`,
      ),
    ),

    section(
      '시그널 점수와 합의도는 다른 값입니다',
      paragraph(
        '점수는 거래소들의 등가중 평균이고, 합의도는 거래소들이 서로 같은 방향을 가리키는 정도입니다. "점수 +18 중립 · 합의 4/6 매수 우세"는 모순이 아니라 그대로 읽으면 되는 상태입니다.',
      ),
      paragraph(
        '합의도는 거래소들의 캔들 판정만 셉니다. 실시간 수급은 업비트 단독 신호라 애초에 거래소 간 합의에 참여할 수 없습니다.',
      ),
    ),

    section(
      '카테고리와 가중',
      weights,
      paragraph(
        '카테고리 안에서는 단순 평균, 카테고리 사이에만 가중을 둡니다. 서로 닮은 지표가 같은 근거를 여러 번 세지 않게 하기 위해서입니다.',
      ),
      paragraph(
        'ADX가 국면을 판별해 가중을 자동 조정합니다 — 추세장에서는 추세 ×1.5 · 모멘텀 ×0.7, 횡보장에서는 추세 ×0.6 · 모멘텀 ×1.3. 추세장의 과매수는 "비싸다"가 아니라 "계속 오른다"는 뜻이기 때문입니다. 카드 막대의 가중에는 이 조정이 이미 반영돼 있습니다.',
      ),
    ),

    section(
      '이것으로 알 수 없는 것',
      paragraph(
        '진입·청산 시점, 목표가, 손절가를 알려주지 않습니다. 공개 시장 데이터에 기술적 지표를 적용한 계산 결과일 뿐이며 미래 가격을 예측하지 않습니다.',
      ),
    ),
  );
}

function renderCoinPanel() {
  dom.panel.hidden = !state.panelOpen;
  dom.panelToggle.setAttribute('aria-expanded', String(state.panelOpen));
  dom.panelToggle.textContent = `종목 ${state.coins.length}/${selection.max}`;
  if (!state.panelOpen) return;

  const chips = el('div', 'chosen');
  for (const coin of state.coins) {
    const chip = el('button', 'chosen-chip');
    chip.type = 'button';
    chip.dataset.remove = coin.id;
    chip.append(el('span', null, `${coin.name} ${coin.id}`), el('span', 'chip-x', '×'));
    chips.append(chip);
  }

  const results = el('ul', 'catalog');
  const matches = searchCatalog(state.catalog, state.catalogQuery).slice(0, 60);

  if (!state.catalog.length) {
    results.append(el('li', 'catalog-empty', '업비트 종목 목록을 불러오는 중입니다…'));
  } else if (!matches.length) {
    results.append(el('li', 'catalog-empty', '검색 결과가 없습니다'));
  }

  for (const market of matches) {
    const item = el('li');
    const button = el('button', 'catalog-item');
    button.type = 'button';
    button.dataset.add = market.id;
    button.disabled = selection.has(market.id) || (selection.isFull() && !selection.has(market.id));

    button.append(el('span', 'catalog-name', market.name));
    button.append(el('span', 'catalog-id', market.id));
    if (market.warning) {
      const warn = el('span', 'catalog-warning', '투자주의');
      warn.title = '업비트가 투자주의를 지정한 종목입니다';
      button.append(warn);
    }
    if (selection.has(market.id)) button.append(el('span', 'catalog-added', '담김'));

    item.append(button);
    results.append(item);
  }

  const reset = el('button', 'panel-reset', '기본 종목으로 되돌리기');
  reset.type = 'button';
  reset.dataset.reset = 'true';

  const hint = el('p', 'panel-hint');
  hint.textContent = selection.isFull()
    ? `최대 ${selection.max}종목입니다. 거래소 ${EXCHANGES.length}곳 × 봉 주기 3개를 30초마다 갱신하므로 그 이상은 갱신이 밀립니다.`
    : `업비트 KRW 마켓 ${state.catalog.length}종목에서 고를 수 있습니다.`;

  const footer = el('div', 'panel-footer');
  footer.append(hint, reset);

  /*
   * dom.search 는 같은 노드를 재사용하지만, replaceChildren 은 기존 자식을
   * 전부 뜯어낸 뒤 다시 붙인다 — 그 순간 포커스가 있던 입력창도 blur 된다.
   * 타이핑마다 이 함수가 다시 불리므로(input 이벤트), 그대로 두면 글자
   * 하나 칠 때마다 포커스가 끊긴다. 그려 넣기 전에 상태를 적어 두고 뒤에
   * 복원한다.
   */
  const typing = document.activeElement === dom.search;
  const caretStart = dom.search.selectionStart;
  const caretEnd = dom.search.selectionEnd;

  dom.panel.replaceChildren(chips, dom.search, results, footer);

  if (typing) {
    dom.search.focus({ preventScroll: true });
    dom.search.setSelectionRange(caretStart, caretEnd);
  }
}

// ── 렌더 스케줄 ──────────────────────────────────────────────

/**
 * 체결은 초당 수십 건까지 몰릴 수 있다. 틱마다 27개 조합을 재계산하고 DOM 을
 * 다시 만들면 화면이 멈춘다. 무거운 작업은 주기를 나눠 묶는다.
 */
function throttle(fn, ms) {
  let queued = false;
  let last = 0;

  return () => {
    if (queued) return;
    queued = true;
    const wait = Math.max(0, ms - (Date.now() - last));
    setTimeout(() => {
      queued = false;
      last = Date.now();
      fn();
    }, wait);
  };
}

const refreshSignals = throttle(() => {
  if (!state.ready) return;
  recompute();
  renderCards();
  renderGrid();
  renderDetail();
  renderTransitions();
  renderHeader();
  renderBanner();
}, REALTIME.recomputeMs);

const refreshChart = throttle(() => {
  if (state.ready) renderChartPanel();
}, REALTIME.chartMs);

function refreshAll() {
  recompute();
  renderCards();
  renderChartPanel();
  renderGrid();
  renderDetail();
  renderTransitions();
  renderNews();
  renderHeader();
  renderBanner();
  renderCoinPanel();
}

// ── 데이터 ───────────────────────────────────────────────────

function onTick(ticker) {
  state.tickers[ticker.exchange]?.set(ticker.coin, ticker);
  state.lastTickAt = new Date();
  refreshSignals();
  refreshChart();
}

/*
 * 호가와 체결은 티커보다 훨씬 자주 온다. 여기서 렌더를 부르지 않고 상태만
 * 갱신하고, 화면은 refreshSignals 의 400ms 주기가 따라잡게 둔다.
 */
function onOrderbook(book) {
  flowTracker.applyOrderbook(book);
  refreshSignals();
}

function onTrade(trade) {
  flowTracker.applyTrade(trade);
  refreshSignals();
}

function applyCandles(exchange, data) {
  for (const coin of coinIds()) {
    for (const timeframe of TIMEFRAMES) {
      const candles = data[coin]?.[timeframe.key];
      // 실패한 칸은 이전 캔들을 지우지 않고 그대로 둔다.
      if (!candles) continue;
      state.candles[exchange.id][coin] = state.candles[exchange.id][coin] ?? {};
      state.candles[exchange.id][coin][timeframe.key] = candles;
    }
  }
}

/**
 * 거래소끼리는 병렬로, 한 거래소 안에서는 직렬로 캔들을 가져온다.
 *
 * 도착한 거래소를 **그때그때 반영**한다. Promise.all 로 전부 기다리면 화면이
 * 가장 느린 거래소에 묶인다 — 크라켄은 공개 API 한도 때문에 요청 간격을 600ms
 * 로 벌려야 해서 한 바퀴에 10초 가까이 걸린다. 거래소가 셋일 때는 2초라 눈에
 * 띄지 않던 문제가 일곱이 되면서 드러났다.
 */
async function loadCandles() {
  const failures = [];

  // 브라우저에서 REST 가 막힌 거래소는 애초에 요청하지 않는다.
  const fetchable = EXCHANGES.filter((exchange) => exchange.browserRest !== false);

  await Promise.all(
    fetchable.map(async (exchange) => {
      try {
        const { data, failures: partial } = await exchange.fetchCandleSet(coinIds());
        applyCandles(exchange, data);
        failures.push(...partial);
      } catch (error) {
        failures.push({ exchange: exchange.id, message: error.message });
      }
      if (state.ready) refreshSignals();
    }),
  );

  state.notice = failures.length
    ? `캔들 ${failures.length}건을 불러오지 못했습니다 — ${failures[0].message}`
    : null;

  return failures;
}

/**
 * 뉴스·심리를 서버 중계로 가져온다.
 *
 * 두 엔드포인트가 없어도(순수 정적 서버로 띄운 경우) 조용히 실패하고 시장 심리
 * 카테고리만 빠진다. 나머지 화면은 그대로 동작해야 하므로 배너로 소란을 떨지
 * 않고 뉴스 패널에만 안내를 남긴다.
 */
async function loadSentiment() {
  const params = new URLSearchParams({ coins: coinIds().join(',') });

  const [news, sentiment] = await Promise.all([
    fetch(SENTIMENT_API.news)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .catch((error) => ({ error })),
    fetch(`${SENTIMENT_API.sentiment}?${params}`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .catch((error) => ({ error })),
  ]);

  if (news.error) {
    state.newsError = 'serve.py 로 띄우면 뉴스를 함께 볼 수 있습니다. 지금은 지표만 계산합니다.';
  } else {
    state.newsError = null;
    sentimentTracker.applyNews(news);
  }

  if (!sentiment.error) sentimentTracker.applySentiment(sentiment);
}

// ── 이벤트 ───────────────────────────────────────────────────

/**
 * 종목·거래소가 바뀌면 그 조합으로 받아둔 기간 캔들은 더 이상 맞지 않는다.
 * 자동으로 다시 받아오지 않고 실시간 보기로 되돌리는 이유는, 조회 기간이
 * 늘 때마다(최대 3년치) 종목을 넘길 때마다 REST 를 다시 부르면 캔들 전환이
 * 잦은 화면에서 호출이 눈에 안 띄게 누적되기 때문이다 — 기간 조회는 항상
 * 사용자가 탭을 눌러야 시작되게 한다.
 */
function resetChartPeriod() {
  state.chartPeriod = 'live';
  state.periodCandles = null;
  state.periodError = null;
  state.periodLoading = false;
}

function selectCoin(coin) {
  if (!coin || state.selectedCoin === coin) return;
  state.selectedCoin = coin;
  resetChartPeriod();
  renderCards();
  renderChartPanel();
  renderGrid();
  renderDetail();
  renderNews();
}

function selectExchange(id) {
  if (!id || state.selectedExchange === id) return;
  state.selectedExchange = id;
  resetChartPeriod();
  renderChartPanel();
  renderGrid();
  renderDetail();
}

/**
 * 종목 목록이 바뀌면 소켓 구독과 캔들을 모두 갈아야 한다. 순서가 중요하다 —
 * 먼저 구독을 바꿔 시세가 흐르게 하고, 캔들은 뒤에서 채운다. 캔들을 먼저
 * 기다리면 가장 느린 거래소(크라켄) 때문에 화면이 10초 넘게 멈춘다.
 */
async function applyCoinChange() {
  state.coins = selection.list();
  const ids = selection.ids();

  if (!ids.includes(state.selectedCoin)) state.selectedCoin = ids[0];

  // 빠진 종목의 누적 상태를 버린다. 안 그러면 다시 담았을 때 옛 체결이 섞인다.
  flowTracker.retain(ids);
  transitions.retain(ids);
  for (const exchange of EXCHANGES) {
    for (const key of Object.keys(state.candles[exchange.id])) {
      if (!ids.includes(key)) delete state.candles[exchange.id][key];
    }
    for (const key of [...state.tickers[exchange.id].keys()]) {
      if (!ids.includes(key) && key !== FX_ASSET) state.tickers[exchange.id].delete(key);
    }
  }

  realtime?.setCoins(ids);
  refreshAll();
  loadSentiment().then(refreshAll);
  await loadCandles();
  refreshAll();
}

function bindEvents() {
  dom.cards.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove]');
    if (remove) {
      // 카드 선택 이벤트로 번지지 않게 막는다.
      event.stopPropagation();
      const result = selection.remove(remove.dataset.remove);
      if (result.ok) applyCoinChange();
      else state.notice = result.reason;
      renderBanner();
      return;
    }

    const card = event.target.closest('.card');
    if (card) selectCoin(card.dataset.coin);
  });

  dom.pause.addEventListener('click', togglePause);

  dom.transitionsClear.addEventListener('click', () => {
    transitions.clear();
    renderTransitions();
  });

  dom.helpToggle.addEventListener('click', () => {
    state.helpOpen = !state.helpOpen;
    renderHelpPanel();
  });

  dom.panelToggle.addEventListener('click', async () => {
    state.panelOpen = !state.panelOpen;
    renderCoinPanel();

    if (state.panelOpen && !state.catalog.length) {
      try {
        state.catalog = await fetchCatalog();
      } catch (error) {
        state.notice = `종목 목록을 불러오지 못했습니다 — ${error.message}`;
        renderBanner();
      }
      renderCoinPanel();
    }
    if (state.panelOpen) dom.search.focus();
  });

  dom.panel.addEventListener('click', (event) => {
    const add = event.target.closest('[data-add]');
    if (add) {
      const market = state.catalog.find((item) => item.id === add.dataset.add);
      const result = market ? selection.add(market) : { ok: false, reason: '없는 종목입니다' };
      if (result.ok) applyCoinChange();
      else state.notice = result.reason;
      renderCoinPanel();
      renderBanner();
      return;
    }

    const remove = event.target.closest('[data-remove]');
    if (remove) {
      const result = selection.remove(remove.dataset.remove);
      if (result.ok) applyCoinChange();
      else state.notice = result.reason;
      renderCoinPanel();
      renderBanner();
      return;
    }

    if (event.target.closest('[data-reset]')) {
      selection.reset();
      applyCoinChange();
      renderCoinPanel();
    }
  });

  dom.cards.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const card = event.target.closest('.card');
    if (!card) return;
    event.preventDefault();
    selectCoin(card.dataset.coin);
  });

  dom.exchangeTabs.addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (tab) selectExchange(tab.dataset.exchange);
  });

  dom.timeframeTabs.addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (!tab) return;
    state.chartTimeframe = tab.dataset.timeframe;
    renderChartPanel();
  });

  dom.subTabs.addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (!tab) return;
    state.subPanel = tab.dataset.sub;
    renderChartPanel();
  });

  dom.periodTabs.addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (!tab || tab.dataset.period === state.chartPeriod) return;
    loadPeriodCandles(tab.dataset.period);
  });

  dom.patternToggles.addEventListener('change', (event) => {
    const input = event.target.closest('input[data-pattern]');
    if (!input) return;
    if (input.checked) state.patternCategories.add(input.dataset.pattern);
    else state.patternCategories.delete(input.dataset.pattern);
    renderChartPanel();
  });

  dom.zoomIn.addEventListener('click', () => zoomChart(0.75));
  dom.zoomOut.addEventListener('click', () => zoomChart(1.35));
  dom.zoomReset.addEventListener('click', resetZoom);

  // 차트 위에서 휠을 굴리면 확대/축소 — 페이지 스크롤은 차트 밖에서만 그대로 동작한다.
  dom.chart.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      zoomChart(event.deltaY < 0 ? 0.85 : 1.18);
    },
    { passive: false },
  );

  dom.grid.addEventListener('click', (event) => {
    const row = event.target.closest('tbody tr');
    if (!row) return;
    const index = [...row.parentElement.children].indexOf(row);
    const exchange = EXCHANGES[index];
    // 캔들이 없는 거래소를 고르면 차트와 지표 상세가 빈 화면이 된다.
    if (exchange && exchange.browserRest !== false) selectExchange(exchange.id);
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderChartPanel, 150);
  });
}

// ── 주기 작업 제어 ───────────────────────────────────────────

/**
 * 캔들·뉴스 주기 조회를 켠다. 이미 돌고 있으면 중복으로 걸지 않는다.
 * 탭이 숨겨졌거나 일시정지 상태면 아무것도 하지 않는다.
 */
function startPolling() {
  if (state.paused || state.hidden) return;

  if (!timers.candles) {
    timers.candles = setInterval(() => loadCandles().then(refreshAll), POLL.candleMs);
  }
  if (!timers.sentiment) {
    timers.sentiment = setInterval(() => loadSentiment().then(refreshAll), SENTIMENT_API.refreshMs);
  }
}

function stopPolling() {
  clearInterval(timers.candles);
  clearInterval(timers.sentiment);
  timers.candles = null;
  timers.sentiment = null;
}

/**
 * 탭이 보이지 않는 동안에는 캔들 조회를 멈춘다.
 *
 * 소켓은 그대로 둔다 — 끊으면 복귀할 때 7곳을 다시 연결하는 지연이 생기고,
 * 체결 누적이 비어 체결강도가 '표본 부족' 으로 떨어진다. 반면 캔들 조회는
 * 30초마다 54회라 백그라운드에서 계속 돌 이유가 없다.
 */
function onVisibilityChange() {
  state.hidden = document.visibilityState === 'hidden';

  if (state.hidden) {
    stopPolling();
    return;
  }
  // 돌아오면 밀린 캔들을 즉시 한 번 받고 주기를 재개한다.
  if (!state.paused) {
    loadCandles().then(refreshAll);
    startPolling();
  }
}

function togglePause() {
  state.paused = !state.paused;

  if (state.paused) {
    stopPolling();
    realtime?.stop();
    state.notice = '일시정지됨 — 화면의 값은 마지막 수신 시점 그대로입니다.';
  } else {
    state.notice = null;
    realtime?.start();
    loadCandles().then(refreshAll);
    loadSentiment().then(refreshAll);
    startPolling();
  }

  renderHeader();
  renderBanner();
}

// ── 시작 ─────────────────────────────────────────────────────

async function init() {
  bindEvents();
  // 설명 툴팁은 위임 방식이라 요소가 그려지기 전에 한 번만 붙이면 된다.
  initTooltips();
  dom.cards.replaceChildren(
    el('p', 'loading', `거래소 ${EXCHANGES.length}곳에 연결하는 중입니다…`),
  );
  renderHeader();

  /*
   * 소켓을 캔들보다 먼저 연다. 순서를 바꾸면 가장 느린 거래소의 캔들을 다 받을
   * 때까지 시세가 한 줄도 나오지 않는다.
   */
  realtime = createRealtime({
    exchanges: EXCHANGES,
    coins: coinIds(),
    onTick,
    onOrderbook,
    onTrade,
    onStatus: (exchangeId, status) => {
      state.status[exchangeId] = status;
      renderHeader();
    },
  });
  realtime.start();

  // 캔들이 없는 상태에서도 시세와 골격은 바로 보여준다. 지표는 '데이터 부족'이다.
  state.ready = true;
  refreshAll();

  // 뉴스는 캔들과 독립이므로 함께 기다리지 않는다. 늦게 도착해도 화면은 이미 있다.
  loadSentiment().then(refreshAll);

  await loadCandles();
  refreshAll();

  startPolling();
  // 낡음 배너는 갱신이 멈춘 동안에도 시간이 흐르는 것을 보여줘야 한다.
  timers.banner = setInterval(renderBanner, 1000);

  document.addEventListener('visibilitychange', onVisibilityChange);
  // 페이지를 떠날 때 소켓을 정리한다. 그러지 않으면 거래소 쪽에 연결이 남는다.
  window.addEventListener('pagehide', () => {
    stopPolling();
    clearInterval(timers.banner);
    realtime?.stop();
  });
}

init();
