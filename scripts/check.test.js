import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { alertFor, buildReading, countHeavy, evaluate, levelChips, mean, preset, r2, rollingRatios, supportChips, validateConfig } from "../site/logic.js";
import { fetchDaily, parseAlphaVantage, parseTwelveData } from "./providers.js";
import { etNow, run } from "./check.js";

const rows50 = JSON.parse(fs.readFileSync(new URL("./fixtures/etsy-50.json", import.meta.url), "utf8")).history;
const cfg = { keyLevel: 77.7, supportLevel: 70, volumeMultiple: 1.5 };

// Business-day rows ending on endDate. closeFn/volFn get (index, count).
function synth(endDate, n, closeFn, volFn) {
  const dates = [];
  const d = new Date(endDate + "T00:00:00Z");
  while (dates.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  dates.reverse();
  return dates.map((date, i) => ({ date, close: closeFn(i, n), volume: volFn(i, n) }));
}
const twelvePayload = (rows) => ({
  meta: { symbol: "ETSY", interval: "1day" },
  values: rows.slice().reverse().map((r) => ({ datetime: r.date, open: "1.0", high: "1.0", low: "1.0", close: r.close.toFixed(5), volume: String(r.volume) })),
  status: "ok",
});
function readStock(dir, t = "ETSY") { return JSON.parse(fs.readFileSync(path.join(dir, "data.json"), "utf8")).stocks[t]; }
function harness(rows) {
  const pushes = [];
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).startsWith("https://ntfy.sh/")) { pushes.push({ url: String(url), headers: opts.headers, body: opts.body }); return { ok: true, status: 200 }; }
    return { ok: true, status: 200, json: async () => twelvePayload(rows) };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-"));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ ticker: "ETSY", ...cfg, digest: false }));
  return { pushes, fetchImpl, dir, env: { TWELVE_DATA_API_KEY: "k-secret", NTFY_TOPIC: "topic-secret", PAGE_URL: "https://me.github.io/close-check/" }, log: () => {} };
}

test("buildReading matches independent arithmetic on the real history", () => {
  const r = buildReading(rows50, "ETSY");
  assert.equal(r.asOf, "2026-10-01");
  assert.equal(r.close, 72.84);
  assert.equal(r.volume, 2749921);
  assert.equal(r.avgVolume20, Math.round(mean(rows50.slice(29, 49).map((x) => x.volume))));
  assert.equal(r.ma50, r2(mean(rows50.map((x) => x.close))));
  assert.equal(r.ma200, null);
  assert.throws(() => buildReading(rows50.slice(0, 10), "ETSY"), /22 sessions/);
});

test("evaluate: all five verdicts", () => {
  const base = { ticker: "ETSY", close: 72.84, volume: 2749921, avgVolume20: 3361392, ma50: 78.38 };
  assert.equal(evaluate(base, cfg).state, "wait");
  assert.equal(evaluate({ ...base, close: 79.1, volume: 5600000, ma50: 76 }, cfg).state, "confirm-up");
  assert.equal(evaluate({ ...base, close: 79.1, volume: 2000000, ma50: 76 }, cfg).state, "partial-up");
  assert.equal(evaluate({ ...base, close: 68.9, volume: 6000000 }, cfg).state, "confirm-down");
  assert.equal(evaluate({ ...base, close: 68.9, volume: 2000000 }, cfg).state, "partial-down");
  assert.match(evaluate({ ...base, close: 79.1, volume: null, ma50: 76 }, cfg).why, /volume data is not available/);
});

test("alertFor: quiet day, cross, near level, support break", () => {
  const mk = (close, volume = 1e6, ma50 = 70) => ({ ticker: "ETSY", close, volume, avgVolume20: 1e6, ma50 });
  assert.equal(alertFor(mk(71.49), mk(72.84), cfg).alert, false);
  const cross = alertFor(mk(76), mk(79, 2e6), cfg);
  assert.equal(cross.alert, true);
  assert.match(cross.body, /Closed above your 77\.70 level/);
  assert.match(cross.body, /Bullish confirmation/);
  const near = alertFor(mk(76.4), mk(76.5), cfg);
  assert.deepEqual(near.reasons, ["Within 2% of your 77.70 level."]);
  const brk = alertFor(mk(71), mk(69, 3e6, 80), cfg);
  assert.ok(brk.reasons.some((x) => /Closed under 70\.00 support/.test(x)));
  assert.equal(alertFor(null, mk(72), cfg).alert, false);
  assert.ok(/^[\x20-\x7e]+$/.test(cross.title), "title must be plain ASCII for an HTTP header");
});

