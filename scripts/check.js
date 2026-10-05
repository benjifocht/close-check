// The after-close check. Runs in GitHub Actions; also importable for tests.
//
// MODE=normal      record the day's close if it is new, notify when something needs a look
// MODE=check_data  fetch and print the latest rows only (use this to test your data key)
// MODE=test_push   send a test notification only
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { alertFor, buildReading, evaluate, fmtPrice, validateConfig } from "../site/logic.js";
import { fetchDaily } from "./providers.js";

export function etNow(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const g = (t) => parts.find((p) => p.type === t).value;
  return { date: g("year") + "-" + g("month") + "-" + g("day"), minutes: parseInt(g("hour"), 10) * 60 + parseInt(g("minute"), 10) };
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

export async function run({ now = new Date(), env = process.env, fetchImpl = fetch, dir = "site", log = console.log, mode } = {}) {
  mode = mode || env.MODE || "normal";
  const cfg = validateConfig(JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")));
  const dataPath = path.join(dir, "data.json");
  const skip = (reason) => { log("Nothing to do: " + reason + "."); return { changed: false, alerted: false, reason }; };

  if (mode === "test_push") {
    const ok = await push({ title: "Close Check - test", body: "If you can read this, alerts from Close Check will reach this phone.", env, fetchImpl, log });
    return { changed: false, alerted: ok, reason: "test" };
  }

  const rows = await fetchDaily({ ticker: cfg.ticker, env, fetchImpl });
  if (rows.length < 23) throw new Error("Only " + rows.length + " sessions came back for " + cfg.ticker + ". Check the ticker in config.json.");
  const last = rows[rows.length - 1];

  if (mode === "check_data") {
    const r = buildReading(rows, cfg.ticker);
    log(cfg.ticker + ": " + rows.length + " sessions, newest " + last.date + ", close " + fmtPrice(last.close) + ", volume " + last.volume + ".");
    log("20-day average volume " + r.avgVolume20 + ", 50-day average " + r.ma50 + ", 200-day average " + r.ma200 + ".");
    log("Verdict on these numbers: " + evaluate(r, cfg).head + ". The data key works.");
    return { changed: false, alerted: false, reason: "check" };
  }

  const et = etNow(now);
  if (et.minutes < 16 * 60 + 5) return skip("the market has not closed yet");
  if (last.date !== et.date) return skip("no session for today has been posted yet");
  const prevData = readJsonOrNull(dataPath);
  if (prevData && prevData.ticker === cfg.ticker && prevData.asOf === last.date) return skip("today is already recorded");

  const next = buildReading(rows, cfg.ticker);
  const prev = rows.length >= 23 ? buildReading(rows.slice(0, -1), cfg.ticker) : null;
  const decision = alertFor(prev, next, cfg);
  log(cfg.ticker + " closed " + fmtPrice(next.close) + " (" + decision.state + "). " + (decision.alert ? "Alerting." : "No alert needed."));

  // Notify first: if the push fails, nothing is saved and the next scheduled slot tries again.
  let alerted = false;
  if (decision.alert) alerted = await push({ title: decision.title, body: decision.body, env, fetchImpl, log });

  const data = { ...next, checkedAt: now.toISOString(), history: rows.slice(-60) };
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 1) + "\n");
  return { changed: true, alerted, reason: "recorded", decision };
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, name + "=" + value + "\n");
}

async function main() {
  try {
    const res = await run({ mode: process.env.MODE });
    setOutput("changed", String(res.changed));
  } catch (e) {
    console.error("Close Check failed: " + e.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
