/** 화면 표기 전용 포맷터. 계산 로직은 여기에 두지 않는다. */

const krw = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });

/**
 * 시세 표기. 자릿수는 **견적 통화와 가격대를 함께** 봐야 정해진다.
 *
 * 크기만으로 판단하면 XRP 1.3463 USDT 가 '1.35'로 잘린다 — 이 종목은 소수
 * 넷째 자리에서 움직이므로 정보가 사라진다. 반대로 원화는 1,000원 이상에서
 * 정수로 호가되니 소수점을 붙이면 없는 정밀도를 꾸며내는 셈이 된다.
 */
export function formatPrice(value, quote = 'KRW') {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';

  const abs = Math.abs(value);
  const digits =
    quote === 'KRW'
      ? abs >= 1000
        ? 0
        : abs >= 100
          ? 1
          : abs >= 1
            ? 2
            : 4
      : abs >= 1000
        ? 2
        : abs >= 10
          ? 3
          : abs >= 1
            ? 4
            : 6;

  return value.toLocaleString('ko-KR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** 변동률. 입력은 0.0119 같은 비율이다. 부호 없이 절대값만 낸다. */
export function formatRate(rate) {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '—';
  return `${(Math.abs(rate) * 100).toFixed(2)}%`;
}

/** 김치 프리미엄처럼 부호 자체가 정보인 비율. */
export function formatSignedRate(rate, digits = 2) {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '—';
  const percent = rate * 100;
  const sign = percent > 0 ? '+' : percent < 0 ? '−' : '';
  return `${sign}${Math.abs(percent).toFixed(digits)}%`;
}

/** 거래소 견적 통화 단위. 원화만 접미사를 붙이고 USDT 는 열 제목에서 밝힌다. */
export function quoteSuffix(quote) {
  return quote === 'KRW' ? '원' : '';
}

/** 부호는 U+2212(−)로 통일한다. 하이픈과 섞이면 자릿수 정렬이 어긋나 보인다. */
export function formatScore(score) {
  if (score === null || score === undefined) return '—';
  const rounded = Math.round(score);
  if (rounded > 0) return `+${rounded}`;
  if (rounded < 0) return `−${Math.abs(rounded)}`;
  return '0';
}

/** 24시간 거래대금. 조/억 단위로 접는다. */
export function formatTradeValue(value) {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1e12) return `${(value / 1e12).toFixed(1)}조`;
  if (value >= 1e8) return `${krw.format(Math.round(value / 1e8))}억`;
  return `${krw.format(Math.round(value))}원`;
}

/*
 * 'ko-KR' 로케일은 hour12:false 를 줘도 "9시 0분 3초"로 풀어 쓴다. 거래 화면의
 * 시계는 자릿수가 고정된 00:00:03 형태여야 하므로 en-GB 패턴을 쓴다.
 */
const clock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Seoul',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function formatClock(date = new Date()) {
  return clock.format(date);
}

/** 캔들 시각. 업비트가 준 KST 문자열을 그대로 쓴다(변환 오차 없음). */
export function formatCandleTime(kst, timeframeKey) {
  const [date, time] = kst.split('T');
  const [, month, day] = date.split('-');
  if (timeframeKey === 'day') return `${month}/${day}`;
  return `${month}/${day} ${time.slice(0, 5)}`;
}

export function formatAxisTime(kst, timeframeKey) {
  const [date, time] = kst.split('T');
  const [, month, day] = date.split('-');
  return timeframeKey === 'day' ? `${month}/${day}` : time.slice(0, 5);
}

export function formatVolume(value) {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1000) return krw.format(Math.round(value));
  return value.toFixed(3);
}

/**
 * 가격축 포맷터를 축 전체의 최대값으로 한 번 정한다.
 * 눈금마다 단위를 따로 고르면 같은 축에 '1.208억'과 '99,322,442'가 섞여
 * 눈금 간 비교가 불가능해진다.
 *
 * 억·만 단위는 원화 전용이다. USDT 축에 쓰면 BTC 77,098 이 '8만'으로 찍혀
 * 완전히 다른 뜻이 된다.
 */
export function axisPriceFormatter(maxValue, quote = 'KRW') {
  const abs = Math.abs(maxValue);

  if (quote === 'KRW') {
    if (abs >= 1e8) return (value) => `${(value / 1e8).toFixed(2)}억`;
    if (abs >= 1e4) return (value) => `${krw.format(Math.round(value / 1e4))}만`;
    if (abs >= 100) return (value) => krw.format(Math.round(value));
    return (value) => value.toFixed(2);
  }

  const digits = abs >= 1000 ? 0 : abs >= 10 ? 2 : abs >= 1 ? 4 : 6;
  return (value) =>
    value.toLocaleString('ko-KR', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
}

export function formatElapsed(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}초 전`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 전`;
  return `${Math.floor(minutes / 60)}시간 전`;
}