test("risk presets on the real history give ordered, valid numbers", () => {
  const close = 72.84;
  const b = preset(rows50, close, "balanced");
  assert.equal(b.level.price, 75.14);
  assert.equal(b.support.price, 68.44);
  assert.equal(preset(rows50, close, "cautious").level.price, 80.67);
  const a = preset(rows50, close, "aggressive");
  assert.equal(a.support.fallback, true);
  assert.equal(a.support.price, 67.74);
  for (const k of ["cautious", "balanced", "aggressive"]) {
    const p = preset(rows50, close, k);
    assert.ok(p.level.price > close && p.support.price < close);
  }
  assert.equal(levelChips(rows50, close, 78.38, null)[0].price, 74.46);
  assert.equal(supportChips(rows50, close, 78.38, 65.68).at(-1).price, 65.68);
  const rr = rollingRatios(rows50);
  assert.deepEqual([1.25, 1.5, 2].map((m) => countHeavy(rr, m)), [6, 3, 1]);
});

test("validateConfig accepts good input and rejects bad input", () => {
  assert.deepEqual(validateConfig({ ticker: "etsy", keyLevel: 77.7, supportLevel: 70 }), { ticker: "ETSY", keyLevel: 77.7, supportLevel: 70, volumeMultiple: 1.5 });
  assert.throws(() => validateConfig({ ticker: "ETSY", keyLevel: 70, supportLevel: 77 }), /higher than/);
  assert.throws(() => validateConfig({ ticker: "12", keyLevel: 2, supportLevel: 1 }), /ticker/);
  assert.throws(() => validateConfig({ ticker: "ETSY", keyLevel: 2, supportLevel: 1, volumeMultiple: 9 }), /between 1 and 5/);
});

test("provider parsers: both formats, errors, junk rows", () => {
  const td = parseTwelveData({ status: "ok", values: [
    { datetime: "2026-10-02", close: "72.77", volume: "2800000" },
    { datetime: "2026-10-01", close: "72.84000", volume: "2749921" },
    { datetime: "bad", close: "1", volume: "1" },
    { datetime: "2026-09-30", close: "n/a", volume: "1" },
  ] });
  assert.deepEqual(td.map((r) => r.date), ["2026-10-01", "2026-10-02"]);
  assert.equal(td[0].close, 72.84);
  assert.throws(() => parseTwelveData({ code: 401, message: "bad key", status: "error" }), /bad key/);
  const av = parseAlphaVantage({ "Time Series (Daily)": { "2026-10-01": { "4. close": "72.84", "5. volume": "2749921" }, "2026-09-30": { "4. close": "71.49", "5. volume": "3716701" } } });
  assert.deepEqual(av.map((r) => r.date), ["2026-09-30", "2026-10-01"]);
  assert.throws(() => parseAlphaVantage({ Information: "rate limit" }), /rate limit/);
});

