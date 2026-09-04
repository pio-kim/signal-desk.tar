/**
 * SVG 캔들차트 렌더러. 외부 라이브러리를 쓰지 않는다.
 *
 * DOM 에만 의존하고 API·시그널 판정은 모른다. 입력은 캔들 배열, 출력은
 * container 안의 SVG 한 벌이다.
 */

import { bollinger, macd, rsi, sma, stochastic } from './indicators.js';
import { detectPatterns } from './patterns.js';
import { CHART_BARS, PERIODS } from './config.js';
import {
  axisPriceFormatter,
  formatAxisTime,
  formatCandleTime,
  formatPrice,
  formatVolume,
} from './format.js';

const PRICE_HEIGHT = 264;
/** 가격 패널 아래 거래량 막대. 트레이딩 화면의 기본 요소다. */
const VOLUME_HEIGHT = 46;
const SUB_HEIGHT = 88;
const AXIS_WIDTH = 62; // 오른쪽 가격축 (업비트와 같은 위치)
const TIME_HEIGHT = 22;
const GAP = 10;
const PAD_TOP = 10;

const svgNS = 'http://www.w3.org/2000/svg';

/**
 * 지표는 전체 캔들로 계산한 뒤 최근 구간만 잘라 그린다.
 * 잘라낸 뒤 계산하면 MA60 이 화면 왼쪽 59봉에서 null 이 되어 이동평균선이
 * 차트 중간부터 시작하는 흔한 버그가 생긴다.
 */
function prepare(candles, bars) {
  const closes = candles.map((c) => c.close);
  const bands = bollinger(closes, PERIODS.bollinger, PERIODS.bollingerSigma);
  const macdSeries = macd(closes, PERIODS.macdFast, PERIODS.macdSlow, PERIODS.macdSignal);
  const stoch = stochastic(candles, PERIODS.stochastic, PERIODS.stochasticSignal);

  const from = Math.max(0, candles.length - bars);
  const slice = (arr) => arr.slice(from);

  return {
    candles: candles.slice(from),
    ma20: slice(sma(closes, PERIODS.maShort)),
    ma60: slice(sma(closes, PERIODS.maLong)),
    upper: slice(bands.upper),
    lower: slice(bands.lower),
    rsi: slice(rsi(closes, PERIODS.rsi)),
    macd: slice(macdSeries.macd),
    macdSignal: slice(macdSeries.signal),
    macdHistogram: slice(macdSeries.histogram),
    stochK: slice(stoch.k),
    stochD: slice(stoch.d),
  };
}

const finite = (values) => values.filter((v) => v !== null && Number.isFinite(v));

function priceRange(view) {
  const values = [
    ...view.candles.map((c) => c.high),
    ...view.candles.map((c) => c.low),
    ...finite(view.upper),
    ...finite(view.lower),
    ...finite(view.ma60),
  ];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = (max - min) * 0.04 || max * 0.01 || 1;
  return { min: min - pad, max: max + pad };
}

/** 값 → y 좌표 변환기. 위아래가 뒤집힌 좌표계를 한곳에서만 다룬다. */
function scaler(min, max, top, height) {
  const span = max - min || 1;
  return (value) => top + height - ((value - min) / span) * height;
}

function linePath(values, xOf, yOf) {
  let path = '';
  let open = false;
  values.forEach((value, i) => {
    if (value === null || !Number.isFinite(value)) {
      open = false;
      return;
    }
    path += `${open ? 'L' : 'M'}${xOf(i).toFixed(1)} ${yOf(value).toFixed(1)}`;
    open = true;
  });
  return path;
}

function bandPath(upper, lower, xOf, yOf) {
  const top = [];
  const bottom = [];
  upper.forEach((value, i) => {
    if (value === null || lower[i] === null) return;
    top.push(`${xOf(i).toFixed(1)} ${yOf(value).toFixed(1)}`);
    bottom.push(`${xOf(i).toFixed(1)} ${yOf(lower[i]).toFixed(1)}`);
  });
  if (!top.length) return '';
  return `M${top.join('L')}L${bottom.reverse().join('L')}Z`;
}

