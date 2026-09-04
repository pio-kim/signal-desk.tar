#!/usr/bin/env python3
"""정적 파일 제공 + 뉴스·심리 중계 서버.

거래소 API 는 전부 CORS 를 열어주므로 브라우저가 직접 부른다. 그러나 뉴스 RSS 는
어느 곳도 CORS 헤더를 주지 않아(CoinDesk·Cointelegraph·블록미디어·TokenPost 모두
실측 확인) 브라우저에서 직접 읽을 수 없다. 이 파일은 그 한 가지 구멍만 메운다.

심리 지표(공포탐욕·CoinGecko)는 CORS 가 열려 있지만 여기서 함께 중계한다.
종목 6개 × CoinGecko 호출을 브라우저에서 반복하면 무료 한도에 걸리기 때문이다.
서버가 한 번 모아 캐싱하면 브라우저는 한 번만 부른다.

의존성 없음 — 파이썬 표준 라이브러리만 쓴다.

    python3 serve.py [포트]
"""

import json
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8137

# 한국 매체를 앞에 둔다. 국내 시장 이슈가 원화 마켓 판단에 더 직접적이다.
FEEDS = [
    ("TokenPost", "https://www.tokenpost.kr/rss", "ko"),
    ("블록미디어", "https://www.blockmedia.co.kr/feed", "ko"),
    ("CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/", "en"),
    ("Cointelegraph", "https://cointelegraph.com/rss", "en"),
    ("Decrypt", "https://decrypt.co/feed", "en"),
]

NEWS_TTL = 300  # 5분. 기사 갱신 주기보다 짧게 잡을 이유가 없다.
SENTIMENT_TTL = 300
COIN_VOTE_TTL = 600  # 커뮤니티 투표는 훨씬 느리게 움직인다.
MARKET_MAP_TTL = 21_600  # 심볼→id 매핑은 상장이 바뀔 때만 달라진다.

USER_AGENT = "signal-desk/1.0 (+local)"
TIMEOUT = 12
MAX_ARTICLES = 80

# 응답 크기 상한. 정상 RSS 는 수백 KB 다.
MAX_BYTES = 4 * 1024 * 1024


class Cache:
    """만료 시각을 함께 들고 있는 아주 작은 캐시. 스레드 사이에서 공유된다."""

    def __init__(self):
        self._store = {}
        self._lock = threading.Lock()

    def get(self, key, ttl):
        with self._lock:
            entry = self._store.get(key)
        if not entry:
            return None
        value, stored_at = entry
        return value if time.time() - stored_at < ttl else None

    def put(self, key, value):
        with self._lock:
            self._store[key] = (value, time.time())


cache = Cache()


