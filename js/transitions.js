/**
 * 등급 전환 기록.
 *
 * 화면을 계속 지켜보지 않아도 '무엇이 언제 바뀌었는지' 되짚을 수 있게 한다.
 * 순간 값만 보여주는 화면에서는 방금 매수로 돌아섰는지, 원래 매수였는지를
 * 구분할 수 없다.
 */

const DEFAULT_LIMIT = 50;

/** 절대값이 큰 지표가 그 전환을 만든 근거다. 0점과 계산 불가는 근거가 아니다. */
export function topContributors(indicators, count = 2) {
  return indicators
    .filter((entry) => entry.available && Number.isFinite(entry.score) && entry.score !== 0)
    .slice()
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    .slice(0, count)
    .map((entry) => ({ label: entry.label, verdict: entry.verdict, score: entry.score }));
}

export function createTransitionLog({ limit = DEFAULT_LIMIT } = {}) {
  const previous = new Map();
  let entries = [];

  return {
    /**
     * 종목의 현재 판정을 관측한다. 등급이 바뀌었을 때만 기록을 남긴다.
     * @returns 새로 추가된 기록 또는 null
     */
    observe(coin, evaluation, indicators = [], at = Date.now()) {
      const grade = evaluation?.grade;
      if (!grade || grade.key === 'unknown') {
        /*
         * 판정 불가는 전환이 아니다. 연결이 끊겨 데이터가 빈 것과 시그널이
         * 바뀐 것은 다른 사건이므로, 이전 등급을 지우지 않고 그대로 둔다.
         * 그래야 데이터가 돌아왔을 때 같은 등급이면 조용히 넘어간다.
         */
        return null;
      }

      const before = previous.get(coin);
      previous.set(coin, grade);

      if (!before || before.key === grade.key) return null;

      const record = {
        at,
        coin,
        from: before,
        to: grade,
        score: evaluation.consensus?.score ?? null,
        reasons: topContributors(indicators, 2),
      };

      entries = [record, ...entries].slice(0, limit);
      return record;
    },

    /** 화면에서 빠진 종목의 추적 상태를 버린다. */
    retain(coins) {
      const keep = new Set(coins);
      for (const key of [...previous.keys()]) if (!keep.has(key)) previous.delete(key);
      entries = entries.filter((record) => keep.has(record.coin));
    },

    entries() {
      return entries;
    },

    clear() {
      entries = [];
      previous.clear();
    },
  };
}
