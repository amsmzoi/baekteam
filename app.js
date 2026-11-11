/* 백팀 주가 흐름 — 정적 사이트 스크립트
   sectors.json(회사 목록)과 data/prices.json(종가)을 읽어 차트·범례·표를 그린다. */
(function () {
  "use strict";

  var PERIODS = [
    { id: "5y", label: "5년", years: 5 },
    { id: "1y", label: "1년", years: 1 },
    { id: "6m", label: "6개월", months: 6 },
    { id: "3m", label: "3개월", months: 3 },
    { id: "7d", label: "7일", days: 7 }
  ];
  var GAP = 20;            // 기준과 이만큼(%p) 넘게 차이 나면 앞섬/뒤처짐 표시
  var NCOLOR = 8;          // 회사 색 개수. 9번째부터는 점선을 섞는다
  var DASHES = ["", "6 3", "2 3", "8 3 2 3"];

  var state = { period: "1y", sector: "01", focus: null };
  var SECTORS, PRICES, END;
  var $ = function (id) { return document.getElementById(id); };

  // ---------- 숫자·날짜 ----------
  function fmt(x) {
    if (x == null || !isFinite(x)) return "–";
    var r = Math.round(x * 10) / 10;
    if (Math.abs(r) < 0.05) r = 0;
    return (r > 0 ? "+" : "") + r.toFixed(1);
  }
  function pct(x) { return fmt(x) + "%"; }
  function pp(x) { return fmt(x) + "%p"; }
  function toMs(d) { return Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)); }
  function toStr(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function periodStart(end, p) {
    var t = new Date(toMs(end));
    if (p.years) t.setUTCFullYear(t.getUTCFullYear() - p.years);
    if (p.months) t.setUTCMonth(t.getUTCMonth() - p.months);
    if (p.days) t.setUTCDate(t.getUTCDate() - p.days);
    return toStr(t.getTime());
  }
  function addDays(d, n) { return toStr(toMs(d) + n * 864e5); }
  // 정렬된 날짜 배열에서 d 이상인 첫 위치
  function lowerBound(arr, d) {
    var lo = 0, hi = arr.length;
    while (lo < hi) { var m = (lo + hi) >> 1; if (arr[m] < d) lo = m + 1; else hi = m; }
    return lo;
  }
  // d 당일 또는 그 직전 거래일 위치 (없으면 -1)
  function asOf(arr, d) {
    var i = lowerBound(arr, d);
    if (i < arr.length && arr[i] === d) return i;
    return i - 1;
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  // ---------- 계산 ----------
  // 한 종목을 기간 시작일부터 잘라 0% 기준으로 바꾼다
  function slice(ticker, start) {
    var s = PRICES.tickers[ticker];
    if (!s || !s.dates || !s.dates.length) return null;
    var i0 = lowerBound(s.dates, start);
    if (i0 >= s.dates.length) return null;
    var base = s.close[i0], dates = s.dates.slice(i0), vals = [];
    for (var i = i0; i < s.close.length; i++) vals.push((s.close[i] / base - 1) * 100);
    var n = s.close.length;
    return {
      ticker: ticker, dates: dates, vals: vals, base: base,
      first: dates[0], last: dates[dates.length - 1],
      chg: vals[vals.length - 1],
      day: n >= 2 ? (s.close[n - 1] / s.close[n - 2] - 1) * 100 : null,
      late: i0 === 0 && s.dates[0] > addDays(start, 7)   // 기간 중간에 상장·분리
    };
  }
  // 기준(bench)을 fromDate(포함 또는 직전 거래일)부터 다시 0%로 맞췄을 때, d 시점 변화율
  function benchFrom(bench, fromDate, d) {
    var s = PRICES.tickers[bench];
    if (!s) return null;
    var i0 = asOf(s.dates, fromDate); if (i0 < 0) i0 = 0;
    var i1 = asOf(s.dates, d); if (i1 < 0) return null;
    return { val: (s.close[i1] / s.close[i0] - 1) * 100, date: s.dates[i1] };
  }

  function computeSector(sec, start) {
    var benches = sec.benchmarks.map(function (b, i) {
      var sl = slice(b.ticker, start);
      return { ticker: b.ticker, name: b.name, idx: i, sl: sl };
    });
    var bmap = {}; benches.forEach(function (b) { bmap[b.ticker] = b; });
    var comps = sec.companies.map(function (c, i) {
      var sl = slice(c.ticker, start), b = bmap[c.benchmark], bchg = null;
      if (sl && b && b.sl) {
        bchg = sl.late ? (benchFrom(c.benchmark, sl.first, b.sl.last) || {}).val : b.sl.chg;
      }
      return {
        ticker: c.ticker, name: c.name, bench: c.benchmark, idx: i, sl: sl,
        chg: sl ? sl.chg : null, bchg: bchg,
        diff: sl && bchg != null ? sl.chg - bchg : null,
        sector: sec
      };
    });
    return { sec: sec, benches: benches, comps: comps };
  }

  // ---------- 그리기: 버튼 ----------
  function renderButtons() {
    $("periods").innerHTML = PERIODS.map(function (p) {
      return '<button type="button" data-p="' + p.id + '" aria-pressed="' + (p.id === state.period) + '">' + p.label + "</button>";
    }).join("");
    $("sectors").innerHTML = SECTORS.map(function (s) {
      return '<button type="button" data-s="' + s.id + '" aria-pressed="' + (s.id === state.sector) + '"><span class="n">' + s.id + "</span>" + esc(s.name) + "</button>";
    }).join("");
  }

  // ---------- 그리기: 차트 ----------
  function styleOf(kind, idx) {
    if (kind === "bench") return { color: "var(--ink)", width: 3, dash: idx === 0 ? "" : "7 4" };
    return { color: "var(--s" + ((idx % NCOLOR) + 1) + ")", width: 1.6, dash: DASHES[Math.floor(idx / NCOLOR) % DASHES.length] };
  }
  function swatch(st) {
    return '<svg width="28" height="10" aria-hidden="true"><line x1="1" y1="5" x2="27" y2="5" style="stroke:' + st.color +
      ";stroke-width:" + Math.min(st.width + 0.6, 3) + (st.dash ? ";stroke-dasharray:" + st.dash : "") + ';stroke-linecap:round"/></svg>';
  }

  var chartCtx = null;

  function renderChart(view, start) {
    var box = $("chart"), svg = $("svg");
    var W = Math.max(280, box.clientWidth), H = W < 560 ? 300 : W < 900 ? 380 : 440;
    var m = { l: 44, r: 10, t: 10, b: 26 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;

    var series = [];
    view.benches.forEach(function (b) { if (b.sl) series.push({ kind: "bench", key: "b:" + b.ticker, d: b, sl: b.sl, st: styleOf("bench", b.idx) }); });
    view.comps.forEach(function (c) { if (c.sl) series.push({ kind: "comp", key: c.ticker, d: c, sl: c.sl, st: styleOf("comp", c.idx) }); });

    var x0 = toMs(start), x1 = toMs(END);
    series.forEach(function (s) { x0 = Math.min(x0, toMs(s.sl.first)); });
    var lo = 0, hi = 0;
    series.forEach(function (s) { s.sl.vals.forEach(function (v) { if (v < lo) lo = v; if (v > hi) hi = v; }); });
    var pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
    var step = niceStep((hi - lo) / (H < 340 ? 5 : 7));
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;

    var X = function (ms) { return m.l + (x1 === x0 ? iw / 2 : (ms - x0) / (x1 - x0) * iw); };
    var Y = function (v) { return m.t + (hi - v) / (hi - lo) * ih; };

    var out = [];
    // 가로 눈금
    for (var v = lo; v <= hi + 1e-9; v += step) {
      var y = Y(v).toFixed(1), zero = Math.abs(v) < 1e-9;
      if (!zero) out.push('<line x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + y + '" y2="' + y + '" style="stroke:var(--grid);stroke-width:1"/>');
      out.push('<text x="' + (m.l - 6) + '" y="' + y + '" dy="0.32em" text-anchor="end">' + (v > 0 ? "+" : "") + (Math.round(v * 10) / 10) + "%</text>");
    }
    // 세로 눈금: 첫 기준의 날짜 중 고르게
    var ref = series[0] ? series[0].sl.dates : [];
    var nt = Math.max(2, Math.min(ref.length, Math.floor(iw / 105)));
    for (var k = 0; k < nt && ref.length; k++) {
      var di = Math.round(k * (ref.length - 1) / Math.max(1, nt - 1)), xx = X(toMs(ref[di]));
      var anchor = k === 0 ? "start" : k === nt - 1 ? "end" : "middle";
      out.push('<text x="' + xx.toFixed(1) + '" y="' + (H - 6) + '" text-anchor="' + anchor + '">' + ref[di] + "</text>");
    }
    // 선: 회사 먼저, 기준을 위에
    var ordered = series.filter(function (s) { return s.kind === "comp"; }).concat(series.filter(function (s) { return s.kind === "bench"; }));
    ordered.forEach(function (s) {
      var dstr = "";
      for (var i = 0; i < s.sl.dates.length; i++) {
        dstr += (i ? "L" : "M") + X(toMs(s.sl.dates[i])).toFixed(1) + " " + Y(s.sl.vals[i]).toFixed(1);
      }
      if (s.sl.dates.length === 1) dstr += "h0.1";
      out.push('<path class="ln" data-k="' + esc(s.key) + '" d="' + dstr + '" style="fill:none;stroke:' + s.st.color + ";stroke-width:" + s.st.width +
        (s.st.dash ? ";stroke-dasharray:" + s.st.dash : "") + ';stroke-linejoin:round;stroke-linecap:round"/>');
    });
    // 0% 선 (진하게)
    if (lo <= 0 && hi >= 0) out.push('<line x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + Y(0).toFixed(1) + '" y2="' + Y(0).toFixed(1) + '" style="stroke:var(--zero);stroke-width:1.5"/>');
    // 마우스 표시용
    out.push('<line id="xh" y1="' + m.t + '" y2="' + (m.t + ih) + '" style="stroke:var(--ink-3);stroke-width:1;stroke-dasharray:3 3" visibility="hidden"/>');
    out.push('<circle id="dot" r="4.5" style="stroke:var(--surface);stroke-width:2" visibility="hidden"/>');
    out.push('<rect id="hit" x="' + m.l + '" y="0" width="' + iw + '" height="' + H + '" style="fill:transparent"/>');

    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("height", H);
    svg.innerHTML = out.join("");
    chartCtx = { series: series, X: X, Y: Y, x0: x0, x1: x1, m: m, iw: iw, W: W, H: H, view: view };
    applyFocus();
  }
  function niceStep(raw) {
    var p = Math.pow(10, Math.floor(Math.log10(raw || 1))), n = raw / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
  }

  // 화면 위치(px) → 가장 가까운 선과 그 날짜
  function nearest(px, py) {
    var c = chartCtx; if (!c || !c.series.length) return null;
    var ms = c.x0 + (px - c.m.l) / c.iw * (c.x1 - c.x0);
    var best = null;
    c.series.forEach(function (s) {
      var ds = s.sl.dates, target = toStr(ms), i = lowerBound(ds, target);
      if (i >= ds.length) i = ds.length - 1;
      if (i > 0 && Math.abs(toMs(ds[i - 1]) - ms) < Math.abs(toMs(ds[i]) - ms)) i--;
      if (ms < toMs(ds[0]) - 3 * 864e5) return; // 아직 상장 전
      var dist = Math.abs(c.Y(s.sl.vals[i]) - py);
      if (state.focus && s.key === state.focus) dist = -1;
      else if (state.focus) dist += 1e6;
      if (!best || dist < best.dist) best = { s: s, i: i, dist: dist };
    });
    return best;
  }

  function showTip(px, py) {
    var c = chartCtx, hit = nearest(px, py), tip = $("tip");
    if (!hit) { hideTip(); return; }
    var s = hit.s, d = s.sl.dates[hit.i], v = s.sl.vals[hit.i];
    var xh = $("xh"), dot = $("dot"), cx = c.X(toMs(d)), cy = c.Y(v);
    xh.setAttribute("x1", cx); xh.setAttribute("x2", cx); xh.setAttribute("visibility", "visible");
    dot.setAttribute("cx", cx); dot.setAttribute("cy", cy); dot.style.fill = s.st.color; dot.setAttribute("visibility", "visible");

    var h = '<div class="d">' + d + "</div>";
    if (s.kind === "bench") {
      h += '<div class="r"><span>' + esc(s.d.name) + "</span><span>" + pct(v) + "</span></div>";
      h += '<div class="sm">기준 · ' + esc(s.d.ticker) + "</div>";
    } else {
      var comp = s.d, b = c.view.benches.filter(function (x) { return x.ticker === comp.bench; })[0];
      h += '<div class="r"><span>' + esc(comp.name) + " " + esc(comp.ticker) + "</span><span>" + pct(v) + "</span></div>";
      var bv = null;
      if (b && b.sl) bv = benchFrom(comp.bench, s.sl.late ? s.sl.first : b.sl.first, d);
      if (bv) {
        h += '<div class="r"><span>같은 날 기준 ' + esc(comp.bench) + "</span><span>" + pct(bv.val) + "</span></div>";
        h += '<div class="r"><span>차이</span><span>' + pp(v - bv.val) + "</span></div>";
        if (bv.date !== d) h += '<div class="sm">기준은 그날 장이 없어 ' + bv.date + " 값</div>";
      } else {
        h += '<div class="sm">같은 날 기준 값 없음</div>';
      }
      if (s.sl.late) h += '<div class="sm">상장 후 첫 거래일 ' + s.sl.first + " 종가 기준. 기준도 같은 날부터 계산.</div>";
    }
    tip.innerHTML = h; tip.hidden = false;
    var tw = tip.offsetWidth, th = tip.offsetHeight, bw = $("chart").clientWidth;
    var left = cx + 12; if (left + tw > bw) left = cx - tw - 12; if (left < 0) left = Math.max(0, Math.min(bw - tw, cx - tw / 2));
    var top = cy - th - 12; if (top < 0) top = Math.min(cy + 12, c.H - th);
    tip.style.left = left + "px"; tip.style.top = top + "px";
  }
  function hideTip() {
    $("tip").hidden = true;
    var xh = $("xh"), dot = $("dot");
    if (xh) xh.setAttribute("visibility", "hidden");
    if (dot) dot.setAttribute("visibility", "hidden");
  }

  function applyFocus() {
    var f = state.focus, c = chartCtx, keep = {};
    if (f && c) {
      keep[f] = true;
      c.series.forEach(function (s) { if (s.key === f && s.kind === "comp") keep["b:" + s.d.bench] = true; });
    }
    document.querySelectorAll("#svg .ln").forEach(function (p) {
      var k = p.getAttribute("data-k");
      p.style.opacity = !f || keep[k] ? 1 : 0.14;
      if (k === f && k.indexOf("b:") !== 0) p.style.strokeWidth = 3;
      else if (k.indexOf("b:") !== 0) p.style.strokeWidth = 1.6;
      if (k === f) p.parentNode.appendChild(p); // 맨 위로
    });
    document.querySelectorAll("#legend li, #legendBench li").forEach(function (li) {
      var k = li.getAttribute("data-k");
      li.classList.toggle("on", !!f && k === f);
      li.classList.toggle("dim", !!f && !keep[k]);
    });
  }
  function toggleFocus(k) { state.focus = state.focus === k ? null : k; applyFocus(); }

  // ---------- 그리기: 설명·범례·표 ----------
  function tag(diff) {
    if (diff == null) return "";
    if (diff > GAP) return '<span class="tag good">앞섬 ' + fmt(diff) + "</span>";
    if (diff < -GAP) return '<span class="tag bad">뒤처짐 ' + fmt(diff) + "</span>";
    return "";
  }

  function renderText(view, period) {
    var bs = view.benches.filter(function (b) { return b.sl; });
    var comps = view.comps.filter(function (c) { return c.diff != null; });
    var big = comps.filter(function (c) { return Math.abs(c.diff) > GAP; }).length;
    var failed = view.comps.filter(function (c) { return !c.sl; }).length;
    var t = "기준 " + period.label + " 변화: " + (bs.length ? bs.map(function (b) { return "<b>" + esc(b.ticker) + " " + pct(b.sl.chg) + "</b>"; }).join(", ") : "받지 못함") + ". ";
    if (comps.length) {
      t += big ? "회사 " + comps.length + "곳 중 <b>" + big + "곳</b>이 기준과 " + GAP + "%p 넘게 달랐어요."
               : "회사 " + comps.length + "곳 모두 기준과 " + GAP + "%p 안쪽으로 움직였어요.";
    }
    if (failed) t += " (받지 못한 " + failed + "곳 제외)";
    $("note").innerHTML = t;

    // 기준은 맨 위 한 줄, 회사는 변화율 높은 순(위→아래, 그다음 옆 칸)으로 순위 번호를 붙인다
    var bItems = [], items = [];
    view.benches.forEach(function (b) {
      if (!b.sl) return;
      bItems.push('<li class="bench" data-k="b:' + esc(b.ticker) + '"><button type="button">' + swatch(styleOf("bench", b.idx)) +
        '<span class="nm">' + esc(b.name) + '<span class="tk">' + esc(b.ticker) + '</span><span class="tag">기준</span></span><span class="val">' + pct(b.sl.chg) + "</span></button></li>");
    });
    view.comps.filter(function (c) { return c.sl; }).sort(function (a, b) { return b.chg - a.chg; }).forEach(function (c, i) {
      var extra = "";
      if (view.benches.length > 1 && c.bench !== view.benches[0].ticker) extra += '<span class="tag">비교: ' + esc(c.bench) + "</span>";
      if (c.sl.late) extra += '<span class="tag">상장 후부터</span>';
      items.push('<li data-k="' + esc(c.ticker) + '"><button type="button"><span class="rk">' + (i + 1) + "</span>" + swatch(styleOf("comp", c.idx)) +
        '<span class="nm">' + esc(c.name) + '<span class="tk">' + esc(c.ticker) + "</span>" + extra + tag(c.diff) + '</span><span class="val">' + pct(c.chg) + "</span></button></li>");
    });
    $("legendBench").innerHTML = bItems.join("");
    $("legend").innerHTML = items.join("");
  }

  // 표 정렬: 기본은 기간 변화율 높은 순. 열 이름을 누르면 그 열로 정렬(다시 누르면 반대로).
  var SORT = { tSector: { key: "chg", dir: -1 }, tTop: { key: "chg", dir: -1 } };
  var SORTVAL = {
    name: function (c) { return c.name; },
    sector: function (c) { return c.sector.id; },
    chg: function (c) { return c.chg; },
    diff: function (c) { return c.diff; },
    day: function (c) { return c.sl.day == null ? -Infinity : c.sl.day; }
  };
  function sortRows(rows, id) {
    var s = SORT[id], f = SORTVAL[s.key];
    return rows.slice().sort(function (a, b) {
      var x = f(a), y = f(b);
      var c = typeof x === "string" ? x.localeCompare(y, "ko") : x - y;   // 오름차순 비교
      return s.dir * c || b.chg - a.chg;                                   // dir -1 = 큰 값 먼저
    });
  }
  function head(id, cols) {
    var s = SORT[id];
    return "<thead><tr>" + cols.map(function (c) {
      var on = s.key === c[0], arrow = on ? (s.dir < 0 ? " ▼" : " ▲") : "";
      return '<th aria-sort="' + (on ? (s.dir < 0 ? "descending" : "ascending") : "none") + '"><button type="button" class="sort' + (on ? " on" : "") +
        '" data-t="' + id + '" data-key="' + c[0] + '">' + c[1] + arrow + "</button></th>";
    }).join("") + "</tr></thead>";
  }

  function cls(x) { return x == null ? "" : x > GAP ? "good" : x < -GAP ? "bad" : ""; }

  function renderTables(view, all) {
    var rows = sortRows(view.comps.filter(function (c) { return c.diff != null; }), "tSector");
    $("tSector").innerHTML = head("tSector", [["name", "회사"], ["chg", "기간 변화율"], ["diff", "기준 대비"], ["day", "마지막 하루"]]) + "<tbody>" +
      rows.map(function (c) {
        return "<tr><td>" + esc(c.name) + '<span class="tk">' + esc(c.ticker) + (c.sl.late ? " · 상장 후부터" : "") + "</span></td><td>" + pct(c.chg) +
          '</td><td class="' + cls(c.diff) + '">' + pp(c.diff) + "</td><td>" + pct(c.sl.day) + "</td></tr>";
      }).join("") + "</tbody>";

    // 고르는 기준은 그대로(기준과 차이가 큰 10곳), 보여 주는 순서만 정렬
    var top = all.filter(function (c) { return c.diff != null; }).sort(function (a, b) { return Math.abs(b.diff) - Math.abs(a.diff); }).slice(0, 10);
    top = sortRows(top, "tTop");
    $("tTop").innerHTML = head("tTop", [["name", "회사"], ["sector", "섹터"], ["chg", "기간 변화율"], ["diff", "기준 대비"]]) + "<tbody>" +
      top.map(function (c) {
        return "<tr><td>" + esc(c.name) + '<span class="tk">' + esc(c.ticker) + '</span></td><td class="sec">' + c.sector.id + " " + esc(c.sector.name) +
          "</td><td>" + pct(c.chg) + '</td><td class="' + cls(c.diff) + '">' + pp(c.diff) + "</td></tr>";
      }).join("") + "</tbody>";
  }

  function renderSummary(all, period) {
    var ok = all.filter(function (c) { return c.diff != null; });
    if (!ok.length) { $("summary").textContent = ""; return; }
    var up = ok.reduce(function (a, b) { return b.diff > a.diff ? b : a; });
    var dn = ok.reduce(function (a, b) { return b.diff < a.diff ? b : a; });
    $("summary").innerHTML = period.label + " 동안 8개 섹터 전체에서 기준보다 가장 크게 앞선 회사는 <b>" + esc(up.name) + "</b>(" + up.sector.id + " " + esc(up.sector.name) + ", 기준 대비 " + pp(up.diff) +
      "), 가장 크게 뒤처진 회사는 <b>" + esc(dn.name) + "</b>(" + dn.sector.id + " " + esc(dn.sector.name) + ", " + pp(dn.diff) + ")예요.";
  }

  function renderMissing(view) {
    var none = [], stale = [];
    view.benches.concat(view.comps).forEach(function (x) { if (!x.sl) none.push(x.ticker); });
    (PRICES.failed || []).forEach(function (f) {
      if (f.kept_old_data && view.benches.concat(view.comps).some(function (x) { return x.ticker === f.ticker; })) stale.push(f.ticker + "(" + f.last_date + "까지)");
    });
    var msg = [];
    if (none.length) msg.push("받지 못함: " + none.join(", "));
    if (stale.length) msg.push("오늘 새로 받지 못해 이전 데이터로 표시: " + stale.join(", "));
    $("missing").hidden = !msg.length; $("missing").textContent = msg.join(" · ");
  }

  function renderAbout() {
    var up = PRICES.updated_at ? PRICES.updated_at.replace("T", " ").slice(0, 16) + " (한국 시간)" : "–";
    var ex = [];
    SECTORS.forEach(function (s) {
      if (s.benchmarks.length < 2) return;
      var groups = {};
      s.companies.forEach(function (c) { (groups[c.benchmark] = groups[c.benchmark] || []).push(c.name); });
      ex.push(s.id + " " + s.name + ": " + Object.keys(groups).map(function (b) { return esc(groups[b].join("·")) + "은(는) " + esc(b) + "와 비교"; }).join(", "));
    });
    var count = {};
    SECTORS.forEach(function (s) { s.companies.forEach(function (c) { (count[c.ticker] = count[c.ticker] || { name: c.name, secs: [] }).secs.push(s.id + " " + s.name); }); });
    var dup = Object.keys(count).filter(function (t) { return count[t].secs.length > 1; }).map(function (t) { return esc(count[t].name) + "(" + count[t].secs.map(esc).join(", ") + ")"; });
    var foreign = [];
    Object.keys(PRICES.tickers).forEach(function (t) { var c = PRICES.tickers[t].currency; if (c && c !== "USD") foreign.push(t + " " + c); });

    $("about").innerHTML = "<ul>" +
      "<li><b>변화율</b>: 고른 기간의 첫 거래일 종가를 0%로 놓고, 그 뒤 매일 종가가 몇 % 달라졌는지예요. 원래 종가 기준이라 <b>배당은 넣지 않았어요</b>(주식 분할은 반영). 그래서 배당을 많이 주는 회사는 실제 수익보다 낮게 보여요.</li>" +
      "<li><b>기준 대비(%p)</b>: 회사 변화율에서 같은 기간 기준의 변화율을 뺀 값이에요. 20%p 넘게 차이 나면 앞섬·뒤처짐으로 표시해요.</li>" +
      "<li><b>현지 통화</b>: 유럽·홍콩 상장 회사는 그 나라 돈 기준이에요 (" + esc(foreign.join(", ")) + "). 달러로 바꾼 값이 아니라서 환율 변화는 들어 있지 않아요.</li>" +
      "<li><b>날짜</b>: 나라마다 휴장일과 장 마감 시각이 달라요. 각 종목은 자기 거래일 날짜대로 그려요. 말풍선의 '같은 날 기준'은 그날 기준 장이 없으면 직전 거래일 값을 써요.</li>" +
      "<li><b>상장 후부터</b>: 고른 기간보다 늦게 상장·분리된 회사(예: GE 버노바 2024년, 베랄토 2023년)는 첫 거래일 종가를 0%로 놓아요. 이때 기준 대비는 기준도 그 회사 첫 거래일부터 다시 계산해서 비교해요.</li>" +
      "<li><b>비교 기준 예외</b>: 회사마다 섹터의 첫 번째 기준과 비교하는 게 기본이에요. 예외: " + ex.join(" / ") + ".</li>" +
      "<li><b>두 섹터에 나오는 회사</b>: " + dup.join(", ") + ". 본체 사업과 확장 사업이 다른 섹터라 두 곳 모두에 넣었어요. 섹터마다 비교하는 기준이 달라서 기준 대비 값도 섹터마다 달라요.</li>" +
      "<li><b>마지막 하루</b>: 그 회사의 마지막 거래일 종가가 직전 거래일보다 몇 % 달라졌는지예요.</li>" +
      "<li><b>데이터 출처</b>: 야후 파이낸스(무료, 공식 서비스 아님). 매일 한국 시간 아침 7시 30분쯤 마감된 종가만 받아요. 야후가 늦게 올리는 날은 하루 늦게 반영될 수 있어요.</li>" +
      "<li><b>마지막 업데이트</b>: " + up + " · 데이터 마지막 날짜 " + END + "</li>" +
      "</ul>";
  }

  // ---------- 전체 ----------
  function render() {
    var period = PERIODS.filter(function (p) { return p.id === state.period; })[0];
    var start = periodStart(END, period);
    var views = SECTORS.map(function (s) { return computeSector(s, start); });
    var all = [];
    views.forEach(function (v) { all = all.concat(v.comps); });
    var view = views.filter(function (v) { return v.sec.id === state.sector; })[0];

    renderButtons();
    renderSummary(all, period);
    $("chartTitle").textContent = view.sec.id + " " + view.sec.name + " · " + period.label + " (" + start + " ~ " + END + ")";
    renderMissing(view);
    renderText(view, period);
    renderTables(view, all);
    renderChart(view, start);
    hideTip();
    try { history.replaceState(null, "", "#s=" + state.sector + "&p=" + state.period); } catch (e) {}
  }

  function bind() {
    $("periods").addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      state.period = b.getAttribute("data-p"); render();
    });
    $("sectors").addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      state.sector = b.getAttribute("data-s"); state.focus = null; render();
    });
    ["legend", "legendBench"].forEach(function (id) {
      $(id).addEventListener("click", function (e) {
        var li = e.target.closest("li"); if (li) toggleFocus(li.getAttribute("data-k"));
      });
    });
    document.querySelector(".tables").addEventListener("click", function (e) {
      var b = e.target.closest("button.sort"); if (!b) return;
      var s = SORT[b.getAttribute("data-t")], k = b.getAttribute("data-key");
      if (s.key === k) s.dir = -s.dir;
      else { s.key = k; s.dir = (k === "name" || k === "sector") ? 1 : -1; }
      render();
    });
    var box = $("chart");
    function pos(e) { var r = $("svg").getBoundingClientRect(); return [(e.clientX - r.left) * (chartCtx.W / r.width), (e.clientY - r.top) * (chartCtx.H / r.height)]; }
    box.addEventListener("pointermove", function (e) { if (chartCtx) { var p = pos(e); showTip(p[0], p[1]); } });
    box.addEventListener("pointerdown", function (e) { if (chartCtx) { var p = pos(e); showTip(p[0], p[1]); } });
    box.addEventListener("pointerleave", function (e) { if (e.pointerType === "mouse") hideTip(); });
    box.addEventListener("click", function (e) {
      if (!chartCtx) return;
      var p = pos(e);
      var saved = state.focus; state.focus = null;
      var h2 = nearest(p[0], p[1]); state.focus = saved;
      if (h2 && h2.dist < 18) toggleFocus(h2.s.key);
      else if (state.focus) toggleFocus(state.focus);
      showTip(p[0], p[1]);
    });
    var t;
    window.addEventListener("resize", function () { clearTimeout(t); t = setTimeout(render, 150); });
  }

  function readHash() {
    var h = location.hash.slice(1).split("&");
    h.forEach(function (kv) {
      var a = kv.split("=");
      if (a[0] === "s" && SECTORS.some(function (s) { return s.id === a[1]; })) state.sector = a[1];
      if (a[0] === "p" && PERIODS.some(function (p) { return p.id === a[1]; })) state.period = a[1];
    });
  }

  function load(url) {
    return fetch(url + "?v=" + Date.now(), { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(url + " " + r.status);
      return r.json();
    });
  }

  Promise.all([load("sectors.json"), load("data/prices.json")]).then(function (res) {
    SECTORS = res[0].sectors; PRICES = res[1];
    END = "";
    Object.keys(PRICES.tickers).forEach(function (t) { var d = PRICES.tickers[t].dates; if (d && d.length && d[d.length - 1] > END) END = d[d.length - 1]; });
    $("updated").textContent = "마지막 업데이트: " + (PRICES.updated_at || "").slice(0, 10) + " · 데이터 마지막 날짜 " + END;
    readHash(); bind(); renderAbout(); render();
  }).catch(function (e) {
    $("updated").textContent = "데이터를 불러오지 못했어요. (" + e.message + ") 파일을 직접 열었다면 README의 '내 컴퓨터에서 보기'를 참고하세요.";
  });
})();
