# Steam Discord Reporter

Steam Discord Reporter is a Cloudflare Worker that turns Steamworks reporting data into safe Discord updates.

It reports activity counts and totals only. It never posts revenue, prices, taxes, currencies, payouts, or other money-related fields.

## Features

- Steam wishlist adds, deletes, purchases, gifts, and current wishlist balance
- Steam units sold, refunds, and key activations
- Lifetime count totals with KV-backed snapshots
- Top country summaries
- Discord webhook reports
- Cloudflare Cron schedule with local timezone support
- One-command interactive setup
- Windows/PowerShell-friendly Wrangler flow

## Architecture

```txt
Cloudflare Cron -> Worker -> Steamworks Financial API -> KV snapshots -> Discord
```

Cloudflare Cron runs in UTC, so the Worker wakes every 15 minutes and checks whether the configured local report time is due. The default schedule is `00:00` and `12:00` in your chosen timezone.

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
curl "https://YOUR_WORKER_URL/run?token=YOUR_MANUAL_RUN_TOKEN"
```

`post=false` fetches and processes data without posting to Discord.

Wishlist all-time totals are built from Steam's daily wishlist reports and cached in KV. For older apps, the first backfill may complete over multiple runs and appear as `Known Totals` until complete.

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
