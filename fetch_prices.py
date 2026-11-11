"""백팀 주가 받기.

sectors.json에 있는 모든 티커(기준 + 회사)의 5년 일별 종가를 야후 파이낸스에서 받아
data/prices.json에 저장한다.

- 원래 종가(close)를 쓴다. 배당은 반영하지 않고, 주식 분할은 야후가 반영해 준 값이다.
- 장이 아직 끝나지 않은 오늘 값(장중 값)은 버리고, 마감된 종가만 남긴다.
- 받지 못한 종목은 이전에 받아 둔 데이터를 그대로 두고, 로그와 prices.json의 failed 목록에 남긴다.
- 파이썬 기본 기능만 사용 (추가 설치 필요 없음).

실행: python fetch_prices.py
"""

import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SECTORS_FILE = ROOT / "sectors.json"
PRICES_FILE = ROOT / "data" / "prices.json"
LOG_FILE = ROOT / "data" / "last_run_log.txt"

HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]
URL = "https://{host}/v8/finance/chart/{ticker}?range=5y&interval=1d"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "application/json",
}
KST = timezone(timedelta(hours=9))

log_lines = []


def log(msg):
    line = f"[{datetime.now(KST).strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    log_lines.append(line)
    try:
        print(line, flush=True)
    except UnicodeEncodeError:
        print(line.encode("ascii", "replace").decode(), flush=True)


def all_tickers():
    sectors = json.loads(SECTORS_FILE.read_text(encoding="utf-8"))["sectors"]
    seen = []
    for s in sectors:
        for b in s["benchmarks"]:
            if b["ticker"] not in seen:
                seen.append(b["ticker"])
        for c in s["companies"]:
            if c["ticker"] not in seen:
                seen.append(c["ticker"])
    return seen


def download(ticker):
    """야후에서 한 종목을 받아 원본 JSON을 돌려준다. 실패하면 예외."""
    last_err = None
    for attempt in range(3):
        host = HOSTS[attempt % len(HOSTS)]
        url = URL.format(host=host, ticker=urllib.request.quote(ticker))
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            last_err = f"HTTP {e.code}"
            if e.code == 404:
                break  # 없는 티커: 다시 해도 소용없음
        except Exception as e:  # 네트워크 오류 등
            last_err = f"{type(e).__name__}: {e}"
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(last_err or "알 수 없는 오류")


def _day(ts, offset):
    return datetime.fromtimestamp(ts + offset, tz=timezone.utc).strftime("%Y-%m-%d")


def parse(raw):
    """원본 JSON → (meta 요약, 날짜 목록, 종가 목록). 마감 안 된 오늘 값은 뺀다."""
    chart = raw.get("chart") or {}
    if chart.get("error"):
        raise RuntimeError(f"야후 오류: {chart['error'].get('description') or chart['error']}")
    res = (chart.get("result") or [None])[0]
    if not res or not res.get("timestamp"):
        raise RuntimeError("가격 데이터가 비어 있음")

    meta = res.get("meta", {})
    offset = meta.get("gmtoffset", 0) or 0
    stamps = res["timestamp"]
    closes = res["indicators"]["quote"][0].get("close") or []

    # 장이 아직 진행 중이면 마지막 봉(오늘 장중 값)을 버린다.
    now = time.time()
    regular = (meta.get("currentTradingPeriod") or {}).get("regular") or {}
    start, end = regular.get("start"), regular.get("end")
    if start and end and start <= now < end and stamps and stamps[-1] >= start:
        stamps, closes = stamps[:-1], closes[:-1]

    # 장이 끝났는데 마지막 날 종가 칸이 비어 있으면(야후가 늦게 채우는 경우),
    # 같은 날 마감 시각에 기록된 공식 마감가(regularMarketPrice)로 채운다.
    rm_price, rm_time = meta.get("regularMarketPrice"), meta.get("regularMarketTime")
    market_open = bool(start and end and start <= now < end)
    if (stamps and closes and closes[-1] is None and rm_price and rm_time
            and not market_open and rm_time >= stamps[-1]
            and _day(rm_time, offset) == _day(stamps[-1], offset)):
        closes = list(closes[:-1]) + [rm_price]

    by_date = {}
    for ts, c in zip(stamps, closes):
        if c is None:
            continue
        d = datetime.fromtimestamp(ts + offset, tz=timezone.utc).strftime("%Y-%m-%d")
        by_date[d] = round(float(c), 4)  # 같은 날짜가 두 번 오면 나중 값

    dates = sorted(by_date)
    if not dates:
        raise RuntimeError("유효한 종가가 없음")
    info = {
        "currency": meta.get("currency"),
        "exchange": meta.get("exchangeName"),
        "yahoo_name": meta.get("longName") or meta.get("shortName"),
    }
    return info, dates, [by_date[d] for d in dates]


def main():
    tickers = all_tickers()
    old = {}
    if PRICES_FILE.exists():
        try:
            old = json.loads(PRICES_FILE.read_text(encoding="utf-8")).get("tickers", {})
        except Exception as e:
            log(f"이전 prices.json을 읽지 못함 ({e}). 새로 만든다.")

    now_iso = datetime.now(KST).isoformat(timespec="seconds")
    out, failed = {}, []
    log(f"시작: 종목 {len(tickers)}개")

    for i, t in enumerate(tickers, 1):
        try:
            info, dates, closes = parse(download(t))
            out[t] = {**info, "fetched_at": now_iso, "dates": dates, "close": closes}
            log(f"  ({i}/{len(tickers)}) {t}: 성공, {dates[0]} ~ {dates[-1]} ({len(dates)}일)")
        except Exception as e:
            reason = str(e)
            if t in old:
                out[t] = old[t]  # 이전 데이터를 그대로 둔다
                last = old[t]["dates"][-1] if old[t].get("dates") else None
                failed.append({"ticker": t, "reason": reason, "kept_old_data": True, "last_date": last})
                log(f"  ({i}/{len(tickers)}) {t}: 실패 ({reason}) → 이전 데이터 유지 (마지막 {last})")
            else:
                failed.append({"ticker": t, "reason": reason, "kept_old_data": False, "last_date": None})
                log(f"  ({i}/{len(tickers)}) {t}: 실패 ({reason}) → 데이터 없음, 화면에서 빠짐")
        time.sleep(0.4)  # 야후에 너무 빨리 요청하지 않도록

    ok = len(tickers) - len(failed)
    payload = {
        "updated_at": now_iso,
        "source": "Yahoo Finance chart API (query1.finance.yahoo.com/v8/finance/chart), 일별 종가",
        "tickers": out,
        "failed": failed,
    }
    PRICES_FILE.parent.mkdir(parents=True, exist_ok=True)
    if ok == 0 and old:
        log("모든 종목이 실패했다. 기존 prices.json을 건드리지 않는다.")
    else:
        PRICES_FILE.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        log(f"저장: {PRICES_FILE.relative_to(ROOT)}")
    log(f"끝: 성공 {ok}개, 실패 {len(failed)}개" + (f" ({', '.join(f['ticker'] for f in failed)})" if failed else ""))
    LOG_FILE.write_text("\n".join(log_lines) + "\n", encoding="utf-8")
    return 1 if ok == 0 else 0


if __name__ == "__main__":
    sys.exit(main())
