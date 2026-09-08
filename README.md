# Vasudha Commerce Command Center

Internal Shopify inventory intelligence for Vasudha Foods. The dashboard reads current inventory from Shopify, stores daily snapshots and warehouse records in Neon PostgreSQL, and compares live stock with the two prior calendar days.

## Stack

- Next.js 16 App Router, React 19, strict TypeScript, and Tailwind CSS 4
- Shopify Admin GraphQL API `2026-07`
- Recharts
- Neon PostgreSQL with Drizzle ORM
- Vercel deployment and Vercel Cron

## Local setup

```bash
npm ci
npm run dev
```

Copy `.env.example` to `.env.local` and configure every required value:

```dotenv
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
SHOPIFY_CLIENT_ID=your-dev-dashboard-client-id
SHOPIFY_CLIENT_SECRET=your-dev-dashboard-client-secret
SHOPIFY_API_VERSION=2026-07

DASHBOARD_USERNAME=vasudha-admin
DASHBOARD_PASSWORD=a-strong-password-with-at-least-12-characters
SESSION_SECRET=at-least-32-random-characters-used-to-sign-sessions

DATABASE_URL=postgresql://user:password@host/database?sslmode=require
CRON_SECRET=a-long-random-secret

RESEND_API_KEY=re_your-resend-api-key
ALERT_EMAIL_FROM=Vasudha Command Center <alerts@your-verified-domain.com>
ALERT_EMAIL_TO=prabhu@example.com
```

Never commit `.env.local`, expose these values through `NEXT_PUBLIC_` variables, or share them in screenshots.

## Shopify app

The installed Shopify Dev Dashboard app requires these Admin API scopes:

```text
read_products,read_inventory,read_locations,read_orders
```

After changing scopes, release a new app version and approve the updated installation on the store. The app must remain installed for client-credentials authentication to work.

## Dashboard authentication

All dashboard and inventory pages require the configured internal-admin username and password. Successful login creates a signed, HTTP-only, SameSite session cookie that expires after 12 hours. The inventory export route verifies the session independently, and the UI provides a Sign out action.

Use a unique password of at least 12 characters and a cryptographically random `SESSION_SECRET` of at least 32 characters. Change either value in Vercel and redeploy to invalidate or replace access.

## Inventory behavior

- **Today** is fetched live from Shopify whenever the dashboard or inventory page is loaded.
- **Yesterday** uses the snapshot for the exact prior calendar date.
- **Day before** uses the snapshot for the exact date two days earlier.
- Missing snapshots display as unavailable instead of copying current inventory.
- If Shopify is temporarily unavailable, the UI can fall back to the latest saved snapshots.
- CSV, Excel, and JSON exports reflect the authenticated user's current filtered view.
- Inventory can be filtered by Shopify lifecycle status and tracking state, and displays Shopify product images.

## Operations and alerts

- Dashboard and inventory pages provide manual refresh, manual snapshot creation, missing-snapshot warnings, the last successful snapshot time, and recent cron/manual execution history.
- Settings are stored in Neon and include default/per-product low-stock thresholds, lead time, safety stock, dead-stock window, and default hiding of untracked variants.
- Stock planning estimates daily depletion, days until stockout, reorder quantities, inventory/no-movement age, and dead stock from up to 60 daily snapshots. These are planning estimates, not accounting forecasts.
- A successful scheduled snapshot sends a daily email through Resend when its credentials are configured and the email channel is enabled in Settings. New installations enable email by default; existing installations should confirm the toggle in Settings. Manual snapshots do not send duplicate alerts.
- The Sales workspace reports 30-day orders, revenue, AOV, refunds, cancellations, best/slow products, sales-versus-stock, and a simple run-rate forecast. It requires `read_orders`; standard Shopify order access covers the most recent 60 days.

## Daily snapshots

Vercel Cron calls `GET /api/cron/inventory` at `02:30 UTC`, or `08:00 IST`, every day. The route fetches current Shopify inventory, writes the dated snapshot to Neon, and sends the configured Resend summary email to every comma-separated address in `ALERT_EMAIL_TO`.

Vercel Hobby runs daily cron jobs with hourly rather than minute-level precision, so the free plan delivers this around 8:00 AM IST. Exact-minute scheduling requires Vercel Pro or an external scheduler.

Running the cron more than once on the same day safely replaces that day's snapshot. When `CRON_SECRET` is configured in Vercel, scheduled requests include it as a bearer token.

Each attempt also writes a run record to Neon. Dashboard settings are stored in the same database.

Protected diagnostic endpoints:

```text
GET /api/inventory
GET /api/inventory/history
GET /api/cron/inventory
```

Each requires `Authorization: Bearer <CRON_SECRET>`.

## Security

- Shopify credentials, access tokens, dashboard credentials, and database credentials are server-only.
- Shopify access tokens are short-lived, cached only in server memory, and refreshed automatically.
- Dashboard sessions are signed and stored in Secure/HTTP-only cookies in production.
- Page requests receive an optimistic authentication check, while pages and exports also verify the session close to the data access.
- Inventory snapshots, settings, and warehouse records remain in the server-only Neon database.
- Internal inventory and cron endpoints require constant-time bearer-token verification.

## Checks

```bash
npm run lint
npx tsc --noEmit
npm run build
```

## Deployment checklist

1. Configure all environment variables for the Vercel Production environment.
2. Run `npm run db:migrate` against the production Neon database.
3. Deploy the application.
4. Verify the domain used by `ALERT_EMAIL_FROM` in Resend and enable **Daily email summary** under Settings (existing installations only).
5. Confirm an unauthenticated request redirects to `/login`.
6. Sign in and verify current inventory against Shopify.
7. Confirm the next scheduled cron execution returns `200`, creates the dated snapshot, and records the email result in the snapshot run.
