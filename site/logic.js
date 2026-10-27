// Shared by the page (browser) and the nightly job (Node). No DOM, no network.

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtPrice(n) { return Number(n).toFixed(2); }
export function fmtVol(n) { return (Number(n) / 1e6).toFixed(2) + "M"; }
export function fmtDate(s) {
  const p = String(s).split("-");
  if (p.length !== 3) return String(s);
  return MONTHS[+p[1] - 1] + " " + (+p[2]);
}
export function pctStr(n) { return Math.abs(n).toFixed(1) + "%"; }
export function r2(n) { return Math.round(n * 100) / 100; }
export function mean(a) { let s = 0; for (const v of a) s += v; return s / a.length; }

export function niceStep(raw) {
  const exp = Math.floor(Math.log10(raw)), f = raw / Math.pow(10, exp);
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * Math.pow(10, exp);
}
export function niceTicks(min, max, count) {
  if (!(max > min)) { max = min + 1; }
  const step = niceStep((max - min) / count);
  const start = Math.floor(min / step + 1e-9) * step, end = Math.ceil(max / step - 1e-9) * step, out = [];
  for (let v = start; v <= end + step * 0.001; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

// rows: [{date, close, volume}] oldest first. The 20-day average volume is the average of the
// 20 sessions before the latest one, so a heavy day does not dilute its own comparison.
export function buildReading(rows, ticker) {
  const n = rows.length;
  if (n < 22) throw new Error("Need at least 22 sessions of history, got " + n);
  const last = rows[n - 1];
  const avg = mean(rows.slice(n - 21, n - 1).map((r) => r.volume));
  const ma = (k) => (n >= k ? r2(mean(rows.slice(n - k).map((r) => r.close))) : null);
  return { ticker, asOf: last.date, close: last.close, volume: last.volume, avgVolume20: Math.round(avg), ma50: ma(50), ma200: ma(200) };
}

export function evaluate(rd, cfg) {
  const close = rd.close, key = cfg.keyLevel, sup = cfg.supportLevel, mult = cfg.volumeMultiple || 1.5;
  const ratio = rd.avgVolume20 > 0 && rd.volume != null ? rd.volume / rd.avgVolume20 : null;
  const heavy = ratio != null && ratio >= mult;
  const s1 = close > key ? "up" : close < sup ? "down" : "mid";
  const s3 = rd.ma50 == null ? "na" : close > rd.ma50 ? "up" : "down";
  let state = "wait";
  if (s1 === "up" && heavy && s3 === "up") state = "confirm-up";
  else if (s1 === "down" && heavy && s3 === "down") state = "confirm-down";
  else if (s1 === "up") state = "partial-up";
  else if (s1 === "down") state = "partial-down";
  const r1 = ratio == null ? "" : ratio.toFixed(1) + "×";
  const missing = [];
  if (state === "partial-up" || state === "partial-down") {
    if (!heavy) missing.push(ratio == null ? "volume data is not available" : "volume was " + r1 + " the average (needs " + mult + "×)");
    if (state === "partial-up" && s3 !== "up") missing.push(s3 === "na" ? "the 50-day average is not available" : "the close is under the 50-day average");
    if (state === "partial-down" && s3 !== "down") missing.push(s3 === "na" ? "the 50-day average is not available" : "the close is still above the 50-day average");
  }
  let head, why, pill;
  if (state === "confirm-up") {
    pill = "▲ Bullish"; head = "Bullish confirmation";
    why = "Closed at " + fmtPrice(close) + ", above the " + fmtPrice(key) + " level, on " + r1 + " average volume and above the 50-day average. All three checks agree.";
  } else if (state === "confirm-down") {
    pill = "▼ Bearish"; head = "Bearish confirmation";
    why = "Closed at " + fmtPrice(close) + ", below " + fmtPrice(sup) + " support, on " + r1 + " average volume and under the 50-day average. All three checks agree.";
  } else if (state === "partial-up") {
    pill = "◐ Partial"; head = "Above the level, not confirmed";
    why = "Closed at " + fmtPrice(close) + ", above " + fmtPrice(key) + ", but " + missing.join(" and ") + ".";
  } else if (state === "partial-down") {
    pill = "◐ Partial"; head = "Below support, not confirmed";
    why = "Closed at " + fmtPrice(close) + ", under " + fmtPrice(sup) + ", but " + missing.join(" and ") + ".";
  } else {
    pill = "● Waiting"; head = "No signal yet";
    why = "Closed at " + fmtPrice(close) + ", " + pctStr((key - close) / key * 100) + " under the " + fmtPrice(key) + " level and " + pctStr((close - sup) / sup * 100) + " above " + fmtPrice(sup) + " support.";
  }
  return {
    s1, s3, heavy, ratio, state, head, why, pill,
    pctKey: (close - key) / key * 100, pctSup: (close - sup) / sup * 100,
    pctMa: rd.ma50 == null ? null : (close / rd.ma50 - 1) * 100,
  };
}

export function streaks(h, cfg) {
  let up = 0, down = 0, i;
  for (i = h.length - 1; i >= 0; i--) { if (h[i].close > cfg.keyLevel) up++; else break; }
  for (i = h.length - 1; i >= 0; i--) { if (h[i].close < cfg.supportLevel) down++; else break; }
  return { up, down };
}

const STATE_WORDS = {
  "confirm-up": "bullish confirmation",
  "confirm-down": "bearish confirmation",
  "partial-up": "above the level, not confirmed",
  "partial-down": "below support, not confirmed",
  wait: "no signal",
};

// Decides whether the new close deserves a notification. prev may be null (no prior session).
export function alertFor(prev, next, cfg) {
  const e = evaluate(next, cfg), key = cfg.keyLevel, sup = cfg.supportLevel, reasons = [];
  let prevState = null;
  if (prev) {
    prevState = evaluate(prev, cfg).state;
    if (prevState !== e.state) reasons.push("The verdict moved from " + STATE_WORDS[prevState] + " to " + STATE_WORDS[e.state] + ".");
    if (prev.close > key !== next.close > key) {
      reasons.push(next.close > key ? "Closed above your " + fmtPrice(key) + " level." : "Closed back under your " + fmtPrice(key) + " level.");
    }
    if (prev.close < sup !== next.close < sup) {
      reasons.push(next.close < sup ? "Closed under " + fmtPrice(sup) + " support." : "Closed back above " + fmtPrice(sup) + " support.");
    }
  }
  if (Math.abs(next.close - key) / key <= 0.02) reasons.push("Within 2% of your " + fmtPrice(key) + " level.");
  if (Math.abs(next.close - sup) / sup <= 0.02) reasons.push("Within 2% of " + fmtPrice(sup) + " support.");
  return {
    alert: reasons.length > 0,
    reasons,
    state: e.state,
    prevState,
    title: "Close Check - " + next.ticker,
    body: next.ticker + " closed at " + fmtPrice(next.close) + ". " + e.head + ". " + reasons.join(" "),
  };
}

/* Risk presets. Each one is a plain rule so the numbers can be explained. */
export const RISK = {
  cautious: { name: "Cautious", levelMin: 6, supMin: 2, mult: 2, blurb: "Asks for more proof and warns sooner. Fewer signals and fewer false alarms, but later ones." },
  balanced: { name: "Balanced", levelMin: 3, supMin: 4, mult: 1.5, blurb: "A middle setting. A breakout needs a clear move and ordinary volume confirmation." },
  aggressive: { name: "Aggressive", levelMin: 0.5, supMin: 7, mult: 1.25, blurb: "Acts on weaker proof and gives price more room. More signals and more false alarms." },
};

/* A swing high (low) is a close at least as high (low) as the three closes on each side of it. */
export function swings(h, side, win) {
  const out = [];
  for (let i = win; i < h.length - win; i++) {
    let ok = true;
    for (let k = 1; k <= win; k++) {
      const bad = side === "high"
        ? h[i].close < h[i - k].close || h[i].close < h[i + k].close
        : h[i].close > h[i - k].close || h[i].close > h[i + k].close;
      if (bad) { ok = false; break; }
    }
    if (ok) out.push({ date: h[i].date, price: h[i].close });
  }
  return out;
}
export function pickLevel(h, close, minPct) {
  const c = swings(h, "high", 3).filter((p) => p.price > close).sort((a, b) => a.price - b.price);
  for (const p of c) {
    const pct = (p.price / close - 1) * 100;
    if (pct >= minPct) return { price: p.price, date: p.date, pct, fallback: false };
  }
  return { price: r2(close * (1 + minPct / 100)), date: null, pct: minPct, fallback: true };
}
export function pickSupport(h, close, minPct) {
  const c = swings(h, "low", 3).filter((p) => p.price < close).sort((a, b) => b.price - a.price);
  for (const p of c) {
    const pct = (1 - p.price / close) * 100;
    if (pct >= minPct) return { price: p.price, date: p.date, pct, fallback: false };
  }
  return { price: r2(close * (1 - minPct / 100)), date: null, pct: minPct, fallback: true };
}
export function preset(h, close, risk) {
  const R = RISK[risk];
  return { level: pickLevel(h, close, R.levelMin), support: pickSupport(h, close, R.supMin), mult: R.mult };
}
export function rollingRatios(h) {
  const out = [];
  for (let i = 20; i < h.length; i++) {
    let s = 0;
    for (let j = i - 20; j < i; j++) s += h[j].volume;
    if (s > 0) out.push(h[i].volume / (s / 20));
  }
  return out;
}
export function countHeavy(r, m) { let k = 0; for (const v of r) if (v >= m) k++; return k; }
export function dedupe(list) {
  const out = [];
  list.forEach((c) => { if (!out.some((o) => Math.abs(o.price / c.price - 1) < 0.005)) out.push(c); });
  return out;
}
export function levelChips(h, close, ma50, ma200) {
  const list = swings(h, "high", 3).filter((p) => p.price > close).sort((a, b) => a.price - b.price).slice(0, 3)
    .map((p) => ({ price: p.price, label: fmtDate(p.date) + " high" }));
  let top = null; h.forEach((r) => { if (!top || r.close > top.close) top = r; });
  if (top && top.close > close) list.push({ price: top.close, label: "Highest close, " + fmtDate(top.date) });
  if (ma50 != null && ma50 > close) list.push({ price: ma50, label: "50-day average" });
  if (ma200 != null && ma200 > close) list.push({ price: ma200, label: "200-day average" });
  list.sort((a, b) => a.price - b.price);
  return dedupe(list).slice(0, 4).map((c) => ({ price: c.price, label: c.label + " · +" + ((c.price / close - 1) * 100).toFixed(1) + "%" }));
}
export function supportChips(h, close, ma50, ma200) {
  const list = swings(h, "low", 3).filter((p) => p.price < close).sort((a, b) => b.price - a.price).slice(0, 3)
    .map((p) => ({ price: p.price, label: fmtDate(p.date) + " low" }));
  let low = null; h.forEach((r) => { if (!low || r.close < low.close) low = r; });
  if (low && low.close < close) list.push({ price: low.close, label: "Lowest close, " + fmtDate(low.date) });
  if (ma50 != null && ma50 < close) list.push({ price: ma50, label: "50-day average" });
  if (ma200 != null && ma200 < close) list.push({ price: ma200, label: "200-day average" });
  list.sort((a, b) => b.price - a.price);
  return dedupe(list).slice(0, 4).map((c) => ({ price: c.price, label: c.label + " · −" + ((1 - c.price / close) * 100).toFixed(1) + "%" }));
}

export function validateConfig(c) {
  if (!c || typeof c !== "object") throw new Error("config.json is missing or not an object");
  const ticker = String(c.ticker || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z.\-]{0,5}$/.test(ticker)) throw new Error("config.json: ticker must be one to six letters, like ETSY");
  const keyLevel = Number(c.keyLevel), supportLevel = Number(c.supportLevel);
  const volumeMultiple = c.volumeMultiple == null ? 1.5 : Number(c.volumeMultiple);
  if (!(keyLevel > 0) || !(supportLevel > 0)) throw new Error("config.json: keyLevel and supportLevel must be numbers above zero");
  if (!(keyLevel > supportLevel)) throw new Error("config.json: keyLevel must be higher than supportLevel");
  if (!(volumeMultiple >= 1 && volumeMultiple <= 5)) throw new Error("config.json: volumeMultiple must be between 1 and 5");
  return { ticker, keyLevel, supportLevel, volumeMultiple };
}

/* ---------- Watchlist ---------- */
export const MAX_WATCH = 12;
const TICKER_RE = /^[A-Z][A-Z.\-]{0,5}$/;

// Accepts the old single-stock file ({ticker, keyLevel, ...}) or the watchlist file ({digest, watchlist: [...]}).
// Levels are optional per stock: a stock without them gets levels picked from its risk preset after its first check.
export function normalizeConfig(c) {
  if (!c || typeof c !== "object") throw new Error("config.json is missing or not an object");
  const raw = Array.isArray(c.watchlist) ? c.watchlist : [c];
  const seen = new Set(), watchlist = [];
  for (const w of raw) {
    if (!w || typeof w !== "object") throw new Error("config.json: each watchlist entry must be an object");
    const ticker = String(w.ticker || "").trim().toUpperCase();
    if (!TICKER_RE.test(ticker)) throw new Error("config.json: ticker must be one to six letters, like ETSY");
    if (seen.has(ticker)) continue;
    seen.add(ticker);
    const e = { ticker };
    if (w.keyLevel != null || w.supportLevel != null) {
      const v = validateConfig({ ...w, ticker });
      e.keyLevel = v.keyLevel; e.supportLevel = v.supportLevel; e.volumeMultiple = v.volumeMultiple;
    }
    if (w.risk && RISK[w.risk]) e.risk = w.risk;
    watchlist.push(e);
  }
  if (!watchlist.length) throw new Error("config.json: the watchlist is empty");
  if (watchlist.length > MAX_WATCH) throw new Error("config.json: the watchlist can hold at most " + MAX_WATCH + " stocks");
  return { digest: c.digest == null ? true : c.digest !== false, watchlist };
}

// The data file is now { version: 2, updatedAt, stocks: { TICKER: reading } }. A single-stock file from before is wrapped.
export function normalizeData(d) {
  if (d && typeof d === "object" && d.stocks && typeof d.stocks === "object") return { version: 2, updatedAt: d.updatedAt || null, stocks: d.stocks, seeded: !!d.seeded, notified: d.notified && typeof d.notified === "object" ? d.notified : {} };
  if (d && typeof d === "object" && d.ticker) return { version: 2, updatedAt: d.checkedAt || null, stocks: { [d.ticker]: d }, seeded: !!d.seeded, notified: {} };
  return { version: 2, updatedAt: null, stocks: {}, seeded: false, notified: {} };
}

export function autoLevels(history, close, risk) {
  const r = RISK[risk] ? risk : "balanced";
  const p = preset(history, close, r);
  return { keyLevel: p.level.price, supportLevel: p.support.price, volumeMultiple: p.mult, risk: r };
}

// The settings a stock is actually judged by: its own levels, else the ones picked automatically, else null.
export function effectiveCfg(entry, stock) {
  if (entry && entry.keyLevel > 0 && entry.supportLevel > 0) {
    return { ticker: entry.ticker, keyLevel: entry.keyLevel, supportLevel: entry.supportLevel, volumeMultiple: entry.volumeMultiple || 1.5, risk: entry.risk, auto: false };
  }
  if (entry && stock && stock.auto && stock.auto.keyLevel > 0) {
    return { ticker: entry.ticker, keyLevel: stock.auto.keyLevel, supportLevel: stock.auto.supportLevel, volumeMultiple: stock.auto.volumeMultiple || 1.5, risk: stock.auto.risk, auto: true };
  }
  return null;
}

// One push for the whole watchlist. items: [{ticker, next, cfg, decision}]. Returns null when nothing should be sent.
export function summarize(items, digest) {
  const flagged = items.filter((i) => i.decision.alert);
  if (!flagged.length && !digest) return null;
  const line = (i) => (i.decision.alert
    ? i.decision.body
    : i.ticker + " closed at " + fmtPrice(i.next.close) + ". " + evaluate(i.next, i.cfg).head + ".");
  const ordered = flagged.concat(items.filter((i) => !i.decision.alert));
  let title;
  if (items.length === 1) title = "Close Check - " + items[0].ticker;
  else if (flagged.length) title = "Close Check - " + flagged.length + " of " + items.length + " need a look";
  else title = "Close Check - daily summary";
  return { title, body: ordered.map(line).join("\n") };
}

// Next-morning follow-through: how the price is behaving against yesterday's close verdict.
// prev is the last recorded close reading (close, volume, avgVolume20, ma50). Signals only, never advice.
export function followThrough(live, prev, cfg) {
  const p = live.price, key = cfg.keyLevel, sup = cfg.supportLevel;
  const base = live.prevClose || prev.close;
  const gap = (p / base - 1) * 100;
  const yEval = evaluate(prev, cfg);
  const side = yEval.state.endsWith("-up") ? "up" : yEval.state.endsWith("-down") ? "down" : "none";
  const g = pctStr(gap);
  let kind, text, flagged = true;
  if (side === "up") {
    if (p < key) { kind = "failed"; text = "back under your " + fmtPrice(key) + " level, so the breakout has not held so far"; }
    else if (gap <= -1) { kind = "fading"; text = "still above your " + fmtPrice(key) + " level but down " + g + " from the close, so it is fading"; }
    else if (gap >= 3) { kind = "extended"; text = "gapped up " + g + ", well above your " + fmtPrice(key) + " level (a big gap is a more stretched entry)"; }
    else { kind = "holding"; text = "holding above your " + fmtPrice(key) + " level, so the move is following through"; }
  } else if (side === "down") {
    if (p > sup) { kind = "failed"; text = "back above " + fmtPrice(sup) + " support, so the breakdown has not held so far"; }
    else if (gap >= 1) { kind = "bouncing"; text = "still under " + fmtPrice(sup) + " support but bouncing " + g + " from the close"; }
    else { kind = "holding"; text = "still under " + fmtPrice(sup) + " support, so the weakness is continuing"; }
  } else if (p > key) { kind = "crossed"; text = "now above your " + fmtPrice(key) + " level, but yesterday closed below it. Wait for a close"; }
  else if (p < sup) { kind = "crossed"; text = "now under " + fmtPrice(sup) + " support, but yesterday closed above it. Wait for a close"; }
  else { kind = "none"; text = "no setup from yesterday and still between your lines"; flagged = false; }
  return { side, kind, text, flagged, gap, yesterday: yEval.head };
}

// items: [{ticker, live, ft}]. Returns null when nothing should be sent.
export function summarizeMorning(items, digest) {
  const flagged = items.filter((i) => i.ft.flagged);
  if (!flagged.length && !digest) return null;
  const line = (i) => i.ticker + " " + fmtPrice(i.live.price) + " (" + (i.ft.gap >= 0 ? "+" : "-") + pctStr(i.ft.gap) + " vs yesterday's close). Yesterday: " + i.ft.yesterday.toLowerCase() + ". This morning: " + i.ft.text + ".";
  const ordered = flagged.concat(items.filter((i) => !i.ft.flagged));
  const title = flagged.length ? "Close Check - morning follow-through: " + flagged.length + " of " + items.length + " to review" : "Close Check - morning follow-through";
  return { title, body: ordered.map(line).join("\n") + "\nA 10 AM read, not advice. Only the close counts." };
}