test("fetchDaily: needs a key, retries a network blip once, never leaks the key", async () => {
  await assert.rejects(fetchDaily({ ticker: "ETSY", env: {} }), /No data key/);
  let calls = 0;
  const flaky = async () => { calls++; if (calls === 1) throw new Error("fetch failed"); return { status: 200, json: async () => twelvePayload(rows50) }; };
  const rows = await fetchDaily({ ticker: "ETSY", env: { TWELVE_DATA_API_KEY: "k-secret" }, fetchImpl: flaky, sleep: async () => {} });
  assert.equal(calls, 2);
  assert.equal(rows.length, 50);
  const leaky = async () => { throw new Error("boom k-secret boom"); };
  await assert.rejects(fetchDaily({ ticker: "ETSY", env: { TWELVE_DATA_API_KEY: "k-secret" }, fetchImpl: leaky, sleep: async () => {} }), (e) => !e.message.includes("k-secret"));
  const denied = async () => ({ status: 200, json: async () => ({ status: "error", code: 429, message: "limit" }) });
  let n = 0;
  await assert.rejects(fetchDaily({ ticker: "ETSY", env: { TWELVE_DATA_API_KEY: "k" }, fetchImpl: async (...a) => { n++; return denied(...a); }, sleep: async () => {} }), /limit/);
  assert.equal(n, 1, "a provider error is not retried");
});

test("etNow handles daylight and standard time", () => {
  assert.deepEqual(etNow(new Date("2026-10-05T20:30:00Z")), { date: "2026-10-05", minutes: 16 * 60 + 30 });
  assert.deepEqual(etNow(new Date("2026-12-07T21:30:00Z")), { date: "2026-12-07", minutes: 16 * 60 + 30 });
  assert.deepEqual(etNow(new Date("2026-12-07T20:30:00Z")), { date: "2026-12-07", minutes: 15 * 60 + 30 });
  assert.deepEqual(etNow(new Date("2026-10-06T03:59:00Z")), { date: "2026-10-05", minutes: 23 * 60 + 59 });
});

test("run: breakout day alerts once, saves 60 sessions, second run is a no-op", async () => {
  const rows = synth("2026-10-05", 260, (i, n) => (i === n - 1 ? 79 : i === n - 2 ? 76 : 70), (i, n) => (i === n - 1 ? 2e6 : 1e6));
  const h = harness(rows);
  const now = new Date("2026-10-05T20:30:00Z");
  const first = await run({ now, env: h.env, fetchImpl: h.fetchImpl, dir: h.dir, log: h.log });
  assert.equal(first.changed, true);
  assert.equal(first.alerted, true);
  assert.equal(h.pushes.length, 1);
  assert.equal(h.pushes[0].url, "https://ntfy.sh/topic-secret");
  assert.equal(h.pushes[0].headers.Click, "https://me.github.io/close-check/");
  assert.match(h.pushes[0].body, /Bullish confirmation/);
  const saved = readStock(h.dir);
  assert.equal(saved.asOf, "2026-10-05");
  assert.equal(saved.history.length, 60);
  assert.equal(saved.ma200 !== null, true);
  const second = await run({ now: new Date("2026-10-05T20:55:00Z"), env: h.env, fetchImpl: h.fetchImpl, dir: h.dir, log: h.log });
  assert.equal(second.changed, false);
  assert.equal(h.pushes.length, 1, "no duplicate alert");
});

test("run: quiet day saves data without a push", async () => {
  const rows = synth("2026-10-05", 260, () => 72, () => 1e6);
  const h = harness(rows);
  const res = await run({ now: new Date("2026-10-05T20:30:00Z"), env: h.env, fetchImpl: h.fetchImpl, dir: h.dir, log: h.log });
  assert.equal(res.changed, true);
  assert.equal(res.alerted, false);
  assert.equal(h.pushes.length, 0);
});

test("run: skips before the close, on holidays, and on stale data", async () => {
  const rows = synth("2026-10-05", 260, () => 72, () => 1e6);
  let h = harness(rows);
  let res = await run({ now: new Date("2026-10-05T19:30:00Z"), env: h.env, fetchImpl: h.fetchImpl, dir: h.dir, log: h.log });
  assert.equal(res.reason, "the market has not closed yet");
  assert.equal(fs.existsSync(path.join(h.dir, "data.json")), false);
  h = harness(synth("2026-10-02", 260, () => 72, () => 1e6));
  res = await run({ now: new Date("2026-10-05T20:30:00Z"), env: h.env, fetchImpl: h.fetchImpl, dir: h.dir, log: h.log });
  assert.equal(res.reason, "no session for today has been posted yet");
  assert.equal(fs.existsSync(path.join(h.dir, "data.json")), false);
});

