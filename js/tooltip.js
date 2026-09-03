/**
 * 설명 툴팁 엔진 — `glossary.js` 의 사전을 화면 요소에 붙인다.
 *
 * 브라우저 기본 `title` 을 쓰지 않는 이유가 세 가지다. 표시까지 1초 가까이
 * 걸리고, 여러 줄을 구조로 보여줄 수 없어 판정 기준표가 한 덩어리로 뭉개지며,
 * 터치 기기에서는 아예 뜨지 않는다. 이 화면은 설명할 것이 많아 셋 다 곤란하다.
 *
 * ⚠️ **요소에 객체를 매달지 않는다.** 카드와 상세표는 체결이 올 때마다
 * `refreshSignals()`(400ms 스로틀)가 통째로 다시 그리므로, 요소에 붙인 것은
 * 매번 사라진다. 그래서 설명은 `data-help`(사전 키)·`data-help-live`(현재 판정)
 * 문자열로만 싣고, 툴팁이 열려 있는 동안은 `data-help-id` 로 대상을 매 프레임
 * 다시 찾는다. 다시 그려져도 툴팁이 붙어 있고 현재 판정 줄도 함께 갱신된다.
 */

import { helpRef } from './glossary.js';

/** 마우스가 스쳐 지나갈 때 툴팁이 깜빡이지 않을 만큼의 지연 */
const OPEN_DELAY_MS = 120;

/** 화면 가장자리에서 띄울 여백 */
const EDGE = 8;

/** 대상과 툴팁 사이 간격 */
const OFFSET = 8;

let root = null;
let liveNode = null;
let openId = null;
let openLive = null;
let timer = 0;
let frame = 0;
/** 터치는 hover 가 없어 탭으로 여닫는다. 마우스와 처리를 갈라야 한다. */
let lastPointerType = 'mouse';

/** 이미 초점을 받는 요소에는 tabindex 를 덧붙이지 않는다. */
const FOCUSABLE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
};

const cssEscape = (value) =>
  window.CSS?.escape ? window.CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&');

function ensureRoot() {
  if (root) return root;
  root = el('div', 'tip');
  root.id = 'help-tip';
  root.setAttribute('role', 'tooltip');
  root.hidden = true;
  document.body.append(root);
  return root;
}

/**
 * 설명 하나를 요소에 붙인다.
 *
 * @param {HTMLElement} element
 * @param {string} ref `glossary.js` 의 `"<맵>:<키>"` 참조
 * @param {{id: string, live?: string|null}} options
 *   `id` 는 다시 그려도 같은 자리를 가리키는 고유 문자열이어야 한다.
 *   `live` 는 지금 이 자리의 판정 — 사전에 없는, 이 순간에만 유효한 한 줄이다.
 * @returns {HTMLElement} 체이닝을 위해 받은 요소를 그대로 돌려준다.
 */
export function attachHelp(element, ref, { id, live = null } = {}) {
  if (!element || !ref || !helpRef(ref)) return element;

  element.dataset.help = ref;
  element.dataset.helpId = id ?? ref;
  if (live) element.dataset.helpLive = live;
  else delete element.dataset.helpLive;

  element.classList.add('has-help');
  // 키보드로도 읽을 수 있어야 한다. 이미 초점을 받는 요소는 건드리지 않는다.
  if (!element.hasAttribute('tabindex') && !FOCUSABLE.has(element.tagName)) {
    element.tabIndex = 0;
  }
  return element;
}

/** 사전 항목 하나를 툴팁 안쪽 노드로 옮긴다. */
function build(help, live) {
  const box = document.createDocumentFragment();
  box.append(el('p', 'tip-title', help.title));

  liveNode = el('p', 'tip-live');
  liveNode.hidden = !live;
  if (live) liveNode.textContent = live;
  box.append(liveNode);

  box.append(el('p', 'tip-what', help.what));

  if (help.scale?.length) {
    const list = el('dl', 'tip-scale');
    for (const [when, then] of help.scale) {
      list.append(el('dt', null, when));
      list.append(el('dd', null, then));
    }
    box.append(list);
  }

  if (help.note) box.append(el('p', 'tip-note', help.note));
  if (help.caveat) box.append(el('p', 'tip-caveat', help.caveat));

  return box;
}

