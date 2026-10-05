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

## Changing the stock or levels

Use the page's fields and presets, tap **Copy config.json**, open the link it shows, paste, commit.

## Notes

- Everything in the repo and on the page (ticker, levels, prices) is publicly readable. Only the data key and
  ntfy topic are private.
- GitHub pauses scheduled jobs after ~60 days without repo activity; the job commits data each trading day,
  but if alerts stop, check the Actions tab.
- Run tests with `npm test` (Node 22).