test("run: a failed push saves nothing so the next slot retries", async () => {
  const rows = synth("2026-10-05", 260, (i, n) => (i === n - 1 ? 79 : i === n - 2 ? 76 : 70), (i, n) => (i === n - 1 ? 2e6 : 1e6));
  const h = harness(rows);
  const failing = async (url, opts) => (String(url).startsWith("https://ntfy.sh/") ? { ok: false, status: 500 } : h.fetchImpl(url, opts));
  await assert.rejects(run({ now: new Date("2026-10-05T20:30:00Z"), env: h.env, fetchImpl: failing, dir: h.dir, log: h.log }), /ntfy returned HTTP 500/);
  assert.equal(fs.existsSync(path.join(h.dir, "data.json")), false);
});

test("run: test_push and check_data modes", async () => {
  const rows = synth("2026-10-05", 260, () => 72, () => 1e6);
  const h = harness(rows);
  const lines = [];
  const t = await run({ mode: "test_push", env: h.env, fetchImpl: h.fetchImpl, dir: h.dir, log: (m) => lines.push(m) });
  assert.equal(t.alerted, true);
  assert.equal(h.pushes[0].headers.Title, "Close Check - test");
  const c = await run({ mode: "check_data", now: new Date("2026-10-05T12:00:00Z"), env: h.env, fetchImpl: h.fetchImpl, dir: h.dir, log: (m) => lines.push(m) });
  assert.equal(c.reason, "check");
  assert.ok(lines.some((m) => /The data key works/.test(m)));
  assert.equal(fs.existsSync(path.join(h.dir, "data.json")), false);
});

test("run: live snapshots add today-so-far without touching the verdict or alerting", async () => {
  const closed = synth("2026-10-02", 260, () => 72, () => 1e6);
  const h = harness(closed);
  await run({ now: new Date("2026-10-02T20:30:00Z"), env: h.env, fetchImpl: h.fetchImpl, dir: h.dir, log: h.log });
  const before = readStock(h.dir);
  const withToday = synth("2026-10-05", 260, (i, n) => (i === n - 1 ? 78.5 : 72), (i, n) => (i === n - 1 ? 4e5 : 1e6));
  const h2 = { ...harness(withToday), dir: h.dir };
  const am = new Date("2026-10-05T14:00:00Z"); // 10:00 AM EDT
  const r = await run({ mode: "live", now: am, env: h2.env, fetchImpl: h2.fetchImpl, dir: h.dir, log: h.log });
  assert.equal(r.changed, true);
  const after = readStock(h.dir);
  assert.equal(after.asOf, before.asOf);
  assert.equal(after.close, before.close);
  assert.deepEqual(after.live, { date: "2026-10-05", price: 78.5, volume: 4e5, prevClose: 72, fetchedAt: am.toISOString() });
  assert.equal(h2.pushes.length, 0, "live snapshots never notify");
  const again = await run({ mode: "live", now: new Date("2026-10-05T15:00:00Z"), env: h2.env, fetchImpl: h2.fetchImpl, dir: h.dir, log: h.log });
  assert.equal(again.changed, true, "a manual live run refreshes it every time");
  const pre = await run({ mode: "live", now: new Date("2026-10-05T12:00:00Z"), env: h2.env, fetchImpl: h2.fetchImpl, dir: h.dir, log: h.log });
  assert.equal(pre.changed, false, "before the open there is nothing live");
  await run({ now: new Date("2026-10-05T20:30:00Z"), env: h2.env, fetchImpl: h2.fetchImpl, dir: h.dir, log: h.log });
  assert.equal(readStock(h.dir).live, undefined, "the evening check replaces the snapshot with the official close");
});

