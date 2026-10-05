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
function harness(rows) {
  const pushes = [];
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).startsWith("https://ntfy.sh/")) { pushes.push({ url: String(url), headers: opts.headers, body: opts.body }); return { ok: true, status: 200 }; }
    return { ok: true, status: 200, json: async () => twelvePayload(rows) };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-"));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ ticker: "ETSY", ...cfg }));
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
  const saved = JSON.parse(fs.readFileSync(path.join(h.dir, "data.json"), "utf8"));
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
