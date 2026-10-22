// The after-close check. Runs in GitHub Actions; also importable for tests.
//
// MODE=normal      record each stock's close if it is new, send one notification for the whole watchlist
// MODE=check_data  fetch and print the latest rows only (use this to test your data key)
// MODE=test_push   send a test notification only
// MODE=morning     the 10 AM update: saves a "today so far" snapshot and sends one morning notification (once a day)
// MODE=live        the same snapshot with no notification, run by hand any time the market is open
//                  Snapshots only show "today so far" on the page. They never change the verdict.
// MODE=refresh     what the page's Refresh button asks for: live during market hours, normal after the close, nothing otherwise
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { alertFor, autoLevels, buildReading, effectiveCfg, evaluate, fmtPrice, morningStatus, normalizeConfig, normalizeData, summarize, summarizeMorning } from "../site/logic.js";
import { fetchDaily } from "./providers.js";

const OPEN = 9 * 60 + 35, CLOSE = 16 * 60 + 5; // live snapshots are taken between these
const RECORD_AT = 16 * 60 + 2; // the close is recorded from 4:02 PM ET, once the closing numbers are published
const MORNING_LATEST = 11 * 60; // a morning update later than this is not sent
const FREE_PLAN_PER_MINUTE = 8; // Twelve Data's free plan allows 8 requests a minute

export function etNow(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const g = (t) => parts.find((p) => p.type === t).value;
  return { date: g("year") + "-" + g("month") + "-" + g("day"), minutes: parseInt(g("hour"), 10) * 60 + parseInt(g("minute"), 10) };
}

function etWeekend(now) {
  const d = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(now);
  return d === "Sat" || d === "Sun";
}

async function push({ title, body, env, fetchImpl, log }) {
  const topic = (env.NTFY_TOPIC || "").trim();
  if (!topic) { log("NTFY_TOPIC is not set, so no notification was sent."); return false; }
  const headers = { Title: title };
  if (env.PAGE_URL) headers.Click = env.PAGE_URL;
  const res = await fetchImpl("https://ntfy.sh/" + encodeURIComponent(topic), { method: "POST", headers, body });
  if (!res.ok) throw new Error("ntfy returned HTTP " + res.status);
  log("Notification sent.");
  return true;
}