test("morning mode: one 10 AM notification a day, saved snapshot, no repeats, not sent late", async () => {
  const dir0 = harness(synth("2026-10-02", 260, () => 72, () => 1e6));
  await run({ now: new Date("2026-10-02T20:30:00Z"), env: dir0.env, fetchImpl: dir0.fetchImpl, dir: dir0.dir, log: dir0.log });
  const today = synth("2026-10-05", 260, (i, n) => (i === n - 1 ? 78.5 : 72), () => 1e6);
  const h = { ...harness(today), dir: dir0.dir };
  const at = (iso, extra = {}) => run({ mode: "morning", now: new Date(iso), env: h.env, fetchImpl: h.fetchImpl, dir: h.dir, log: h.log, ...extra });
  assert.equal((await at("2026-10-05T13:30:00Z")).reason, "the market is not open", "9:30 AM is before the first snapshot window");
  const r = await at("2026-10-05T14:00:20Z");
  assert.equal(r.changed, true);
  assert.equal(h.pushes.length, 1);
  assert.equal(h.pushes[0].headers.Title, "Close Check - morning: 1 of 1 need a look");
  assert.match(h.pushes[0].body, /ETSY 78\.50 \(\+9\.0% today\): trading above your 77\.70 level\./);
  assert.match(h.pushes[0].body, /Only the close counts/);
  const saved = JSON.parse(fs.readFileSync(path.join(h.dir, "data.json"), "utf8"));
  assert.equal(saved.notified.morning, "2026-10-05");
  assert.equal(saved.stocks.ETSY.live.price, 78.5);
  const second = await at("2026-10-05T14:30:00Z");
  assert.equal(second.changed, false, "the later slot sends nothing more");
  assert.equal(h.pushes.length, 1);
  // The evening record keeps the marker, and the next day starts fresh.
  await run({ now: new Date("2026-10-05T20:30:00Z"), env: h.env, fetchImpl: h.fetchImpl, dir: h.dir, log: h.log });
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, "data.json"), "utf8")).notified.morning, "2026-10-05");
});

test("morning mode: quiet mornings follow the daily-summary setting, and a slot after 11 AM is dropped", async () => {
  const mk = (digest) => multiHarness({ AAA: flat("2026-10-06"), BBB: flat("2026-10-06") }, { digest, watchlist: [{ ticker: "AAA", keyLevel: 90, supportLevel: 30 }, { ticker: "BBB", keyLevel: 90, supportLevel: 30 }] });
  for (const digest of [false, true]) {
    const h = mk(digest);
    fs.writeFileSync(path.join(h.dir, "data.json"), JSON.stringify({ version: 2, stocks: { AAA: { ...buildReading(flat("2026-10-05"), "AAA"), history: [] }, BBB: { ...buildReading(flat("2026-10-05"), "BBB"), history: [] } } }));
    const r = await run({ mode: "morning", now: new Date("2026-10-06T14:00:30Z"), env: h.env, fetchImpl: h.fetchImpl, dir: h.dir, log: h.log, sleep: h.sleep });
    assert.equal(r.changed, true);
    assert.equal(h.pushes.length, digest ? 1 : 0);
    if (digest) { assert.equal(h.pushes[0].headers.Title, "Close Check - morning update"); assert.match(h.pushes[0].body, /AAA 50\.00 \(\+0\.0% today\): between your lines\./); }
    const late = await run({ mode: "morning", now: new Date("2026-10-07T16:30:00Z"), env: h.env, fetchImpl: h.fetchImpl, dir: h.dir, log: h.log, sleep: h.sleep });
    assert.equal(late.reason, "it is too late for a morning update");
  }
});

// ---------- Watchlist ----------
function multiHarness(bySymbol, config) {
  const pushes = [], sleeps = [], fetched = [];
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).startsWith("https://ntfy.sh/")) { pushes.push({ headers: opts.headers, body: opts.body }); return { ok: true, status: 200 }; }
    const sym = new URL(String(url)).searchParams.get("symbol");
    fetched.push(sym);
    if (bySymbol[sym] === "error") return { ok: true, status: 200, json: async () => ({ status: "error", message: "symbol not found" }) };
    return { ok: true, status: 200, json: async () => twelvePayload(bySymbol[sym]) };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-"));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
  return { pushes, sleeps, fetched, fetchImpl, dir, sleep: async (ms) => { sleeps.push(ms); }, env: { TWELVE_DATA_API_KEY: "k", NTFY_TOPIC: "t" }, log: () => {} };
}
const stock = (i, d) => synth(d || "2026-10-05", 260, (j, n) => (j === n - 1 ? 79 : j === n - 2 ? 76 : 70), (j, n) => (j === n - 1 ? 2e6 : 1e6));
const flat = (d) => synth(d || "2026-10-05", 260, () => 50 + 0.0 * 1, () => 1e6);
const after = new Date("2026-10-05T20:30:00Z");