function el(name, attrs = {}) {
  const node = document.createElementNS(svgNS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

/**
 * 스윙 탐지 간격. 봉이 몇 개 보이느냐에 맞춰 늘린다 — 80봉에서 쓰는 span
 * 그대로 1095봉(3년치)에 적용하면 잔파도까지 전부 스윙으로 잡혀 패턴이
 * 의미를 잃는다. 60봉당 1씩, 최소 3.
 */
const swingSpanFor = (count) => Math.max(3, Math.round(count / 60));

const fibAt = (fib, ratio) => fib.levels.find((level) => level.ratio === ratio)?.price ?? null;

function levelLine(price, yOf, plotWidth, cls) {
  const y = yOf(price);
  return el('line', { x1: 0, y1: y, x2: plotWidth, y2: y, class: cls });
}

function segment(a, b, xOf, yOf, cls) {
  return el('line', {
    x1: xOf(a.index).toFixed(1),
    y1: yOf(a.price).toFixed(1),
    x2: xOf(b.index).toFixed(1),
    y2: yOf(b.price).toFixed(1),
    class: cls,
  });
}

function dot(point, xOf, yOf, cls) {
  return el('circle', { cx: xOf(point.index).toFixed(1), cy: yOf(point.price).toFixed(1), r: 3.5, class: cls });
}

function trendSegment(line, xOf, yOf, count, cls) {
  return el('line', {
    x1: xOf(0).toFixed(1),
    y1: yOf(line.priceAt(0)).toFixed(1),
    x2: xOf(count - 1).toFixed(1),
    y2: yOf(line.priceAt(count - 1)).toFixed(1),
    class: cls,
  });
}

/**
 * 패턴 오버레이 — 순수 계산(patterns.js)과 좌표 변환(xOf/yPrice)을 잇는다.
 * 카테고리별로 켜고 끌 수 있게 legend 항목도 함께 낸다. 숫자만 그리지 않고
 * 근거(넥라인·꼭짓점)를 항상 함께 그리는 이유는 이 패턴들이 규칙 기반
 * 지표와 달리 '봉우리가 비슷한 높이'같은 허용 오차 안에서 결정되기
 * 때문이다 — patterns.js 상단 주석 참고.
 */
function patternLayer(view, categories, { xOf, yPrice, plotWidth, quote }) {
  const layer = el('g', { class: 'pattern-layer' });
  const legend = [];
  if (!categories || !categories.size) return { node: layer, legend };

  const count = view.candles.length;
  const patterns = detectPatterns(view.candles, { span: swingSpanFor(count) });

  if (categories.has('lines')) {
    for (const level of patterns.lines.levels.slice(0, 4)) {
      const cls = level.kind === 'support' ? 'support' : 'resistance';
      layer.append(levelLine(level.price, yPrice, plotWidth, `pattern-line ${cls}`));
      legend.push({
        cls,
        text: `${level.kind === 'support' ? '지지선' : '저항선'} ${formatPrice(level.price, quote)} · ${level.touches}회 반응`,
      });
    }

    if (patterns.lines.trendlines.support) {
      layer.append(trendSegment(patterns.lines.trendlines.support, xOf, yPrice, count, 'pattern-line trend-up'));
      legend.push({ cls: 'trend-up', text: '상승 추세선 (스윙 저점 연결)' });
    }
    if (patterns.lines.trendlines.resistance) {
      layer.append(
        trendSegment(patterns.lines.trendlines.resistance, xOf, yPrice, count, 'pattern-line trend-down'),
      );
      legend.push({ cls: 'trend-down', text: '하락 추세선 (스윙 고점 연결)' });
    }

    if (patterns.lines.fibonacci) {
      for (const level of patterns.lines.fibonacci.levels) {
        layer.append(levelLine(level.price, yPrice, plotWidth, 'pattern-line fib'));
      }
      legend.push({
        cls: 'fib',
        text: `피보나치 되돌림 · 38.2% ${formatPrice(fibAt(patterns.lines.fibonacci, 0.382), quote)} · 61.8% ${formatPrice(fibAt(patterns.lines.fibonacci, 0.618), quote)}`,
      });
    }

    const vwapPath = linePath(patterns.lines.vwap, xOf, yPrice);
    if (vwapPath) {
      layer.append(el('path', { d: vwapPath, class: 'pattern-line vwap' }));
      const lastVwap = [...patterns.lines.vwap].reverse().find((v) => v !== null);
      if (lastVwap !== undefined) legend.push({ cls: 'vwap', text: `VWAP ${formatPrice(lastVwap, quote)}` });
    }
  }

  if (categories.has('continuation') && patterns.continuation.triangle) {
    const tri = patterns.continuation.triangle;
    layer.append(trendSegment(tri.support, xOf, yPrice, count, 'pattern-line triangle'));
    layer.append(trendSegment(tri.resistance, xOf, yPrice, count, 'pattern-line triangle'));
    const label = { ascending: '상승삼각형', descending: '하락삼각형', symmetric: '대칭삼각형' }[tri.kind];
    legend.push({ cls: 'triangle', text: `${label} 수렴 중` });
  }

  if (categories.has('reversal')) {
    for (const item of patterns.reversal.doubleExtremes) {
      const [a, b] = item.points;
      layer.append(segment(a, item.neckline, xOf, yPrice, 'pattern-line neckline'));
      layer.append(segment(item.neckline, b, xOf, yPrice, 'pattern-line neckline'));
      [a, item.neckline, b].forEach((p) => layer.append(dot(p, xOf, yPrice, 'pattern-dot')));
      const label = item.kind === 'double-bottom' ? '쌍바닥' : '쌍봉';
      legend.push({
        cls: item.kind,
        text: `${label} · 넥라인 ${formatPrice(item.neckline.price, quote)} · ${item.completed ? '돌파 완료' : '돌파 전'}`,
      });
    }

    for (const item of patterns.reversal.headAndShoulders) {
      layer.append(segment(item.left, item.head, xOf, yPrice, 'pattern-line neckline'));
      layer.append(segment(item.head, item.right, xOf, yPrice, 'pattern-line neckline'));
      [item.left, item.head, item.right].forEach((p) => layer.append(dot(p, xOf, yPrice, 'pattern-dot')));
      const label = item.kind === 'head-shoulders' ? '헤드앤숄더' : '역헤드앤숄더';
      legend.push({ cls: item.kind, text: `${label} · 넥라인 ${formatPrice(item.neckline, quote)}` });
    }
  }

  /*
   * 거짓 무빙 — 돌파가 실패한 자리. 레벨선은 '라인형'을 끄고 봐도 뜻이 통하도록
   * 여기서 다시 그린다(그 레벨을 뚫었다는 사실이 이 표시의 전부이기 때문이다).
   */
  if (categories.has('traps')) {
    // 휩쏘 띠를 먼저 그린다. SVG 는 나중에 그린 것이 위로 올라오므로, 순서를
    // 뒤집으면 배경 띠가 트랩 마커를 덮어 흐려진다(실측).
    const saw = patterns.traps.whipsaw;
    let sawLegend = null;
    if (saw) {
      // 톱질이 일어난 구간의 고·저를 그대로 띠로 덮는다. 그 폭이 곧 휩쏘의 크기다.
      const from = Math.max(0, count - saw.window);
      const slice = view.candles.slice(from);
      const top = Math.max(...slice.map((candle) => candle.high));
      const bottom = Math.min(...slice.map((candle) => candle.low));
      const y1 = yPrice(top);
      const y2 = yPrice(bottom);
      layer.append(
        el('rect', {
          x: xOf(from).toFixed(1),
          y: Math.min(y1, y2).toFixed(1),
          width: Math.max(1, xOf(count - 1) - xOf(from)).toFixed(1),
          height: Math.max(1, Math.abs(y2 - y1)).toFixed(1),
          class: 'pattern-whipsaw',
        }),
      );
      for (const index of saw.points) {
        layer.append(dot({ index, price: view.candles[index].close }, xOf, yPrice, 'pattern-dot whipsaw'));
      }
      // 그리는 순서와 읽는 순서는 다르다 — 범례는 트랩을 먼저 읽는 것이 낫다.
      sawLegend = {
        cls: 'whipsaw',
        text: `휩쏘 구간 · 최근 ${saw.window}봉에서 MA${saw.period} 교차 ${saw.crosses}회 · 방향 신호 신뢰도 낮음`,
      };
    }
  

    for (const trap of patterns.traps.falseBreakouts) {
      const bull = trap.kind === 'bull-trap';
      const cls = bull ? 'trap-bull' : 'trap-bear';
      const pending = trap.status === 'pending';

      layer.append(
        levelLine(trap.level.price, yPrice, plotWidth, `pattern-line trap-level ${cls}`),
      );

      const breakPoint = { index: trap.breakIndex, price: trap.breakPrice };
      const endIndex = trap.returnIndex ?? count - 1;
      const endPoint = { index: endIndex, price: view.candles[endIndex].close };
      layer.append(
        segment(breakPoint, endPoint, xOf, yPrice, `pattern-line ${cls}${pending ? ' pending' : ''}`),
      );
      layer.append(dot(breakPoint, xOf, yPrice, `pattern-dot ${cls}`));
      if (!pending) layer.append(dot(endPoint, xOf, yPrice, `pattern-dot ${cls}`));

      // 저항은 '돌파', 지지는 '이탈' 이라고 적는다 — '지지를 돌파했다'는 어색하다.
      const side = bull ? '저항' : '지지';
      const verb = bull ? '돌파' : '이탈';
      const volume =
        trap.volumeRatio === null ? '거래량 미상' : `돌파봉 거래량 ${trap.volumeRatio.toFixed(2)}배`;
      legend.push({
        cls,
        text: pending
          ? `돌파 감시 중 · ${side} ${formatPrice(trap.level.price, quote)} ${verb} ${trap.bars}봉째 · 되돌아오면 ${bull ? '불트랩' : '베어트랩'} · ${volume}`
          : `${bull ? '불트랩' : '베어트랩'} 확정 · ${side} ${formatPrice(trap.level.price, quote)} ${verb} 후 ${trap.bars}봉 만에 복귀 · ${volume}`,
      });
    }

    if (sawLegend) legend.push(sawLegend);
  }

  if (categories.has('volume')) {
    const profile = patterns.volume.profile;
    if (profile) {
      const maxVolume = Math.max(...profile.levels.map((level) => level.volume), 1);
      const barMaxWidth = 46;
      for (const level of profile.levels) {
        if (level.volume <= 0) continue;
        const y1 = yPrice(level.priceHigh);
        const y2 = yPrice(level.priceLow);
        const width = (level.volume / maxVolume) * barMaxWidth;
        layer.append(
          el('rect', {
            x: (plotWidth - width).toFixed(1),
            y: Math.min(y1, y2).toFixed(1),
            width: width.toFixed(1),
            height: Math.max(1, Math.abs(y2 - y1) - 1).toFixed(1),
            class: level === profile.poc ? 'pattern-vp poc' : 'pattern-vp',
          }),
        );
      }
      legend.push({
        cls: 'poc',
        text: `거래량 집중가(POC) ${formatPrice(profile.poc.priceLow, quote)}~${formatPrice(profile.poc.priceHigh, quote)}`,
      });
    }

    const divergence = patterns.volume.obvDivergence;
    if (divergence) {
      const points = divergence.indices.map((index) => ({ index, price: view.candles[index].close }));
      layer.append(segment(points[0], points[1], xOf, yPrice, `pattern-line ${divergence.kind}`));
      points.forEach((p) => layer.append(dot(p, xOf, yPrice, `pattern-dot ${divergence.kind}`)));
      const label = divergence.kind === 'bullish' ? 'OBV 상승 다이버전스' : 'OBV 하락 다이버전스';
      legend.push({ cls: divergence.kind, text: `${label} (누적 거래량과 가격이 어긋남)` });
    }
  }

  return { node: layer, legend };
}

function renderPatternLegend(container, legend) {
  const existing = container.querySelector('.pattern-legend');
  if (existing) existing.remove();
  if (!legend.length) return;

  const list = document.createElement('ul');
  list.className = 'pattern-legend';
  for (const item of legend) {
    const li = document.createElement('li');
    li.className = `pattern-legend-item ${item.cls}`;
    li.textContent = item.text;
    list.append(li);
  }
  container.append(list);
}

/**
 * @param {HTMLElement} container position:relative 인 래퍼
 * @param {{candles: object[], timeframeKey: string, bars?: number, patternCategories?: Set<string>}} options
 */
export function renderChart(
  container,
  { candles, timeframeKey, quote = 'KRW', bars = null, subPanel = 'rsi', patternCategories = null },
) {
  container.textContent = '';

  if (!candles || candles.length < 2) {
    const empty = document.createElement('p');
    empty.className = 'chart-empty';
    empty.textContent = '캔들 데이터를 불러오지 못했습니다. 자동갱신을 켜두면 다음 주기에 다시 시도합니다.';
    container.append(empty);
    return;
  }

  const width = Math.max(container.clientWidth || 720, 320);
  // 좁은 화면에서 80봉을 그리면 봉 하나가 4px 미만이 되어 몸통과 꼬리가 뭉갠다.
  const visibleBars = bars ?? (width < 520 ? 45 : CHART_BARS);

  const view = prepare(candles, visibleBars);
  const plotWidth = width - AXIS_WIDTH;
  const height =
    PAD_TOP + PRICE_HEIGHT + VOLUME_HEIGHT + GAP + SUB_HEIGHT + TIME_HEIGHT;

  const count = view.candles.length;
  const barWidth = plotWidth / count;
  const bodyWidth = Math.max(1, Math.min(barWidth * 0.62, 14));
  const xOf = (i) => i * barWidth + barWidth / 2;

  const { min, max } = priceRange(view);
  const yPrice = scaler(min, max, PAD_TOP, PRICE_HEIGHT);

  const volumeTop = PAD_TOP + PRICE_HEIGHT;
  const maxVolume = Math.max(...view.candles.map((candle) => candle.volume ?? 0), 1);
  const yVolume = scaler(0, maxVolume, volumeTop, VOLUME_HEIGHT);

  const subTop = volumeTop + VOLUME_HEIGHT + GAP;

  const svg = el('svg', {
    class: 'chart-svg',
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': `최근 ${count}개 ${timeframeKey === 'day' ? '일봉' : '봉'} 캔들차트와 RSI`,
  });

  // ── 가격 눈금 ──────────────────────────────────────────────
  const priceLabel = axisPriceFormatter(max, quote);
  const grid = el('g', { class: 'grid' });
  for (let step = 0; step <= 4; step += 1) {
    const value = min + ((max - min) * step) / 4;
    const y = yPrice(value);
    grid.append(el('line', { x1: 0, y1: y, x2: plotWidth, y2: y, class: 'grid-line' }));
    const label = el('text', { x: plotWidth + 6, y: y + 3.5, class: 'axis-label' });
    label.textContent = priceLabel(value);
    grid.append(label);
  }
  svg.append(grid);

  // ── 볼린저밴드 → 이동평균 → 캔들 순서로 겹친다 ─────────────
  const band = bandPath(view.upper, view.lower, xOf, yPrice);
  if (band) svg.append(el('path', { d: band, class: 'bb-fill' }));
  svg.append(el('path', { d: linePath(view.upper, xOf, yPrice), class: 'bb-line' }));
  svg.append(el('path', { d: linePath(view.lower, xOf, yPrice), class: 'bb-line' }));
  svg.append(el('path', { d: linePath(view.ma60, xOf, yPrice), class: 'ma ma-long' }));
  svg.append(el('path', { d: linePath(view.ma20, xOf, yPrice), class: 'ma ma-short' }));

  const candleLayer = el('g', { class: 'candles' });
  view.candles.forEach((candle, i) => {
    const rising = candle.close >= candle.open;
    const cls = rising ? 'rise' : 'fall';
    const x = xOf(i);

    candleLayer.append(
      el('line', {
        x1: x,
        y1: yPrice(candle.high),
        x2: x,
        y2: yPrice(candle.low),
        class: `wick ${cls}`,
      }),
    );

    const top = yPrice(Math.max(candle.open, candle.close));
    const bottom = yPrice(Math.min(candle.open, candle.close));
    candleLayer.append(
      el('rect', {
        x: x - bodyWidth / 2,
        y: top,
        width: bodyWidth,
        height: Math.max(1, bottom - top),
        class: `body ${cls}`,
      }),
    );
  });
  svg.append(candleLayer);

  // ── 참고용 차트선 (지지/저항·추세선·패턴 등, 켠 카테고리만) ──
  const { node: patternNode, legend } = patternLayer(view, patternCategories, { xOf, yPrice, plotWidth, quote });
  svg.append(patternNode);

  // ── 거래량 막대 ───────────────────────────────────────────
  const volumeLayer = el('g', { class: 'volume-panel' });
  view.candles.forEach((candle, i) => {
    const value = candle.volume ?? 0;
    const top = yVolume(value);
    volumeLayer.append(
      el('rect', {
        x: xOf(i) - bodyWidth / 2,
        y: top,
        width: bodyWidth,
        height: Math.max(0.5, volumeTop + VOLUME_HEIGHT - top),
        class: `vol ${candle.close >= candle.open ? 'rise' : 'fall'}`,
      }),
    );
  });
  const volumeTitle = el('text', { x: 4, y: volumeTop + 11, class: 'panel-title' });
  volumeTitle.textContent = '거래량';
  volumeLayer.append(volumeTitle);
  svg.append(volumeLayer);

  // ── 서브차트 (RSI · MACD · 스토캐스틱 중 하나) ─────────────
  svg.append(subChart(subPanel, view, { xOf, plotWidth, top: subTop }));

  // ── 시간축 ────────────────────────────────────────────────
  const timeY = height - 6;
  const tickEvery = Math.max(1, Math.floor(count / 6));
  for (let i = 0; i < count; i += tickEvery) {
    const x = xOf(i);
    // 가운데 정렬한 라벨은 양 끝에서 잘려 '06/15'가 '6/15'로 보인다.
    const atStart = x < 24;
    const atEnd = x > plotWidth - 24;
    const label = el('text', {
      x: atStart ? 0 : atEnd ? plotWidth : x,
      y: timeY,
      class: 'axis-label time',
      'text-anchor': atStart ? 'start' : atEnd ? 'end' : 'middle',
    });
    label.textContent = formatAxisTime(view.candles[i].kst, timeframeKey);
    svg.append(label);
  }

  // ── 십자선 (호버 시에만 보인다) ────────────────────────────
  // HTML 의 hidden 속성은 SVG 요소에서 통하지 않으므로 클래스로 여닫는다.
  const crosshair = el('g', { class: 'crosshair' });
  const vLine = el('line', { y1: PAD_TOP, y2: subTop + SUB_HEIGHT, class: 'crosshair-line' });
  const hLine = el('line', { x1: 0, x2: plotWidth, class: 'crosshair-line' });
  crosshair.append(vLine, hLine);
  svg.append(crosshair);

  container.append(svg);
  renderPatternLegend(container, legend);

  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';
  tooltip.hidden = true;
  container.append(tooltip);

  attachHover({
    container,
    svg,
    view,
    timeframeKey,
    quote,
    crosshair,
    vLine,
    hLine,
    tooltip,
    xOf,
    yPrice,
    barWidth,
    plotWidth,
    width,
  });
}

/**
 * 서브차트 세 종류를 한 함수로 그린다.
 *
 * RSI·스토캐스틱은 0~100 고정 축이라 눈금선을 같은 방식으로 쓸 수 있고, MACD 만
 * 값 범위가 종목마다 달라 자체 축척이 필요하다. 세 개를 각각 함수로 두면 눈금·축
 * 코드가 세 번 반복된다.
 */
function subChart(kind, view, { xOf, plotWidth, top }) {
  const layer = el('g', { class: `sub-panel sub-${kind}` });
  const label = { rsi: `RSI(${PERIODS.rsi})`, macd: 'MACD', stochastic: '스토캐스틱' }[kind];

  const axisText = (value, y) => {
    const node = el('text', { x: plotWidth + 6, y: y + 3.5, class: 'axis-label' });
    node.textContent = value;
    return node;
  };

  if (kind === 'macd') {
    const values = [...view.macd, ...view.macdSignal, ...view.macdHistogram].filter(
      (value) => value !== null && Number.isFinite(value),
    );
    if (values.length) {
      const span = Math.max(Math.abs(Math.min(...values)), Math.abs(Math.max(...values))) || 1;
      const y = scaler(-span, span, top, SUB_HEIGHT);

      // 0선을 기준으로 히스토그램이 위아래로 갈린다.
      layer.append(el('line', { x1: 0, y1: y(0), x2: plotWidth, y2: y(0), class: 'sub-guide' }));

      view.macdHistogram.forEach((value, i) => {
        if (value === null) return;
        const zero = y(0);
        const point = y(value);
        layer.append(
          el('rect', {
            x: xOf(i) - 1.5,
            y: Math.min(zero, point),
            width: 3,
            height: Math.max(0.5, Math.abs(zero - point)),
            class: `macd-bar ${value >= 0 ? 'rise' : 'fall'}`,
          }),
        );
      });

      layer.append(el('path', { d: linePath(view.macd, xOf, y), class: 'macd-line' }));
      layer.append(el('path', { d: linePath(view.macdSignal, xOf, y), class: 'macd-signal' }));
      layer.append(axisText('0', y(0)));
    }
  } else {
    const y = scaler(0, 100, top, SUB_HEIGHT);
    const [low, high] = kind === 'rsi' ? [30, 70] : [20, 80];

    layer.append(
      el('rect', { x: 0, y: y(high), width: plotWidth, height: y(low) - y(high), class: 'sub-zone' }),
    );
    for (const level of [low, high]) {
      layer.append(el('line', { x1: 0, y1: y(level), x2: plotWidth, y2: y(level), class: 'sub-guide' }));
      layer.append(axisText(String(level), y(level)));
    }

    if (kind === 'rsi') {
      layer.append(el('path', { d: linePath(view.rsi, xOf, y), class: 'rsi-line' }));
    } else {
      layer.append(el('path', { d: linePath(view.stochK, xOf, y), class: 'stoch-k' }));
      layer.append(el('path', { d: linePath(view.stochD, xOf, y), class: 'stoch-d' }));
    }
  }

  const title = el('text', { x: 4, y: top + 12, class: 'panel-title' });
  title.textContent = label;
  layer.append(title);
  return layer;
}

/**
 * 툴팁은 DOM 노드로 조립한다. 캔들의 시각 문자열은 외부 API 응답이므로
 * innerHTML 로 문자열을 이어 붙이지 않는다.
 */
function fillTooltip(tooltip, candle, timeframeKey, quote) {
  const changeRate = candle.open ? (candle.close - candle.open) / candle.open : 0;
  const direction = candle.close >= candle.open ? 'rise' : 'fall';

  const heading = document.createElement('div');
  heading.className = 'tt-time';
  heading.textContent = formatCandleTime(candle.kst, timeframeKey);

  const rows = [
    ['시가', formatPrice(candle.open, quote), ''],
    ['고가', formatPrice(candle.high, quote), ''],
    ['저가', formatPrice(candle.low, quote), ''],
    ['종가', formatPrice(candle.close, quote), direction],
    ['등락', `${(changeRate * 100).toFixed(2)}%`, direction],
    ['거래량', formatVolume(candle.volume), ''],
  ];

  const list = document.createElement('dl');
  for (const [term, value, className] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    if (className) dd.className = className;
    list.append(dt, dd);
  }

  tooltip.replaceChildren(heading, list);
}

/**
 * 캔들마다 히트 영역을 만들지 않고 SVG 하나에 mousemove 를 걸어 x 좌표로
 * 인덱스를 역산한다. 200개 노드에 리스너를 붙이는 것보다 가볍고, 봉 사이
 * 빈틈에서도 툴팁이 끊기지 않는다.
 */
function attachHover(ctx) {
  const { container, svg, view, timeframeKey, quote, crosshair, vLine, hLine, tooltip, xOf, yPrice, plotWidth, barWidth } = ctx;

  const hide = () => {
    crosshair.classList.remove('on');
    tooltip.hidden = true;
  };

  svg.addEventListener('mousemove', (event) => {
    const rect = svg.getBoundingClientRect();
    const x = event.clientX - rect.left;
    if (x > plotWidth) {
      hide();
      return;
    }

    const index = Math.min(view.candles.length - 1, Math.max(0, Math.floor(x / barWidth)));
    const candle = view.candles[index];
    const cx = xOf(index);

    crosshair.classList.add('on');
    vLine.setAttribute('x1', cx);
    vLine.setAttribute('x2', cx);
    const cy = Math.max(PAD_TOP, Math.min(PAD_TOP + PRICE_HEIGHT, event.clientY - rect.top));
    hLine.setAttribute('y1', cy);
    hLine.setAttribute('y2', cy);

    fillTooltip(tooltip, candle, timeframeKey, quote);
    tooltip.hidden = false;

    // 오른쪽 끝에서는 왼쪽으로 뒤집어 툴팁이 잘리지 않게 한다.
    const flip = cx > plotWidth * 0.62;
    tooltip.style.left = flip ? 'auto' : `${cx + 14}px`;
    tooltip.style.right = flip ? `${plotWidth - cx + 14}px` : 'auto';
    tooltip.style.top = `${PAD_TOP + 6}px`;
  });

  svg.addEventListener('mouseleave', hide);
  container.addEventListener('mouseleave', hide);
}
