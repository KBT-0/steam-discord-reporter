# Steam Discord Reporter

Steam Discord Reporter is a Cloudflare Worker that turns Steamworks reporting data into safe Discord updates.

It reports activity counts and totals only. It never posts revenue, prices, taxes, currencies, payouts, or other money-related fields.

## Features

- Steam wishlist adds, deletes, purchases, gifts, and current wishlist balance
- Steam units sold, refunds, and key activations
- Total owners (lifetime downloads), derived from sales and key activations
- Current and all-time peak concurrent player counts
- Lifetime count totals with KV-backed snapshots
- Per-country breakdowns for wishlists, sales, and owners
- Hourly reports that fire only when activity changes
- Separate end-of-day digest summarizing the finalized Steam day
- Discord webhook reports
- Cloudflare Cron schedule with local timezone support
- One-command interactive setup
- Windows/PowerShell-friendly Wrangler flow

## Architecture

```txt
Cloudflare Cron -> Worker -> Steamworks Financial API -> KV snapshots -> Discord
```

Cloudflare Cron runs in UTC, so the Worker wakes every 15 minutes and checks whether the configured local report time is due. The default schedule runs hourly (`REPORT_INTERVAL_HOURS = 1`) in your chosen timezone.

By default `SEND_EMPTY_REPORTS = false`, so a Discord message is sent only when there is new activity (wishlist change, a sale, a refund, or a key activation). Current player count rides along with those reports. Set `SEND_EMPTY_REPORTS = true` to post on every scheduled run.

Player counts come from the public `ISteamUserStats/GetNumberOfCurrentPlayers` endpoint, which needs no API key. The all-time peak is stored in KV and tagged with a 🏆 when a new record is set. Player count never triggers a report on its own, so hourly runs stay quiet unless real activity happens. Disable it with `ENABLE_PLAYER_COUNT_REPORTING = false`.

### Total owners

Reports include a `total owners (lifetime downloads)` line, computed as `lifetime units sold - refunds + key activations` (free/complimentary licenses are included in units). This is the number of accounts that currently own the game. Steam does not expose a public "total downloads" endpoint, so this derived count is the accurate stand-in. Per-country owner totals are tracked in KV from the moment this version is deployed and shown under `Top Owner Countries`.

### Separate app IDs (e.g. a demo)

Wishlists, downloads/owners, and live players can live on different Steam apps. A common case: wishlists are on the main (unreleased) app while downloads and players are on a separate demo app. Point each metric at the right app:

```toml
STEAM_APP_ID = "111111"               # wishlists (main app)
STEAM_SALES_APP_ID = "222222"         # units, owners, key activations (e.g. the demo)
STEAM_PLAYER_COUNT_APP_ID = "222222"  # current/peak players (e.g. the demo)
```

Both extra vars default to `STEAM_APP_ID` when unset, so single-app setups need nothing. Switching `STEAM_SALES_APP_ID` to a new app re-baselines sales for that app on the next run (historical units are counted into totals but not posted as a delta).

### Country breakdowns

Every financial metric is attributed to its country. Reports show `Top Wishlist Countries`, `Top Sales Countries`, and `Top Owner Countries` (limited by `TOP_COUNTRY_LIMIT`). Concurrent player count is the one exception: Steam's live-players endpoint returns no location data, so players are reported as a single global number.

### End-of-day digest

In addition to the hourly change reports, the Worker posts a separate daily digest (`📅 Daily Summary`) at `DAILY_DIGEST_LOCAL_HOUR` (default `00:00`) in your timezone. The digest always posts, even with no change, and reports the most recent finalized Steam (UTC) reporting day in full, with per-country wishlist and sales breakdowns. Steam wishlist data is UTC-daily, so the digest covers the last complete UTC day rather than your exact local calendar day. Disable it with `ENABLE_DAILY_DIGEST = false`.

You can preview the digest manually:

```bash
curl "https://YOUR_WORKER_URL/run?token=YOUR_MANUAL_RUN_TOKEN&mode=digest"
```

## Requirements

- Node.js 20+
- Cloudflare account with Workers and KV access
- Discord webhook URL
- Steamworks app access
- Steamworks Financial Web API key

## Quick Start

```bash
git clone https://github.com/KBT-0/steam-discord-reporter.git
cd steam-discord-reporter
npm install
npm run setup
```

The setup CLI asks for your Steam app, report schedule, Discord webhook, Steam Financial API key, Worker name, and manual run token. It creates or reuses the `STEAM_REPORTER_STATE` KV namespace, writes `wrangler.toml`, uploads secrets with `wrangler secret bulk`, and can deploy the Worker.