test("watchlist: one summary push, auto levels for a stock with none, no alert on that first reading", async () => {
  const h = multiHarness({ ETSY: stock(), CEG: flat(), ZZZ: flat() }, { digest: true, watchlist: [{ ticker: "ETSY", keyLevel: 77.7, supportLevel: 70, volumeMultiple: 1.5 }, { ticker: "CEG", risk: "cautious" }, { ticker: "ZZZ" }] });
  const res = await run({ now: after, env: h.env, fetchImpl: h.fetchImpl, dir: h.dir, log: h.log, sleep: h.sleep });
  assert.equal(res.changed, true);
  assert.equal(h.pushes.length, 1, "exactly one push for three stocks");
  assert.equal(h.pushes[0].headers.Title, "Close Check - 1 of 3 need a look");
  assert.match(h.pushes[0].body, /ETSY closed at 79\.00\. Bullish confirmation/);
  assert.match(h.pushes[0].body, /CEG closed at 50\.00/);
  assert.match(h.pushes[0].body, /ZZZ closed at 50\.00/);
  assert.ok(h.pushes[0].body.indexOf("ETSY") < h.pushes[0].body.indexOf("CEG"), "alerting stocks come first");
  assert.match(h.pushes[0].headers.Title, /^[\x20-\x7e]+$/);
  const d = JSON.parse(fs.readFileSync(path.join(h.dir, "data.json"), "utf8"));
  assert.deepEqual(Object.keys(d.stocks).sort(), ["CEG", "ETSY", "ZZZ"]);
  assert.equal(d.stocks.ETSY.auto, undefined);
  assert.equal(d.stocks.CEG.auto.risk, "cautious");
  assert.equal(d.stocks.ZZZ.auto.risk, "balanced");
  assert.ok(d.stocks.CEG.auto.keyLevel > d.stocks.CEG.auto.supportLevel);
  assert.equal(d.stocks.CEG.history.length, 60);
});

test("watchlist: digest off sends only when something needs a look; digest on sends a daily summary on quiet days", async () => {
  const cfgQuiet = (digest) => ({ digest, watchlist: [{ ticker: "AAA", keyLevel: 90, supportLevel: 30, volumeMultiple: 1.5 }, { ticker: "BBB", keyLevel: 90, supportLevel: 30, volumeMultiple: 1.5 }] });
  let h = multiHarness({ AAA: flat(), BBB: flat() }, cfgQuiet(false));
  await run({ now: after, env: h.env, fetchImpl: h.fetchImpl, dir: h.dir, log: h.log, sleep: h.sleep });
  assert.equal(h.pushes.length, 0);
  h = multiHarness({ AAA: flat(), BBB: flat() }, cfgQuiet(true));
  await run({ now: after, env: h.env, fetchImpl: h.fetchImpl, dir: h.dir, log: h.log, sleep: h.sleep });
  assert.equal(h.pushes.length, 1);
  assert.equal(h.pushes[0].headers.Title, "Close Check - daily summary");
  assert.equal(h.pushes[0].body.split("\n").length, 2);
});

test("watchlist: one failing ticker does not stop the others, and only unrecorded ones are fetched next time", async () => {
  const h = multiHarness({ AAA: flat(), BAD: "error", CCC: flat() }, { digest: false, watchlist: [{ ticker: "AAA", keyLevel: 90, supportLevel: 30 }, { ticker: "BAD", keyLevel: 90, supportLevel: 30 }, { ticker: "CCC", keyLevel: 90, supportLevel: 30 }] });
  const res = await run({ now: after, env: h.env, fetchImpl: h.fetchImpl, dir: h.dir, log: h.log, sleep: h.sleep });
  assert.equal(res.changed, true);
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0], /^BAD: /);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(h.dir, "data.json"), "utf8")).stocks).sort(), ["AAA", "CCC"]);
  h.fetched.length = 0;
  await run({ now: new Date("2026-10-05T20:55:00Z"), env: h.env, fetchImpl: h.fetchImpl, dir: h.dir, log: h.log, sleep: h.sleep });
  assert.deepEqual(h.fetched, ["BAD"], "recorded stocks cost no credit on the next slot");
});

