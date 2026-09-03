/**
 * 거래소별 실시간 연결 관리자.
 *
 * 강등은 **거래소 단위**로 일어난다. Bybit 소켓이 죽었다고 전체를 폴링으로
 * 내리면 살아 있는 두 곳의 실시간성을 함께 버리게 된다.
 *
 * 상태: connecting → live → (끊김) → connecting … 실패가 쌓이면 polling 으로
 * 강등하고, 그 뒤에도 주기적으로 소켓 복귀를 시도한다.
 */

import { POLL, REALTIME } from './config.js';

export const STATUS = {
  connecting: { key: 'connecting', label: '연결 중' },
  live: { key: 'live', label: '실시간' },
  polling: { key: 'polling', label: '폴링' },
  down: { key: 'down', label: '중단' },
};

/** 이 환경에 WebSocket 이 없으면(Node 등) 바로 폴링으로 시작한다. */
const socketsAvailable = typeof WebSocket !== 'undefined';

export function createRealtime({ exchanges, coins, onTick, onStatus, onOrderbook, onTrade }) {
  const controllers = new Map();
  let running = false;
  let watched = coins;

  const setStatus = (exchange, status, detail = null) => {
    const controller = controllers.get(exchange.id);
    if (controller) controller.status = status;
    onStatus?.(exchange.id, status, detail);
  };

  function startPolling(exchange) {
    const controller = controllers.get(exchange.id);
    if (controller.pollTimer) return;

    /*
     * REST 가 브라우저에서 막힌 거래소(코인원: CORS 헤더 없음)는 폴백이 없다.
     * 실패할 요청을 5초마다 던지면 콘솔만 더럽히고 상태도 거짓으로 표시된다.
     */
    if (exchange.browserRest === false) {
      setStatus(exchange, STATUS.down, 'REST 폴백을 쓸 수 없다');
      return;
    }

    const pull = async () => {
      try {
        const tickers = await exchange.fetchTickers(watched);
        for (const ticker of tickers) onTick(ticker);
        if (controller.status !== STATUS.live) setStatus(exchange, STATUS.polling);
      } catch (error) {
        setStatus(exchange, STATUS.down, error.message);
      }
    };

    pull();
    controller.pollTimer = setInterval(pull, POLL.fallbackTickerMs);
  }

  function stopPolling(exchange) {
    const controller = controllers.get(exchange.id);
    clearInterval(controller.pollTimer);
    controller.pollTimer = null;
  }

  function connect(exchange) {
    const controller = controllers.get(exchange.id);
    if (!running || controller.socket) return;

    if (!socketsAvailable) {
      startPolling(exchange);
      return;
    }

    setStatus(exchange, controller.failures ? controller.status : STATUS.connecting);

    try {
      controller.socket = exchange.openSocket(watched, {
        onOpen: () => {
          controller.failures = 0;
          // 소켓이 살아나면 폴백 폴링을 멈춘다. 둘을 함께 돌리면 호출만 낭비된다.
          stopPolling(exchange);
          setStatus(exchange, STATUS.live);
        },
        onTick,
        onOrderbook,
        onTrade,
        onClose: () => {
          controller.socket = null;
          if (!running) return;
          controller.failures += 1;
          scheduleReconnect(exchange);
        },
      });
    } catch (error) {
      controller.socket = null;
      controller.failures += 1;
      scheduleReconnect(exchange, error.message);
    }
  }

  function scheduleReconnect(exchange, detail = null) {
    const controller = controllers.get(exchange.id);
    clearTimeout(controller.retryTimer);

    const degraded = controller.failures >= REALTIME.failuresBeforeFallback;
    if (degraded) {
      // 소켓을 포기하지는 않는다. 폴링으로 화면을 채우면서 복귀를 계속 시도한다.
      startPolling(exchange);
      setStatus(exchange, STATUS.polling, detail);
    }

    const delay = degraded
      ? REALTIME.recoveryMs
      : Math.min(POLL.retryBaseMs * 2 ** controller.failures, REALTIME.reconnectMaxMs);

    controller.retryTimer = setTimeout(() => connect(exchange), delay);
  }

  return {
    start() {
      if (running) return;
      running = true;

      for (const exchange of exchanges) {
        controllers.set(exchange.id, {
          socket: null,
          failures: 0,
          retryTimer: null,
          pollTimer: null,
          status: STATUS.connecting,
        });
        connect(exchange);
      }
    },

    stop() {
      running = false;
      for (const exchange of exchanges) {
        const controller = controllers.get(exchange.id);
        if (!controller) continue;
        clearTimeout(controller.retryTimer);
        stopPolling(exchange);
        controller.socket?.close();
        controller.socket = null;
        setStatus(exchange, STATUS.down);
      }
    },

    /**
     * 감시 종목이 바뀌면 구독 자체를 다시 만들어야 한다. 업비트 프로토콜은
     * 마지막 구독 요청이 이전 것을 대체하므로 소켓을 닫고 다시 여는 편이
     * 부분 갱신보다 단순하고 확실하다.
     */
    setCoins(next) {
      watched = next;
      if (!running) return;

      for (const exchange of exchanges) {
        const controller = controllers.get(exchange.id);
        if (!controller) continue;
        clearTimeout(controller.retryTimer);
        stopPolling(exchange);
        // onClose 가 재연결을 예약하지 않도록 핸들을 먼저 지운다.
        const socket = controller.socket;
        controller.socket = null;
        controller.failures = 0;
        socket?.close();
        connect(exchange);
      }
    },

    statusOf(exchangeId) {
      return controllers.get(exchangeId)?.status ?? STATUS.down;
    },

    get running() {
      return running;
    },
  };
}