After deployment, setup also starts a safe totals initialization by calling the Worker with `post=false&commit=true`. This fills count totals in KV without posting to Discord. Large Steam histories are processed in small batches to stay under Cloudflare Worker subrequest limits.

The setup does not create GitHub repositories and does not ask for Steam package IDs.

## Getting Credentials

Discord webhook:

1. Open the target Discord channel.
2. Go to **Channel Settings > Integrations > Webhooks**.
3. Create a webhook.
4. Copy the raw webhook URL.

Steam Financial API key:

1. Open the Steamworks Partner site.
2. Go to **Users & Permissions > Manage Groups**.
3. Turkish UI: **Kullanıcılar ve İzinler > Grupları Yönet**.
4. Create or open a **Financial API Group**.
5. Copy the **Financial Web API key** from that group page.

This is not the normal Steam Web API key and is not created from Manage Users. If Financial API Group is not visible, your account probably lacks owner/admin/financial permissions.

Required Steamworks endpoints:

- `IPartnerFinancialsService/GetAppWishlistReporting`
- `IPartnerFinancialsService/GetChangedDatesForPartner`
- `IPartnerFinancialsService/GetDetailedSales`

## Manual Test

After deployment:

```bash
curl "https://YOUR_WORKER_URL/health"
curl "https://YOUR_WORKER_URL/run?token=YOUR_MANUAL_RUN_TOKEN&post=false"
curl "https://YOUR_WORKER_URL/run?token=YOUR_MANUAL_RUN_TOKEN&post=false&commit=true"
curl "https://YOUR_WORKER_URL/run?token=YOUR_MANUAL_RUN_TOKEN"
```

`post=false` is a true dry run: it fetches and processes data, returns JSON, does not post to Discord, and does not change KV state.

`post=false&commit=true` updates KV snapshots/totals without posting to Discord. Setup uses this after deploy to initialize all-time totals safely.

Wishlist all-time totals are built from Steam's daily wishlist reports and cached in KV. For older apps, the first backfill may take multiple committed initialization calls and appear as `Known Totals` until complete. Setup starts this automatically after deploy when it can detect the Worker URL; future scheduled report runs continue from cached KV state.

## Upgrading an existing deployment

If you already deployed an earlier version, update without losing KV history. Your existing snapshots and lifetime totals stay intact; the new per-country owner breakdown simply starts accumulating from the next run.

This version adds these `wrangler.toml` vars:

```toml
ENABLE_PLAYER_COUNT_REPORTING = "true"
ENABLE_DAILY_DIGEST = "true"
DAILY_DIGEST_LOCAL_HOUR = "0"
```

It also changes two defaults: hourly reports (`REPORT_INTERVAL_HOURS = "1"`) and posting only on change (`SEND_EMPTY_REPORTS = "false"`).

### Option A — re-run setup (recommended)

```bash
git pull
npm install
npm run setup
```

Setup reloads your saved non-secret answers from `.setup-state.tmp.json`, asks the new questions, rewrites `wrangler.toml`, and redeploys. It reuses the same KV namespace and secrets, so nothing is re-initialized.

### Option B — edit wrangler.toml manually

```bash
git pull
npm install
```

Then in your existing `wrangler.toml`, add the three vars above to the `[vars]` block, set `REPORT_INTERVAL_HOURS = "1"` and `SEND_EMPTY_REPORTS = "false"`, and redeploy:

```bash
npx wrangler deploy
```

No totals re-initialization is needed. The Cron trigger (`crons = ["*/15 * * * *"]`) is unchanged; only the in-Worker schedule logic changed.

## Troubleshooting

To check Wrangler login without changing KV, secrets, or deployment:

```bash
npm run setup -- --check-wrangler
```

If PowerShell blocks `npm.ps1`, use `npm.cmd run setup` or adjust your local execution policy. If Wrangler says `workerd` was installed for another platform, delete `node_modules` and run `npm install` again from the same shell you will use for setup. If Wrangler is not logged in, run `npx wrangler login`, then retry setup.

## Security

- Never commit real Discord webhook URLs, Steam Financial API keys, or manual run tokens.
- `wrangler.toml`, `.setup-state.tmp.json`, `.dev.vars`, and temporary secret files are gitignored.
- Rotate any webhook/key/token that was exposed in logs, screenshots, commits, or chat.

## Development

```bash
npm install
npm run typecheck
npm run build
npm test
```

## License

MIT