test("watchlist: paces requests to eight a minute and skips fetching when everything is recorded", async () => {
  const names = Array.from({ length: 10 }, (_, i) => "S" + String.fromCharCode(65 + i));
  const by = Object.fromEntries(names.map((n) => [n, flat()]));
  const h = multiHarness(by, { digest: false, watchlist: names.map((ticker) => ({ ticker, keyLevel: 90, supportLevel: 30 })) });
  await run({ now: after, env: h.env, fetchImpl: h.fetchImpl, dir: h.dir, log: h.log, sleep: h.sleep });
  assert.equal(h.fetched.length, 10);
  assert.deepEqual(h.sleeps, [61000], "one pause after the first eight");
  h.fetched.length = 0;
  const again = await run({ now: new Date("2026-10-05T21:30:00Z"), env: h.env, fetchImpl: h.fetchImpl, dir: h.dir, log: h.log, sleep: h.sleep });
  assert.equal(again.changed, false);
  assert.equal(h.fetched.length, 0);
});

test("watchlist: removing a stock prunes it; an old single-stock data file still reads", async () => {
  const h = multiHarness({ AAA: flat(), BBB: flat() }, { digest: false, watchlist: [{ ticker: "AAA", keyLevel: 90, supportLevel: 30 }] });
  fs.writeFileSync(path.join(h.dir, "data.json"), JSON.stringify({ ticker: "OLD", asOf: "2026-10-02", close: 1, history: [] }));
  await run({ now: after, env: h.env, fetchImpl: h.fetchImpl, dir: h.dir, log: h.log, sleep: h.sleep });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(h.dir, "data.json"), "utf8")).stocks), ["AAA"]);
});

test("refresh mode picks live in market hours, normal after the close, and nothing otherwise", async () => {
  const h = multiHarness({ AAA: flat() }, { digest: false, watchlist: [{ ticker: "AAA", keyLevel: 90, supportLevel: 30 }] });
  const go = (iso) => run({ mode: "refresh", now: new Date(iso), env: h.env, fetchImpl: h.fetchImpl, dir: h.dir, log: h.log, sleep: h.sleep });
  assert.match((await go("2026-10-03T15:00:00Z")).reason, /market is closed/, "Saturday");
  assert.match((await go("2026-10-05T11:00:00Z")).reason, /market is closed/, "7 AM Monday");
  assert.equal((await go("2026-10-05T20:30:00Z")).reason, "recorded", "after the close it records the close");
  const today = flat("2026-10-06");
  h.fetched.length = 0;
  const h2 = multiHarness({ AAA: today }, { digest: false, watchlist: [{ ticker: "AAA", keyLevel: 90, supportLevel: 30 }] });
  fs.copyFileSync(path.join(h.dir, "data.json"), path.join(h2.dir, "data.json"));
  const live = await run({ mode: "refresh", now: new Date("2026-10-06T15:00:00Z"), env: h2.env, fetchImpl: h2.fetchImpl, dir: h2.dir, log: h2.log, sleep: h2.sleep });
  assert.equal(live.reason, "live");
  assert.equal(h2.pushes.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h2.dir, "data.json"), "utf8")).stocks.AAA.live.date, "2026-10-06");
});