class RedirectHandler(urllib.request.HTTPRedirectHandler):
    """308 Permanent Redirect 를 따라간다.

    파이썬 3.9 의 urllib 은 301·302·303·307 만 처리하고 308 은 3.11 에서 추가됐다.
    이 머신은 3.9 라 CoinDesk RSS(308)가 예외로 떨어졌다 — 실측으로 잡은 문제다.

    핸들러 등록만으로는 부족하다. `redirect_request` 가 코드 목록을 다시 검사해
    308 을 거부하고 None 을 돌려주므로, 의미가 같은 307 로 바꿔 넘긴다.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if code == 308:
            code = 307
        return super().redirect_request(req, fp, code, msg, headers, newurl)

    http_error_308 = urllib.request.HTTPRedirectHandler.http_error_301


opener = urllib.request.build_opener(RedirectHandler)


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with opener.open(request, timeout=TIMEOUT) as response:
        # 상한을 넘겨 읽지 않는다. 무한 스트림에 매달리는 것을 막는다.
        return response.read(MAX_BYTES)


def fetch_json(url):
    return json.loads(fetch(url).decode("utf-8", "replace"))


def strip_tags(text):
    return re.sub(r"<[^>]+>", "", text or "").strip()


def parse_feed(name, xml_bytes, language):
    """RSS 2.0 채널의 item 을 뽑는다. 형식이 조금씩 달라 결측에 관대해야 한다.

    ElementTree 는 외부 엔티티를 가져오지 않으므로 XXE 로 파일을 읽거나 내부망을
    찌르는 경로는 없다. 남는 위험은 'billion laughs' — DTD 안 엔티티가 재귀
    확장되어 메모리를 터뜨리는 것이다. 그 공격은 엔티티 선언이 반드시 필요하므로
    선언이 보이면 파싱하지 않는다. defusedxml 을 쓰면 더 깔끔하지만 이 파일은
    표준 라이브러리만 쓴다는 전제를 지킨다.
    """
    articles = []

    head = xml_bytes[:2048].upper()
    if b"<!DOCTYPE" in head or b"<!ENTITY" in xml_bytes[:65536].upper():
        return articles

    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        return articles

    for item in root.iter("item"):
        title = strip_tags(item.findtext("title"))
        if not title:
            continue

        published = item.findtext("pubDate") or item.findtext(
            "{http://purl.org/dc/elements/1.1/}date"
        )
        at = None
        if published:
            try:
                at = int(parsedate_to_datetime(published).timestamp() * 1000)
            except (TypeError, ValueError):
                at = None

        articles.append(
            {
                "source": name,
                "language": language,
                "title": title,
                "link": (item.findtext("link") or "").strip(),
                "at": at,
            }
        )
    return articles


def collect_news():
    cached = cache.get("news", NEWS_TTL)
    if cached is not None:
        return cached

    articles = []
    failures = []
    for name, url, language in FEEDS:
        try:
            articles.extend(parse_feed(name, fetch(url), language))
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            # 한 매체가 죽어도 나머지는 내보낸다.
            failures.append({"source": name, "message": str(error)[:120]})

    # 시각이 없는 기사는 뒤로 보낸다. 최신순 정렬이 화면의 기본 전제다.
    articles.sort(key=lambda item: item["at"] or 0, reverse=True)
    payload = {
        "articles": articles[:MAX_ARTICLES],
        "failures": failures,
        "fetchedAt": int(time.time() * 1000),
    }
    cache.put("news", payload)
    return payload


def symbol_to_id():
    """심볼 → CoinGecko id 매핑.

    /coins/list 는 19,000종목에 2MB 다. 같은 심볼을 쓰는 사칭 토큰이 많아
    그대로 쓰면 엉뚱한 코인을 고른다. 시가총액 상위 500종목만 받아 순위가
    높은 쪽을 채택하면 크기도 작고 오선택도 없다.
    """
    cached = cache.get("ids", MARKET_MAP_TTL)
    if cached is not None:
        return cached

    mapping = {}
    for page in (1, 2):
        url = (
            "https://api.coingecko.com/api/v3/coins/markets"
            f"?vs_currency=usd&order=market_cap_desc&per_page=250&page={page}&sparkline=false"
        )
        try:
            for row in fetch_json(url):
                symbol = (row.get("symbol") or "").upper()
                # 먼저 등장한 쪽이 시가총액이 크다.
                if symbol and symbol not in mapping:
                    mapping[symbol] = row["id"]
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            break

    if mapping:
        cache.put("ids", mapping)
    return mapping


def coin_votes(symbol):
    key = f"votes:{symbol}"
    cached = cache.get(key, COIN_VOTE_TTL)
    if cached is not None:
        return cached

    coin_id = symbol_to_id().get(symbol)
    if not coin_id:
        return None

    url = (
        f"https://api.coingecko.com/api/v3/coins/{urllib.parse.quote(coin_id)}"
        "?localization=false&tickers=false&market_data=true"
        "&community_data=false&developer_data=false&sparkline=false"
    )
    try:
        data = fetch_json(url)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        return None

    market = data.get("market_data") or {}
    votes = {
        "id": coin_id,
        "up": data.get("sentiment_votes_up_percentage"),
        "change24h": market.get("price_change_percentage_24h"),
    }
    cache.put(key, votes)
    return votes


def collect_sentiment(symbols):
    key = "sentiment:" + ",".join(sorted(symbols))
    cached = cache.get(key, SENTIMENT_TTL)
    if cached is not None:
        return cached

    fear_greed = None
    try:
        entry = fetch_json("https://api.alternative.me/fng/?limit=1")["data"][0]
        fear_greed = {
            "value": int(entry["value"]),
            "label": entry.get("value_classification"),
            "at": int(entry["timestamp"]) * 1000,
        }
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError, IndexError):
        fear_greed = None

    trending = []
    try:
        data = fetch_json("https://api.coingecko.com/api/v3/search/trending")
        trending = [
            (item.get("item") or {}).get("symbol", "").upper() for item in data.get("coins", [])
        ]
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        trending = []

    payload = {
        "fearGreed": fear_greed,
        "trending": [symbol for symbol in trending if symbol],
        "coins": {symbol: coin_votes(symbol) for symbol in symbols},
        "fetchedAt": int(time.time() * 1000),
    }
    cache.put(key, payload)
    return payload


class Handler(SimpleHTTPRequestHandler):
    """정적 파일은 그대로 넘기고 /api/* 만 가로챈다."""

    protocol_version = "HTTP/1.1"

    def end_headers(self):  # noqa: N802 - 표준 라이브러리 규약
        # SimpleHTTPRequestHandler 는 정적 파일에 Last-Modified 만 붙이고
        # Cache-Control 은 안 준다. 그러면 브라우저가 휴리스틱 캐시로 옛 파일을
        # 재검증 없이 계속 물고, ESM 모듈 그래프에서 한 파일만 갱신되면
        # "does not provide an export named X" 로 화면이 통째로 죽는다.
        # 이 서버는 개발용이고 파일이 자주 바뀌므로 매 요청 재검증하게 한다
        # (변경 없으면 304 라 비용은 거의 없다). /api/ 는 send_json 이 직접 헤더를
        # 세팅하므로 건드리지 않는다.
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):  # noqa: N802 - 표준 라이브러리 규약
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == "/api/news":
            self.send_json(collect_news())
            return

        if parsed.path == "/api/sentiment":
            query = urllib.parse.parse_qs(parsed.query)
            raw = (query.get("coins") or [""])[0]
            symbols = [s.strip().upper() for s in raw.split(",") if s.strip()][:12]
            self.send_json(collect_sentiment(symbols))
            return

        super().do_GET()

    def send_json(self, payload):
        try:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        except (TypeError, ValueError) as error:
            body = json.dumps({"error": str(error)}).encode("utf-8")

        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        # 브라우저가 다른 포트에서 열려 있어도 쓸 수 있게 열어 둔다.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # 정적 파일 요청 로그는 시끄러우니 /api/ 경로만 남긴다. send_error 는 첫 인자로
        # 문자열이 아닌 HTTPStatus 를 넘기므로(그대로 두면 "not iterable" TypeError 로
        # 그 요청 스레드가 죽는다) str() 로 감싸 방어한다.
        first = str(args[0]) if args else ""
        if "/api/" in first:
            super().log_message(fmt, *args)


def main():
    handler = partial(Handler, directory=".")
    with ThreadingHTTPServer(("", PORT), handler) as server:
        print(f"signal-desk → http://localhost:{PORT}  (뉴스 중계 포함)")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\n종료")


if __name__ == "__main__":
    main()