function readJsonOrNull(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

// Fetches one stock at a time and pauses so a long watchlist stays inside the free per-minute limit.
function makeFetcher({ env, fetchImpl, sleep }) {
  let calls = 0;
  return async (ticker) => {
    if (calls > 0 && calls % FREE_PLAN_PER_MINUTE === 0) await sleep(61000);
    calls++;
    return fetchDaily({ ticker, env, fetchImpl });
  };
}

export async function run({ now = new Date(), env = process.env, fetchImpl = fetch, dir = "site", log = console.log, mode, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  mode = mode || env.MODE || "normal";
  const cfg = normalizeConfig(JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")));
  const dataPath = path.join(dir, "data.json");
  const skip = (reason) => { log("Nothing to do: " + reason + "."); return { changed: false, alerted: false, reason, errors: [] }; };
  // Waiting moves our own clock forward, so the logic stays correct when tests stub sleep.
  const wait = async (ms) => { await sleep(ms); now = new Date(now.getTime() + ms); };
  const fetchRows = makeFetcher({ env, fetchImpl, sleep: wait });
  const retry = env.RETRY_UNTIL_READY === "true";
  const et = etNow(now);

  if (mode === "test_push") {
    const ok = await push({ title: "Close Check - test", body: "If you can read this, alerts from Close Check will reach this phone.", env, fetchImpl, log });
    return { changed: false, alerted: ok, reason: "test", errors: [] };
  }

  if (mode === "refresh") {
    if (etWeekend(now) || et.minutes < OPEN) return skip("the market is closed and there is nothing newer than the last close");
    mode = et.minutes < CLOSE ? "live" : "normal";
    log("Refresh resolved to " + mode + " mode.");
  }

  const data = normalizeData(readJsonOrNull(dataPath));
  const errors = [];

  if (mode === "check_data") {
    for (const w of cfg.watchlist) {
      const rows = await fetchRows(w.ticker);
      if (rows.length < 23) throw new Error("Only " + rows.length + " sessions came back for " + w.ticker + ". Check the ticker in config.json.");
      const last = rows[rows.length - 1], r = buildReading(rows, w.ticker);
      const c = effectiveCfg(w, null) || { ...autoLevels(rows.slice(-60), r.close, w.risk) };
      log(w.ticker + ": " + rows.length + " sessions, newest " + last.date + ", close " + fmtPrice(last.close) + ", volume " + last.volume + ".");
      log("20-day average volume " + r.avgVolume20 + ", 50-day average " + r.ma50 + ", 200-day average " + r.ma200 + ".");
      log("Verdict on these numbers: " + evaluate(r, c).head + ".");
    }
    log("The data key works.");
    return { changed: false, alerted: false, reason: "check", errors };
  }

  if (mode === "live" || mode === "morning") {
    if (etWeekend(now) || et.minutes < OPEN || et.minutes >= CLOSE) return skip("the market is not open");
    if (mode === "morning" && et.minutes > MORNING_LATEST) return skip("it is too late for a morning update");
    if (mode === "morning" && data.notified.morning === et.date) return skip("today's morning update is already sent");
    const targets = cfg.watchlist.filter((w) => data.stocks[w.ticker]);
    if (!targets.length) return skip("there is no recorded reading yet");
    const items = [];
    let changed = false;
    for (const w of targets) {
      try {
        const rows = await fetchRows(w.ticker);
        if (rows.length < 23) throw new Error("only " + rows.length + " sessions came back");
        const last = rows[rows.length - 1];
        if (last.date !== et.date) { log(w.ticker + ": no session for today has been posted (holiday?)."); continue; }
        const live = { date: last.date, price: last.close, volume: last.volume, prevClose: rows[rows.length - 2].close, fetchedAt: now.toISOString() };
        data.stocks[w.ticker].live = live;
        log(w.ticker + " live " + fmtPrice(live.price) + " vs previous close " + fmtPrice(live.prevClose) + ".");
        changed = true;
        const c = effectiveCfg(w, data.stocks[w.ticker]);
        if (c) items.push({ ticker: w.ticker, live, status: morningStatus(live, c) });
      } catch (e) { errors.push(w.ticker + ": " + e.message); log(w.ticker + " failed: " + e.message); }
    }
    if (!changed) return { changed: false, alerted: false, reason: "no live data", errors };
    // Notify first (morning only): if the push fails nothing is saved and the next slot tries again.
    let alerted = false;
    if (mode === "morning") {
      const msg = summarizeMorning(items, cfg.digest);
      if (msg) alerted = await push({ ...msg, env, fetchImpl, log });
      data.notified.morning = et.date;
    }
    data.updatedAt = now.toISOString();
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 1) + "\n");
    log(mode === "morning" ? "Morning snapshot saved." : "Snapshot saved, no alert.");
    return { changed: true, alerted, reason: "live", errors };
  }

  // normal: the after-close check
  if (et.minutes < RECORD_AT) return skip("the market has not closed yet");
  let pending = cfg.watchlist.filter((w) => !(data.stocks[w.ticker] && data.stocks[w.ticker].asOf === et.date));
  if (!pending.length) return skip("today is already recorded");

  const items = [], fresh = {};
  let waiting = 0;
  // A scheduled run keeps checking for a few minutes, because the closing numbers can take a moment to appear.
  const tries = retry ? 8 : 1;
  for (let attempt = 0; attempt < tries && pending.length; attempt++) {
    if (attempt > 0) await wait(60000);
    const still = [];
    for (const w of pending) {
      try {
        const rows = await fetchRows(w.ticker);
        if (rows.length < 23) throw new Error("only " + rows.length + " sessions came back, check the ticker");
        const last = rows[rows.length - 1];
        if (last.date !== etNow(now).date) { still.push(w); log(w.ticker + ": no session for today has been posted yet."); continue; }
        const next = buildReading(rows, w.ticker);
        const prev = buildReading(rows.slice(0, -1), w.ticker);
        const history = rows.slice(-60);
        const old = data.stocks[w.ticker];
        let c = effectiveCfg(w, old), picked = false, auto;
        if (!c) { auto = { ...autoLevels(history, next.close, w.risk), date: last.date }; c = effectiveCfg(w, { auto }); picked = true; }
        else if (c.auto) auto = old.auto;
        // Levels that were just picked from today's close say nothing yet, so no alert on the first reading.
        const decision = picked ? { alert: false, state: evaluate(next, c).state, body: "" } : alertFor(prev, next, c);
        log(w.ticker + " closed " + fmtPrice(next.close) + " (" + decision.state + "). " + (decision.alert ? "Alerting." : "No alert needed."));
        items.push({ ticker: w.ticker, next, cfg: c, decision });
        fresh[w.ticker] = { ...next, checkedAt: now.toISOString(), history, ...(auto ? { auto } : {}) };
      } catch (e) { errors.push(w.ticker + ": " + e.message); log(w.ticker + " failed: " + e.message); }
    }
    pending = still;
  }
  waiting = pending.length;
  if (!items.length) {
    if (errors.length) return { changed: false, alerted: false, reason: "every fetch failed", errors };
    return skip("no session for today has been posted yet");
  }

  // Notify first: if the push fails, nothing is saved and the next scheduled slot tries again.
  let alerted = false;
  const msg = summarize(items, cfg.digest);
  if (msg) alerted = await push({ ...msg, env, fetchImpl, log });

  const keep = {};
  for (const w of cfg.watchlist) { const s = fresh[w.ticker] || data.stocks[w.ticker]; if (s) keep[w.ticker] = s; }
  fs.writeFileSync(dataPath, JSON.stringify({ version: 2, updatedAt: now.toISOString(), stocks: keep, notified: data.notified }, null, 1) + "\n");
  return { changed: true, alerted, reason: "recorded", items, errors, waiting };
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, name + "=" + value + "\n");
}

async function main() {
  try {
    const res = await run({ mode: process.env.MODE });
    setOutput("changed", String(res.changed));
    if (res.errors && res.errors.length) { console.error("Some stocks failed:\n" + res.errors.join("\n")); process.exitCode = 1; }
  } catch (e) {
    console.error("Close Check failed: " + e.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