test("normalizeConfig: old shape, duplicates, limits and bad levels", async () => {
  const { normalizeConfig } = await import("../site/logic.js");
  assert.equal(normalizeConfig({ ticker: "etsy", keyLevel: 77.7, supportLevel: 70 }).watchlist[0].volumeMultiple, 1.5);
  assert.equal(normalizeConfig({ watchlist: [{ ticker: "a" }, { ticker: "A" }] }).watchlist.length, 1);
  assert.equal(normalizeConfig({ watchlist: [{ ticker: "A" }] }).digest, true);
  assert.throws(() => normalizeConfig({ watchlist: [] }), /empty/);
  assert.throws(() => normalizeConfig({ watchlist: Array.from({ length: 13 }, (_, i) => ({ ticker: "T" + String.fromCharCode(65 + i) })) }), /at most 12/);
  assert.throws(() => normalizeConfig({ watchlist: [{ ticker: "A", keyLevel: 10, supportLevel: 20 }] }), /higher than/);
  assert.throws(() => normalizeConfig({ watchlist: [{ ticker: "1X" }] }), /ticker/);
});

test("close check: records from 4:02 PM, and a scheduled run keeps trying until the closing numbers appear", async () => {
  const yesterday = flat("2026-10-02"), todayRows = flat("2026-10-05");
  let calls = 0;
  const pushes = [], sleeps = [];
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).startsWith("https://ntfy.sh/")) { pushes.push({ headers: opts.headers, body: opts.body }); return { ok: true, status: 200 }; }
    calls++;
    return { ok: true, status: 200, json: async () => twelvePayload(calls <= 2 ? yesterday : todayRows) };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-"));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ digest: true, watchlist: [{ ticker: "AAA", keyLevel: 90, supportLevel: 30 }] }));
  const env = { TWELVE_DATA_API_KEY: "k", NTFY_TOPIC: "t", RETRY_UNTIL_READY: "true" };
  const sleep = async (ms) => { sleeps.push(ms); };
  const early = await run({ now: new Date("2026-10-05T20:01:30Z"), env, fetchImpl, dir, log: () => {}, sleep });
  assert.equal(early.reason, "the market has not closed yet", "4:01 PM is too early");
  assert.equal(calls, 0, "and it costs no credit");
  const res = await run({ now: new Date("2026-10-05T20:02:15Z"), env, fetchImpl, dir, log: () => {}, sleep });
  assert.equal(res.changed, true);
  assert.equal(calls, 3, "two tries found only yesterday's bar, the third found today's");
  assert.deepEqual(sleeps, [60000, 60000]);
  assert.equal(pushes.length, 1);
  // Without the retry flag (a manual run), it gives up at once.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "cc-"));
  fs.copyFileSync(path.join(dir, "config.json"), path.join(dir2, "config.json"));
  calls = 0; sleeps.length = 0;
  const manual = await run({ now: new Date("2026-10-05T20:02:15Z"), env: { ...env, RETRY_UNTIL_READY: "false" }, fetchImpl: async (u, o) => (String(u).startsWith("https://ntfy.sh/") ? fetchImpl(u, o) : { ok: true, status: 200, json: async () => twelvePayload(yesterday) }), dir: dir2, log: () => {}, sleep });
  assert.equal(manual.reason, "no session for today has been posted yet");
  assert.deepEqual(sleeps, []);
});

test("liveVerdict: provisional verdict projects volume so far to a full day", async () => {
  const { liveVerdict, volumeShare } = await import("../site/logic.js");
  assert.ok(Math.abs(volumeShare(30) - 0.17) < 1e-9);
  const cfg = { keyLevel: 100, supportLevel: 90, volumeMultiple: 1.5 };
  const stock = { avgVolume20: 1000, ma50: 95 };
  // 10:00 AM ET = 14:00Z in October. 300 shares by 10:00 projects to ~1765, 1.8x.
  const up = liveVerdict({ price: 101, volume: 300, fetchedAt: "2026-10-26T14:00:30Z" }, stock, cfg);
  assert.equal(up.state, "confirm-up");
  const slow = liveVerdict({ price: 101, volume: 100, fetchedAt: "2026-10-26T14:00:30Z" }, stock, cfg);
  assert.equal(slow.state, "partial-up");
  assert.match(slow.pace, /needs 1\.5x/);
  assert.equal(liveVerdict(null, stock, cfg), null);
});
