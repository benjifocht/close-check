// Market-data providers. Every parser returns rows oldest first: [{date, close, volume}].

class DataError extends Error {}

function toRows(list) {
  const byDate = new Map();
  for (const r of list) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) continue;
    if (!Number.isFinite(r.close) || !Number.isFinite(r.volume) || r.close <= 0 || r.volume < 0) continue;
    byDate.set(r.date, { date: r.date, close: r.close, volume: r.volume });
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

export function parseTwelveData(j) {
  if (!j || typeof j !== "object") throw new DataError("Twelve Data returned an unreadable response");
  if (j.status === "error" || j.code >= 400) throw new DataError("Twelve Data error: " + (j.message || "unknown"));
  if (!Array.isArray(j.values)) throw new DataError("Twelve Data response had no price rows");
  return toRows(j.values.map((v) => ({ date: String(v.datetime).slice(0, 10), close: parseFloat(v.close), volume: parseInt(v.volume, 10) })));
}

export function parseAlphaVantage(j) {
  if (!j || typeof j !== "object") throw new DataError("Alpha Vantage returned an unreadable response");
  const series = j["Time Series (Daily)"];
  if (!series) throw new DataError("Alpha Vantage error: " + (j.Note || j.Information || j["Error Message"] || "no price rows"));
  return toRows(Object.entries(series).map(([date, v]) => ({ date, close: parseFloat(v["4. close"]), volume: parseInt(v["5. volume"], 10) })));
}

export async function fetchDaily({ ticker, env, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let url, parse, key;
  if (env.TWELVE_DATA_API_KEY) {
    key = env.TWELVE_DATA_API_KEY.trim();
    url = "https://api.twelvedata.com/time_series?symbol=" + encodeURIComponent(ticker) + "&interval=1day&outputsize=260&apikey=" + encodeURIComponent(key);
    parse = parseTwelveData;
  } else if (env.ALPHAVANTAGE_API_KEY) {
    key = env.ALPHAVANTAGE_API_KEY.trim();
    url = "https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&outputsize=compact&symbol=" + encodeURIComponent(ticker) + "&apikey=" + encodeURIComponent(key);
    parse = parseAlphaVantage;
  } else {
    throw new DataError("No data key found. Add TWELVE_DATA_API_KEY as a repository secret.");
  }
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
      if (res.status >= 500) throw new Error("the data service returned HTTP " + res.status);
      return parse(await res.json());
    } catch (e) {
      lastErr = e;
      if (e instanceof DataError) break; // the provider answered; retrying will not change it
      if (attempt === 0) await sleep(3000);
    }
  }
  throw new Error(String(lastErr && lastErr.message).split(key).join("***"));
}
