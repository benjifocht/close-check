# Close Check

A home-screen app plus a free after-close check. Each weekday at about 4:25 PM ET a GitHub job fetches the
day's close, works out the three signals (close vs your level, volume vs the 20-day average, close vs the
50-day average) and sends a phone alert through ntfy when something needs a look. A checklist, not advice.

## One-time setup (about 20 minutes)

1. **Data key.** Make a free account at twelvedata.com and copy your API key.
2. **Phone alerts.** Install the free **ntfy** app from the App Store. Tap +, subscribe to a long random
   topic name (like `closecheck-` plus 12 random letters). Allow notifications.
3. **GitHub repo.** Make a free GitHub account, create a new **public** repository named `close-check`
   (Pages needs public on the free plan), and upload everything in this folder, including `.github`.
   The default branch must be `main`.
4. **Secrets.** Repo > Settings > Secrets and variables > Actions > New repository secret:
   - `TWELVE_DATA_API_KEY` = your key
   - `NTFY_TOPIC` = your topic name (keep it secret; do not put it in any file)
5. **Pages.** Settings > Pages > Source: **GitHub Actions**.
6. **Test.** Actions tab > Close Check > Run workflow, mode `check_data` (checks the key), then `test_push`
   (a test alert should reach your phone).
7. **Install.** Open `https://YOURNAME.github.io/close-check/` in Safari > Share > Add to Home Screen.

## Watchlist

- Add up to 12 stocks in the page's Watchlist section. A new stock gets starting levels from the risk preset you pick
  (Cautious, Balanced or Aggressive) after its first after-close check. Change any number and Save to set your own.
- Two notifications a day, each covering the whole list: a morning update at 10:00 AM ET (live prices) and the close
  check at about 4:02 PM ET. With the summary on, each lists every stock; with it off, each is sent only when
  something needs a look.
- Why 4:02 and not 4:00: the closing price and volume need a minute or two to be published. The checker keeps trying
  for up to eight minutes if they are not there yet.
- Timing: GitHub's scheduler often starts runs 10 to 30 minutes late, so each run starts 30 minutes early and waits
  for the exact minute. Backup runs after the close catch a dropped one.
- The free Twelve Data plan allows 8 requests a minute and 800 credits a day. Each stock costs 1 credit per check, so
  12 stocks use about 12 to 25 credits a day, and the checker pauses between groups of 8.

## Changing the stock or levels

Use the page's fields and presets, then tap **Save**.

- **One-tap save (optional):** open "Save in one tap" on the page and paste a GitHub fine-grained token limited to this
  repo with Contents and Actions both set to Read and write (set an expiry). The token lives only in that device's browser. Save then commits
  config.json for you. Without a token, Save copies the settings and links to GitHub's editor to paste them.
- iPhone note: the home-screen app and Safari keep separate storage, so paste the token in the one you use.

## Live price and refresh

- The 10 AM update saves a "Today so far" snapshot and adds a provisional verdict: the same three checks on the live price, with volume so far projected to a full day. It costs 1 data credit per stock and never changes the official close verdict.
  The verdict always uses the last full close.
- **Refresh** reloads everything straight from the repository. With a token that has Actions access, it also starts a
  check (live prices during market hours, the close after 4:05 PM ET), waits for it, and shows the result. That costs
  1 data credit per stock. Without a token it only reloads what is saved.
- Changing the risk level or any number previews instantly on the page. Alerts only use the saved config.json.

## Notes

- Everything in the repo and on the page (ticker, levels, prices) is publicly readable. Only the data key and
  ntfy topic are private.
- GitHub pauses scheduled jobs after ~60 days without repo activity; the job commits data each trading day,
  but if alerts stop, check the Actions tab.
- Run tests with `npm test` (Node 22).