/** 대상 아래에 두되, 아래가 좁으면 위로 뒤집는다. */
function place(target) {
  const rect = target.getBoundingClientRect();
  const box = root.getBoundingClientRect();

  let left = rect.left + rect.width / 2 - box.width / 2;
  left = Math.max(EDGE, Math.min(left, window.innerWidth - box.width - EDGE));

  let top = rect.bottom + OFFSET;
  if (top + box.height > window.innerHeight - EDGE) {
    const above = rect.top - box.height - OFFSET;
    top = above >= EDGE ? above : Math.max(EDGE, window.innerHeight - box.height - EDGE);
  }

  root.style.left = `${Math.round(left)}px`;
  root.style.top = `${Math.round(top)}px`;
}

/**
 * 열려 있는 동안 매 프레임 대상을 다시 찾는다.
 *
 * 카드가 다시 그려지면 원래 요소는 이미 문서에서 떨어져 나갔고 위치도 낡는다.
 * `data-help-id` 로 새 요소를 찾아 이어 붙이고, 못 찾으면 그 자리가 사라진
 * 것이므로 닫는다.
 */
function follow() {
  frame = requestAnimationFrame(follow);
  if (!openId) return;

  const target = document.querySelector(`[data-help-id="${cssEscape(openId)}"]`);
  if (!target) {
    hide();
    return;
  }

  const live = target.dataset.helpLive ?? '';
  if (live !== openLive) {
    openLive = live;
    if (liveNode) {
      liveNode.textContent = live;
      liveNode.hidden = !live;
    }
  }

  target.setAttribute('aria-describedby', root.id);
  place(target);
}

function show(target) {
  const help = helpRef(target.dataset.help);
  if (!help) return;

  const id = target.dataset.helpId;
  if (id === openId) return;

  hide();
  ensureRoot();
  openId = id;
  openLive = target.dataset.helpLive ?? '';
  root.replaceChildren(build(help, openLive));
  root.hidden = false;
  // 다음 프레임의 follow() 를 기다리지 않는다 — 화면 낭독기는 지금 읽는다.
  target.setAttribute('aria-describedby', root.id);
  place(target);
  frame = requestAnimationFrame(follow);
}

function hide() {
  clearTimeout(timer);
  timer = 0;
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  if (openId) {
    document
      .querySelector(`[data-help-id="${cssEscape(openId)}"]`)
      ?.removeAttribute('aria-describedby');
  }
  openId = null;
  openLive = null;
  liveNode = null;
  if (root) root.hidden = true;
}

const helpTargetOf = (node) =>
  node instanceof Element ? node.closest('[data-help]') : null;

function scheduleShow(target) {
  clearTimeout(timer);
  timer = setTimeout(() => show(target), OPEN_DELAY_MS);
}

/**
 * 문서 하나에 위임으로 붙인다. 요소마다 리스너를 달면 카드가 다시 그려질 때마다
 * 수백 개를 새로 달고 버리게 된다.
 */
export function initTooltips() {
  ensureRoot();

  document.addEventListener('pointerdown', (event) => {
    lastPointerType = event.pointerType || 'mouse';
  });

  document.addEventListener('pointerover', (event) => {
    // 터치는 탭(click)으로만 연다. 터치에서도 pointerover 가 오지만 손을 떼는
    // 순간 pointerout 이 따라와 툴팁이 깜빡이고 만다.
    if (event.pointerType === 'touch') return;
    const target = helpTargetOf(event.target);
    if (!target) return;
    if (target.dataset.helpId === openId) return;
    scheduleShow(target);
  });

  document.addEventListener('pointerout', (event) => {
    if (event.pointerType === 'touch') return;
    const target = helpTargetOf(event.target);
    if (!target) return;
    // 같은 요소 안쪽으로 옮겨 가는 중이면 닫지 않는다.
    if (target.contains(event.relatedTarget)) return;
    hide();
  });

  document.addEventListener('click', (event) => {
    const target = helpTargetOf(event.target);
    if (!target) {
      hide();
      return;
    }
    if (lastPointerType !== 'touch') return;
    if (target.dataset.helpId === openId) hide();
    else show(target);
  });

  document.addEventListener('focusin', (event) => {
    const target = helpTargetOf(event.target);
    if (target) show(target);
    else hide();
  });

  document.addEventListener('focusout', (event) => {
    if (helpTargetOf(event.target)) hide();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hide();
  });

  // 스크롤은 캡처로 받는다 — 패널 안쪽 스크롤은 문서까지 버블링되지 않는다.
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
}
