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
# Optional; Vercel's production URL is detected automatically.
APP_BASE_URL=https://commandcenter.vasudhafoods.com

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
read_products,read_inventory,write_inventory,read_locations,read_orders,read_fulfillments
```

After changing scopes, release a new app version and approve the updated installation on the store. The app must remain installed for client-credentials authentication to work.

## Team authentication

Management pages require the configured internal-admin username and password. Administrators can create database-backed warehouse accounts under **Settings → Warehouse staff accounts**. Successful login creates a signed, HTTP-only, SameSite session cookie that expires after 12 hours, and the UI provides a Sign out action.

Warehouse staff are restricted to the Warehouse desk. They can receive and allocate new stock, dispatch Retail stock, create product records, review each entry before submission, and see only the updates submitted under their username. A retail dispatch accepts multiple products, shows available Retail packets, requires a destination and invoice/order reference, and presents a final line-by-line balance summary. The restriction is enforced in the page routing and again at every mutation API. Disabling an account blocks its active session on the next server request.

Stock receipts are written through the transactional inventory ledger, including immutable transaction lines and an audit event. Product creation is also audited. A product created by warehouse staff must be linked through Shopify catalogue synchronization before its first automatically allocated receipt.

Warehouse receipts use individual packets as the physical base unit. After damaged units are removed, the screen automatically allocates 40% Online, 40% Retail, and the integer remainder to Buffer. Synced Pack-of-3/Pack-of-5/Pack-of-10 Shopify variants are excluded from physical receiving so the same packet pool is not counted multiple times.

The Online allocation is sent to the mapped Shopify Pack-of-1 inventory item immediately after the Neon transaction commits. Delivery uses Shopify's idempotent inventory-adjustment mutation, so retries cannot add the same receipt twice. If Shopify is temporarily unavailable, the update stays in the Neon outbox and is retried by the daily scheduled job or the next manual **Sync Shopify now** action.

The command center also maintains signed `fulfillments/create` and `refunds/create` Shopify webhooks. A fulfillment reduces the Neon Online bucket only after Shopify marks stock as shipped. An explicit fulfilled-item return adds packets back. Cancelling an unfulfilled line does not alter the physical ledger because those packets never left the warehouse. Every webhook is HMAC-verified, store-verified, event-deduplicated, and written through the same immutable ledger. Shopify Pack-of-N quantities are converted to individual packets using the matching Pack-of-1 product (for example, two Pack-of-5 variants reduce stock by 10 packets). A product without one unambiguous base-packet mapping is rejected instead of corrupting stock.

Use a unique password of at least 12 characters and a cryptographically random `SESSION_SECRET` of at least 32 characters. Replace the admin password in Vercel when needed; rotate `SESSION_SECRET` and redeploy when every existing session must be invalidated.

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

Vercel Cron calls `GET /api/cron/inventory` at `02:30 UTC`, or `08:00 IST`, every day. The route refreshes the Shopify SKU catalogue in Neon, retries queued Shopify stock adjustments, fetches current Shopify inventory, writes the dated snapshot to Neon, and sends the configured Resend summary email to every comma-separated address in `ALERT_EMAIL_TO`.

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
- Warehouse passwords are hashed with scrypt and never stored or returned as plain text.
- Role checks prevent warehouse accounts from accessing management pages, settings, exports, planning, or management mutation APIs.
- Inventory snapshots, settings, and warehouse records remain in the server-only Neon database.
- Internal inventory and cron endpoints require constant-time bearer-token verification.

## Checks

```bash
npm run lint
npx tsc --noEmit
npm run build
```

## Deployment checklist

1. Configure all required environment variables for the Vercel Production environment. Optionally set `APP_BASE_URL` after the custom domain has a working production deployment; otherwise Vercel's production URL is used automatically.
2. Run `npm run db:migrate` against the production Neon database.
3. Deploy the application.
4. Verify the domain used by `ALERT_EMAIL_FROM` in Resend and enable **Daily email summary** under Settings (existing installations only).
5. Confirm an unauthenticated request redirects to `/login`.
6. Sign in and verify current inventory against Shopify.
7. Under Settings, create a warehouse test account and confirm it opens only the Warehouse desk.
8. Confirm the Shopify app version includes `write_inventory` and `read_fulfillments`, release that version, and approve the updated installation.
9. Click **Sync Shopify now** once. Verify that the success message confirms two Shopify order automations are connected.
10. Submit a test warehouse receipt and verify the final summary says **Synced automatically**.
11. Fulfill a test Pack-of-N order and confirm the Neon Online balance falls by the number of individual packets; return and restock that fulfilled line and confirm it rises once.
12. Confirm the next scheduled cron execution returns `200`, refreshes the catalogue, creates the dated snapshot, and records the email result in the snapshot run.
