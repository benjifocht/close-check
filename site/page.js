import { evaluate, streaks, fmtPrice, fmtVol, fmtDate, pctStr, niceTicks, RISK, preset, rollingRatios, countHeavy, levelChips, supportChips } from "./logic.js";

  var $ = function (id) { return document.getElementById(id); };
  var saved = null, cfg = null, rd = null, dirty = false, lastW = 0, loadErr = false;
  var why = { key: "", sup: "", mult: "" };

  function setChip(el, cls, text) { el.className = "chip" + (cls ? " " + cls : ""); el.textContent = text; }

  function fmtChecked(iso) {
    try {
      var d = new Date(iso); if (isNaN(d)) return "";
      return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d) + " ET";
    } catch (e) { return ""; }
  }

  function usable() {
    return cfg && rd && rd.ticker === cfg.ticker && typeof rd.close === "number" && cfg.keyLevel > 0 && cfg.supportLevel > 0;
  }

  function showNotice(t) { var n = $("notice"); if (t) { n.textContent = t; n.hidden = false; } else { n.hidden = true; } }

  function etParts(d) {
    var p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(d || new Date());
    var g = function (t) { return p.filter(function (x) { return x.type === t; })[0].value; };
    return { date: g("year") + "-" + g("month") + "-" + g("day"), minutes: parseInt(g("hour"), 10) * 60 + parseInt(g("minute"), 10), weekend: g("weekday") === "Sat" || g("weekday") === "Sun" };
  }
  function repoActionsUrl() {
    var m = location.hostname.match(/^([^.]+)\.github\.io$/), seg = location.pathname.split("/").filter(Boolean)[0];
    return m && seg ? "https://github.com/" + m[1] + "/" + seg + "/actions/workflows/check.yml" : null;
  }
  // Live preview: the verdict, chart and numbers follow what is typed in the form, before anything is saved.
  function applyDraft() {
    if (!saved) { cfg = null; return; }
    var key = parseFloat($("f-key").value), sup = parseFloat($("f-sup").value), mult = parseFloat($("f-mult").value);
    var ok = key > 0 && sup > 0 && key > sup && mult >= 1 && mult <= 5;
    var same = ok && key === saved.keyLevel && sup === saved.supportLevel && mult === (saved.volumeMultiple || 1.5);
    cfg = ok && !same ? { ticker: saved.ticker, keyLevel: key, supportLevel: sup, volumeMultiple: mult } : saved;
  }
  function sync() { applyDraft(); render(); }
  function renderLive() {
    var box = $("live"), et = etParts(), open = !et.weekend && et.minutes >= 9 * 60 + 30 && et.minutes < 16 * 60 + 5;
    var lv = rd && rd.live && rd.live.date === et.date && cfg && rd.ticker === cfg.ticker ? rd.live : null;
    var link = $("live-run"), url = repoActionsUrl();
    if (!lv && !open) { box.hidden = true; return; }
    box.hidden = false;
    if (url) { link.href = url; link.hidden = false; } else { link.hidden = true; }
    if (!lv) {
      $("live-main").textContent = "No snapshot yet today";
      $("live-sub").textContent = "A snapshot is taken around 9:50 AM ET. The verdict above always uses the last full close.";
      return;
    }
    var chg = (lv.price / lv.prevClose - 1) * 100;
    $("live-main").textContent = "$" + fmtPrice(lv.price) + "  " + (chg >= 0 ? "▲ " : "▼ ") + pctStr(chg) + " vs yesterday";
    var where = cfg.keyLevel > 0 && lv.price > cfg.keyLevel ? "above your level" : lv.price < cfg.supportLevel ? "below your support" : "between your lines";
    var when = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(lv.fetchedAt));
    $("live-sub").textContent = "Price right now is " + where + ", but only the close counts. Volume so far " + fmtVol(lv.volume) + " (day not finished). As of " + when + " ET. Press Refresh to reload the newest snapshot.";
  }

  function render() {
    renderHelp();
    renderLive();
    $("tk").textContent = (cfg && cfg.ticker) || (rd && rd.ticker) || "—";
    var v = $("verdict");
    if (saved && cfg !== saved) { showNotice("Previewing these settings. Nothing is saved yet. Tap Copy config.json and commit it to use them for alerts."); }
    else if (loadErr && !rd) { showNotice("Could not load the latest reading. Check your connection and reopen the page."); }
    else if (rd && rd.seeded) { showNotice("These numbers are sample history from setup. The first real reading arrives after the next weekday close."); }
    else if (rd && rd.checkedAt && (Date.now() - new Date(rd.checkedAt).getTime()) > 5 * 86400000) { showNotice("The last check was more than five days ago. If that is unexpected, open the Actions tab on GitHub and look for a failed run."); }
    else if (cfg && rd && rd.ticker !== cfg.ticker) { showNotice("Last reading is for " + rd.ticker + ". The next after-close check will switch to " + cfg.ticker + "."); }
    else { showNotice(""); }

    if (!usable()) {
      v.setAttribute("data-state", "empty");
      $("vpill").textContent = "No reading yet";
      $("vhead").textContent = cfg && rd && rd.ticker !== cfg.ticker ? "Waiting for the first " + cfg.ticker + " reading" : "Waiting for the first after-close check";
      $("vwhy").textContent = cfg ? "The check runs on weekdays after the close and fills this page in." : "Set a ticker and your levels below. The check runs on weekdays after the close and fills this page in.";
      $("px").textContent = ""; $("chg").textContent = ""; $("fresh").textContent = "";
      ["s1v", "s2v", "s3v"].forEach(function (id) { $(id).textContent = "—"; });
      ["s1c", "s2c", "s3c"].forEach(function (id) { setChip($(id), "", "No data"); });
      $("s1b").textContent = ""; $("s2a").textContent = "Compared with the 20-day average."; $("s3a").textContent = "Is the close on the right side of the trend?";
      $("s1a").textContent = "The close counts, not the intraday touch.";
      $("chart").innerHTML = '<p class="hint">The chart appears after the first check.</p>';
      $("legend").hidden = true;
      $("tbl").querySelector("tbody").innerHTML = "";
      return;
    }

    var e = evaluate(rd, cfg), h = Array.isArray(rd.history) ? rd.history : [], st = streaks(h, cfg);
    v.setAttribute("data-state", e.state);
    $("vpill").textContent = e.pill; $("vhead").textContent = e.head; $("vwhy").textContent = e.why;

    $("px").textContent = "$" + fmtPrice(rd.close);
    var prev = h.length > 1 ? h[h.length - 2].close : null;
    $("chg").textContent = prev ? (rd.close >= prev ? "▲ " : "▼ ") + pctStr((rd.close / prev - 1) * 100) + " on the day" : "";
    $("fresh").textContent = "Close of " + fmtDate(rd.asOf) + (rd.checkedAt ? " · checked " + fmtChecked(rd.checkedAt) : "");

    $("s1v").textContent = "$" + fmtPrice(rd.close);
    if (e.s1 === "up") setChip($("s1c"), "good", "▲ Above level");
    else if (e.s1 === "down") setChip($("s1c"), "bad", "▼ Below support");
    else setChip($("s1c"), "", "● Between the lines");
    $("s1a").textContent = "Level " + fmtPrice(cfg.keyLevel) + " (" + pctStr(e.pctKey) + (e.pctKey >= 0 ? " above" : " below") + ") · Support " + fmtPrice(cfg.supportLevel) + " (" + pctStr(e.pctSup) + (e.pctSup >= 0 ? " above" : " below") + ")";
    $("s1b").textContent = e.s1 === "down"
      ? st.down + " close" + (st.down === 1 ? "" : "s") + " below support in a row"
      : st.up + " close" + (st.up === 1 ? "" : "s") + " above the level in a row";

    if (e.ratio == null) { $("s2v").textContent = "—"; setChip($("s2c"), "", "No volume data"); $("s2a").textContent = "Volume was not available for this session."; }
    else {
      $("s2v").textContent = e.ratio.toFixed(2) + "×";
      setChip($("s2c"), e.heavy ? "accent" : "", e.heavy ? "■ Heavy" : (e.ratio < 0.8 ? "□ Light" : "□ Normal"));
      $("s2a").textContent = fmtVol(rd.volume) + " vs " + fmtVol(rd.avgVolume20) + " 20-day average. Heavy is " + (cfg.volumeMultiple || 1.5) + "× or more.";
    }

    if (rd.ma50 == null) { $("s3v").textContent = "—"; setChip($("s3c"), "", "No data"); $("s3a").textContent = "The 50-day average was not available."; }
    else {
      $("s3v").textContent = "$" + fmtPrice(rd.ma50);
      setChip($("s3c"), e.s3 === "up" ? "good" : "bad", e.s3 === "up" ? "▲ Close above" : "▼ Close below");
      $("s3a").textContent = "The close is " + pctStr(e.pctMa) + (e.pctMa >= 0 ? " above" : " below") + " the 50-day average" + (rd.ma200 != null ? " (200-day: $" + fmtPrice(rd.ma200) + ")." : ".");
    }

    drawChart($("chart").parentNode.clientWidth || 600);
    renderTable(h);
  }

  function renderTable(h) {
    var tb = $("tbl").querySelector("tbody"), html = "";
    for (var i = h.length - 1; i >= Math.max(0, h.length - 12); i--) {
      var r = h[i], d =(r.close / cfg.keyLevel - 1) * 100;
      var ratio = rd.avgVolume20 > 0 ? (r.volume / rd.avgVolume20).toFixed(2) + "×" : "—";
      html += "<tr><td>" + fmtDate(r.date) + "</td><td>" + fmtPrice(r.close) + "</td><td>" + (d >= 0 ? "+" : "−") + pctStr(d) + "</td><td>" + fmtVol(r.volume) + "</td><td>" + ratio + "</td></tr>";
    }
    tb.innerHTML = html;
  }

  function drawChart(width) {
    var host = $("chart"), rows = (rd.history || []).slice(-12), n = rows.length;
    if (!n) { host.innerHTML = '<p class="hint">Recent sessions fill in as checks run.</p>'; $("legend").hidden = true; return; }
    lastW = width;
    var W = Math.max(280, width), mL = 44, mR = 86, mT = 10, hP = 150, gap = 28, hV = 64, mB = 22;
    var H = mT + hP + gap + hV + mB, plotW = W - mL - mR, step = plotW / n;
    var xc = function (i) { return mL + step * (i + 0.5); };
    var closes = rows.map(function (r) { return r.close; });
    var key = cfg.keyLevel, sup = cfg.supportLevel, mult = cfg.volumeMultiple || 1.5;
    var lo = Math.min.apply(null, closes.concat([key, sup])), hi = Math.max.apply(null, closes.concat([key, sup]));
    var pad = (hi - lo) * 0.06 || 1, ticks = niceTicks(lo - pad, hi + pad, 4), yMin = ticks[0], yMax = ticks[ticks.length - 1];
    var yP = function (v) { return mT + hP - (v - yMin) / (yMax - yMin) * hP; };
    var vols = rows.map(function (r) { return r.volume; }), avg = rd.avgVolume20 || 0;
    var vMax = Math.max(1e6, Math.ceil(Math.max.apply(null, vols.concat([avg * 1.1])) / 1e6) * 1e6), vTicks = [0, vMax];
    var v0 = mT + hP + gap, vBase = v0 + hV;
    var yV = function (v) { return vBase - v / vMax * hV; };
    var s = '<svg class="cv" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Closes and volume for the last ' + n + " sessions. Latest close " + fmtPrice(rd.close) + ", level " + fmtPrice(key) + ", support " + fmtPrice(sup) + '.">';
    ticks.forEach(function (t) { var y = yP(t); s += '<line class="grid" x1="' + mL + '" x2="' + (mL + plotW) + '" y1="' + y + '" y2="' + y + '"/><text x="' + (mL - 8) + '" y="' + (y + 4) + '" text-anchor="end">' + t.toFixed(t % 1 ? 1 : 0) + "</text>"; });
    var lines = [{ v: key, cls: "key", t: "Level " + fmtPrice(key) }, { v: sup, cls: "sup", t: "Support " + fmtPrice(sup) }];
    lines.forEach(function (l) { l.y = yP(l.v); });
    lines.forEach(function (l) { s += '<line class="' + l.cls + '" x1="' + mL + '" x2="' + (mL + plotW) + '" y1="' + l.y + '" y2="' + l.y + '"/>'; });
    var sorted = lines.slice().sort(function (a, b) { return a.y - b.y; });
    if (sorted[1].y - sorted[0].y < 14) sorted[1].y = sorted[0].y + 14;
    lines.forEach(function (l) { s += '<text class="lab" x="' + (mL + plotW + 8) + '" y="' + (l.y + 4) + '">' + l.t + "</text>"; });
    s += '<polyline class="close" points="' + rows.map(function (r, i) { return xc(i) + "," + yP(r.close); }).join(" ") + '"/>';
    rows.forEach(function (r, i) { s += '<circle class="dot" cx="' + xc(i) + '" cy="' + yP(r.close) + '" r="' + (i === n - 1 ? 5 : 4) + '"/>'; });
    vTicks.forEach(function (t) { var y = yV(t); s += '<line class="grid" x1="' + mL + '" x2="' + (mL + plotW) + '" y1="' + y + '" y2="' + y + '"/><text x="' + (mL - 8) + '" y="' + (y + 4) + '" text-anchor="end">' + (t === 0 ? "0" : (t / 1e6).toFixed(t % 1e6 ? 1 : 0) + "M") + "</text>"; });
    var bw = Math.max(4, Math.min(28, step - 2));
    rows.forEach(function (r, i) {
      var y = yV(r.volume), h = vBase - y, x = xc(i) - bw / 2, rr = Math.min(3, bw / 2, h);
      var heavy = avg > 0 && r.volume >= mult * avg;
      s += '<path class="bar' + (heavy ? " heavy" : "") + '" d="M' + x + "," + vBase + " L" + x + "," + (y + rr) + " Q" + x + "," + y + " " + (x + rr) + "," + y + " L" + (x + bw - rr) + "," + y + " Q" + (x + bw) + "," + y + " " + (x + bw) + "," + (y + rr) + " L" + (x + bw) + "," + vBase + ' Z"/>';
    });
    s += '<line class="base" x1="' + mL + '" x2="' + (mL + plotW) + '" y1="' + vBase + '" y2="' + vBase + '"/>';
    if (avg > 0) s += '<line class="avg" x1="' + mL + '" x2="' + (mL + plotW) + '" y1="' + yV(avg) + '" y2="' + yV(avg) + '"/><text class="lab" x="' + (mL + plotW + 8) + '" y="' + (yV(avg) + 4) + '">avg ' + fmtVol(avg) + "</text>";
    var xl = n <= 3 ? rows.map(function (_, i) { return i; }) : [0, Math.floor((n - 1) / 2), n - 1];
    xl.forEach(function (i) { s += '<text x="' + xc(i) + '" y="' + (H - 6) + '" text-anchor="middle">' + fmtDate(rows[i].date) + "</text>"; });
    s += '<line id="xh" class="xh" x1="0" x2="0" y1="' + mT + '" y2="' + vBase + '"/><circle id="hv" class="hv" r="5" cx="0" cy="0"/>';
    s += '<rect id="catch" class="catch" x="' + mL + '" y="' + mT + '" width="' + plotW + '" height="' + (vBase - mT) + '"/></svg>';
    host.innerHTML = s;

    var lg = $("legend");
    lg.innerHTML = '<li><svg viewBox="0 0 22 10" aria-hidden="true"><line x1="0" x2="22" y1="5" y2="5" stroke="var(--ink)" stroke-width="2"/></svg>Daily close</li>' +
      '<li><svg viewBox="0 0 22 10" aria-hidden="true"><line x1="0" x2="22" y1="5" y2="5" stroke="var(--accent)" stroke-width="2" stroke-dasharray="6 4"/></svg>Level to watch</li>' +
      '<li><svg viewBox="0 0 22 10" aria-hidden="true"><line x1="0" x2="22" y1="5" y2="5" stroke="var(--muted)" stroke-width="2" stroke-dasharray="2 4"/></svg>Support</li>' +
      '<li><span class="sw" style="background:var(--accent)"></span>Heavy volume (' + mult + "× or more)</li>";
    lg.hidden = false;

    var tip = $("tip"), catcher = $("catch"), xh = $("xh"), hv = $("hv");
    function show(ev) {
      var box = catcher.getBoundingClientRect(), scale = W / ($("chart").clientWidth || W);
      var px = (ev.clientX - box.left) * scale;
      var i = Math.max(0, Math.min(n - 1, Math.floor(px / step))), r = rows[i];
      xh.setAttribute("x1", xc(i)); xh.setAttribute("x2", xc(i)); xh.style.opacity = 1;
      hv.setAttribute("cx", xc(i)); hv.setAttribute("cy", yP(r.close)); hv.style.opacity = 1;
      var d = (r.close / key - 1) * 100;
      tip.innerHTML = fmtDate(r.date) + "<br>Close <b>" + fmtPrice(r.close) + "</b> (" + (d >= 0 ? "+" : "−") + pctStr(d) + " vs level)<br>Volume <b>" + fmtVol(r.volume) + "</b>" + (avg > 0 ? " (" + (r.volume / avg).toFixed(2) + "× avg)" : "");
      tip.hidden = false;
      var wrap = $("chartwrap"), wb = wrap.getBoundingClientRect(), tw = tip.offsetWidth;
      var left = xc(i) / scale + 12; if (left + tw > wb.width) left = xc(i) / scale - tw - 12; if (left < 0) left = 0;
      tip.style.left = left + "px"; tip.style.top = (mT + 4) + "px";
    }
    function hide() { tip.hidden = true; xh.style.opacity = 0; hv.style.opacity = 0; }
    catcher.addEventListener("pointermove", show);
    catcher.addEventListener("pointerdown", show);
    catcher.addEventListener("pointerleave", hide);
    catcher.addEventListener("pointercancel", hide);
  }

  function typedTicker() { return $("f-ticker").value.trim().toUpperCase(); }
  function helpReady() {
    return !!(rd && Array.isArray(rd.history) && rd.history.length >= 8 && typeof rd.close === "number" && rd.ticker === typedTicker());
  }
  function curRisk() { var r = document.querySelector('input[name="risk"]:checked'); return r ? r.value : null; }
  function setRisk(v) { var rs = document.querySelectorAll('input[name="risk"]'); for (var i = 0; i < rs.length; i++) rs[i].checked = rs[i].value === v; }
  function chipsHtml(field, items) {
    return items.map(function (c) { return '<button type="button" class="chip-btn" data-field="' + field + '" data-val="' + c.val + '"><b>' + c.text + "</b><span>" + c.label + "</span></button>"; }).join("");
  }
  function updateNotes() {
    var ready = helpReady(), close = rd && rd.close, t;
    var k = parseFloat($("f-key").value), s = parseFloat($("f-sup").value), m = parseFloat($("f-mult").value);
    t = "";
    if (ready && k > 0) t = k > close ? pctStr((k / close - 1) * 100) + " above the last close (" + fmtPrice(close) + ")." : "At or below the last close, so a close above it already counts as broken out.";
    $("n-key").textContent = (t + " " + (why.key || "")).trim();
    t = "";
    if (ready && s > 0) t = s < close ? pctStr((1 - s / close) * 100) + " below the last close (" + fmtPrice(close) + ")." : "At or above the last close, so it already reads as broken down.";
    $("n-sup").textContent = (t + " " + (why.sup || "")).trim();
    t = "";
    if (ready && m > 0 && rd.history.length > 21) { var rr = rollingRatios(rd.history); t = countHeavy(rr, m) + " of " + rr.length + " recent sessions were at least " + m + "× the 20-day average."; }
    $("n-mult").textContent = (t + " " + (why.mult || "")).trim();
  }
  function renderHelp() {
    var ready = helpReady(), rs = document.querySelectorAll('input[name="risk"]'), i, r = curRisk();
    for (i = 0; i < rs.length; i++) rs[i].disabled = !ready;
    if (r) {
      $("risk-desc").textContent = RISK[r].blurb;
      $("risk-rules").textContent = "Level: the first recent high at least " + RISK[r].levelMin + "% above the last close. Support: the first recent low at least " + RISK[r].supMin + "% below it. Heavy volume: " + RISK[r].mult + "× the 20-day average.";
    } else {
      $("risk-desc").textContent = "Pick one to fill the three fields from recent closes. You can still change any number.";
      $("risk-rules").textContent = "";
    }
    if (!ready) {
      $("sugg-src").textContent = "Suggestions and risk presets appear once " + (typedTicker() || "a ticker") + " has a reading.";
      $("c-key").innerHTML = ""; $("c-sup").innerHTML = ""; $("c-mult").innerHTML = "";
      updateNotes();
      return;
    }
    var h = rd.history, asVal = function (c) { return { val: fmtPrice(c.price), text: fmtPrice(c.price), label: c.label }; };
    $("sugg-src").textContent = "Suggestions use " + rd.ticker + "'s last " + h.length + " closes (" + fmtDate(h[0].date) + " to " + fmtDate(h[h.length - 1].date) + "). Nothing is saved until you press Save.";
    $("c-key").innerHTML = chipsHtml("key", levelChips(h, rd.close, rd.ma50, rd.ma200).map(asVal));
    $("c-sup").innerHTML = chipsHtml("sup", supportChips(h, rd.close, rd.ma50, rd.ma200).map(asVal));
    if (h.length > 21) {
      var rr = rollingRatios(h);
      $("c-mult").innerHTML = chipsHtml("mult", [1.25, 1.5, 2].map(function (m) { var k = countHeavy(rr, m); return { val: m, text: m + "×", label: k + " of " + rr.length + " sessions (" + Math.round(k / rr.length * 100) + "%)" }; }));
    } else { $("c-mult").innerHTML = ""; }
    updateNotes();
  }
  function applyPreset(risk) {
    if (!helpReady() || !RISK[risk]) return;
    var p = preset(rd.history, rd.close, risk), R = RISK[risk];
    $("f-key").value = fmtPrice(p.level.price); $("f-sup").value = fmtPrice(p.support.price); $("f-mult").value = p.mult;
    why.key = R.name + " pick: " + (p.level.fallback ? "no recent high is " + R.levelMin + "% or more above the last close, so this sits " + R.levelMin + "% above it." : "the " + fmtDate(p.level.date) + " high, the first one at least " + R.levelMin + "% above the last close.");
    why.sup = R.name + " pick: " + (p.support.fallback ? "no recent low is " + R.supMin + "% or more below the last close, so this sits " + R.supMin + "% below it." : "the " + fmtDate(p.support.date) + " low, the first one at least " + R.supMin + "% below the last close.");
    why.mult = R.name + " pick: " + R.mult + "×.";
    dirty = true; msg(""); sync();
  }
  function fillForm() {
    if (!saved || dirty) return;
    $("f-ticker").value = saved.ticker || ""; $("f-key").value = saved.keyLevel != null ? saved.keyLevel : "";
    $("f-sup").value = saved.supportLevel != null ? saved.supportLevel : ""; $("f-mult").value = saved.volumeMultiple != null ? saved.volumeMultiple : "";
    why = { key: "", sup: "", mult: "" };
    setRisk(saved.risk && RISK[saved.risk] ? saved.risk : null);
  }
  document.addEventListener("change", function (e) { var t = e.target; if (t && t.name === "risk" && t.checked) applyPreset(t.value); });
  [["f-key", "key"], ["f-sup", "sup"], ["f-mult", "mult"]].forEach(function (p) {
    $(p[0]).addEventListener("input", function () { why[p[1]] = ""; setRisk(null); sync(); });
  });
  $("f-ticker").addEventListener("input", function () { why = { key: "", sup: "", mult: "" }; setRisk(null); renderHelp(); });
  document.addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest(".chip-btn") : null; if (!b) return;
    var f = b.getAttribute("data-field"), id = f === "key" ? "f-key" : f === "sup" ? "f-sup" : "f-mult";
    $(id).value = b.getAttribute("data-val"); why[f] = ""; setRisk(null); dirty = true; msg(""); sync();
  });

  function msg(t, err) { var m = $("f-msg"); m.textContent = t; m.className = err ? "err" : ""; }

  document.addEventListener("input", function (e) { if (e.target && e.target.closest && e.target.closest("#cfgForm")) { dirty = true; msg(""); } });

  var TOKEN_KEY = "closecheck.ghtoken";
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; } }
  function setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); return true; } catch (e) { return false; } }
  function repoInfo() {
    if (window.__ccRepo) return window.__ccRepo;
    var m = location.hostname.match(/^([^.]+)\.github\.io$/), seg = location.pathname.split("/").filter(Boolean)[0];
    return m && seg ? m[1] + "/" + seg : null;
  }
  function refreshSaveUi() {
    var has = !!getToken() && !!repoInfo();
    $("f-save").textContent = has ? "Save to GitHub" : "Copy config.json";
    $("gh").hidden = !repoInfo();
    $("gh-state").textContent = getToken() ? "Connected. Save commits your settings straight to GitHub." : "Not connected. Save copies the settings so you can paste them into GitHub.";
    $("gh-clear").hidden = !getToken();
  }
  function ghFetch(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ Accept: "application/vnd.github+json", Authorization: "Bearer " + getToken(), "X-GitHub-Api-Version": "2022-11-28" }, opts.headers || {});
    return fetch("https://api.github.com/repos/" + repoInfo() + path, opts);
  }
  function saveToGitHub(doc, text) {
    var btn = $("f-save"); btn.disabled = true; msg("Saving…");
    var body64 = btoa(unescape(encodeURIComponent(text)));
    function attempt(retry) {
      return ghFetch("/contents/site/config.json?ref=main&t=" + Date.now(), { cache: "no-store" }).then(function (r) {
        if (r.status === 401 || r.status === 403 || r.status === 404) throw new Error("auth");
        if (!r.ok) throw new Error("http " + r.status);
        return r.json();
      }).then(function (cur) {
        return ghFetch("/contents/site/config.json", { method: "PUT", body: JSON.stringify({ message: "Update watched settings (" + doc.ticker + ")", content: body64, sha: cur.sha, branch: "main" }) });
      }).then(function (r) {
        if ((r.status === 409 || r.status === 422) && retry) return attempt(false);
        if (r.status === 401 || r.status === 403 || r.status === 404) throw new Error("auth");
        if (!r.ok) throw new Error("http " + r.status);
      });
    }
    attempt(true).then(function () {
      saved = doc; cfg = saved; dirty = false; applyDraft(); render();
      msg("Saved to GitHub. The page redeploys in a minute or two, and the next check uses these settings.");
    }).catch(function (e) {
      msg(e.message === "auth" ? "GitHub refused the token. Check that it has Contents: Read and write on this repo and has not expired, then reconnect." : "Could not save (" + e.message + "). Check your connection and try again.", true);
    }).then(function () { btn.disabled = false; });
  }
  $("gh-save").addEventListener("click", function () {
    var v = $("gh-token").value.trim();
    if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(v)) return msg("That does not look like a GitHub token. It starts with github_pat_.", true);
    if (!setToken(v)) return msg("This browser would not store the token, so Save will keep using copy and paste.", true);
    $("gh-token").value = ""; msg("Token saved on this device."); refreshSaveUi();
  });
  $("gh-clear").addEventListener("click", function () { setToken(""); msg("Token removed from this device."); refreshSaveUi(); });

  function repoEditUrl() {
    var host = location.hostname, m = host.match(/^([^.]+)\.github\.io$/), seg = location.pathname.split("/").filter(Boolean)[0];
    return m && seg ? "https://github.com/" + m[1] + "/" + seg + "/edit/main/site/config.json" : null;
  }

  $("cfgForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var tk = $("f-ticker").value.trim().toUpperCase(), key = parseFloat($("f-key").value), sup = parseFloat($("f-sup").value), mult = parseFloat($("f-mult").value);
    if (!/^[A-Z][A-Z.\-]{0,5}$/.test(tk)) return msg("Enter a ticker of one to six letters, like ETSY.", true);
    if (!(key > 0) || !(sup > 0)) return msg("Enter both prices as numbers above zero.", true);
    if (!(key > sup)) return msg("The level to watch must be higher than support.", true);
    if (!(mult >= 1 && mult <= 5)) return msg("Heavy volume should be between 1 and 5 times the average.", true);
    var doc = { ticker: tk, keyLevel: key, supportLevel: sup, volumeMultiple: mult };
    var rk = curRisk(); if (rk) doc.risk = rk;
    var text = JSON.stringify(doc, null, 2) + "\n", ta = $("f-ta");
    if (getToken() && repoInfo()) return saveToGitHub(doc, text);
    ta.value = text; ta.hidden = false;
    var link = $("f-edit"), url = repoEditUrl(); if (url) { link.href = url; link.hidden = false; }
    var done = function () { msg("Copied. Paste it over the contents of config.json on GitHub, then commit."); };
    var fail = function () { ta.focus(); ta.select(); msg("Select the text below, copy it, and paste it into config.json on GitHub.", false); };
    try { navigator.clipboard.writeText(text).then(done, fail); } catch (e) { fail(); }
  });

  if (window.ResizeObserver) {
    new ResizeObserver(function () {
      var w = $("chartwrap").clientWidth;
      if (usable() && Math.abs(w - lastW) > 2) drawChart(w);
    }).observe($("chartwrap"));
  }

  function getJson(name) {
    return fetch(name + "?t=" + Date.now(), { cache: "no-store" }).then(function (r) { if (!r.ok) throw new Error(name); return r.json(); });
  }
  function load() {
    return Promise.all([getJson("config.json"), getJson("data.json").catch(function () { return null; })]).then(function (res) {
      loadErr = false; saved = res[0]; cfg = saved; rd = res[1]; fillForm(); applyDraft(); render();
    }).catch(function () { loadErr = true; render(); });
  }
  $("refresh").addEventListener("click", function () {
    var b = $("refresh"); b.disabled = true; b.textContent = "Refreshing…";
    load().then(function () { b.textContent = "Updated"; setTimeout(function () { b.textContent = "Refresh"; b.disabled = false; }, 1500); });
  });
  refreshSaveUi();
  render();
  load();
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") load(); });
