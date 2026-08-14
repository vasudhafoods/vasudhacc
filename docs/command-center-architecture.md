# Vasudha Command Center architecture audit

## Current application

This repository is a Next.js 16.2 App Router application. Protected pages are React Server Components guarded by a signed, HTTP-only dashboard cookie. Shopify and Vercel Blob access remain server-only.

The current Shopify read path is:

1. `lib/shopify/access-token.ts` obtains a short-lived Admin API token with Shopify client credentials and caches it in process memory.
2. `lib/shopify/client.ts` sends Admin GraphQL requests, retries transient failures, refreshes on 401, and handles throttling and GraphQL user errors.
3. `services/shopify-inventory.ts` pages through variants and inventory levels.
4. `services/shopify-sales.ts` pages through the most recent order window.
5. Pages read these services directly. Daily inventory snapshots, run records, and settings are private JSON documents in Vercel Blob.

There are no Shopify webhooks or inventory write mutations in this repository. There is also no relational database, transaction ledger, role model, warehouse balance, recipient register, approval workflow, or idempotency store.

## Existing product identity

Each inventory row already retains Shopify product, variant, inventory-item, inventory-level, and location GIDs. SKU is selected from the inventory item first and falls back to the variant SKU. Missing SKUs are counted in diagnostics, but there is no internal product/SKU mapping table and no uniqueness enforcement.

SKU should remain the business key. Shopify GIDs are integration identifiers, not replacements for SKU.

## Source-of-truth boundaries

| Concern | Source of truth |
| --- | --- |
| Online orders and Shopify inventory | Shopify, accessed through the existing Shopify adapter |
| Physical warehouse stock | Command Center warehouse ledger |
| Online, retail, and buffer allocation | Command Center channel balances derived from the ledger |
| Retail issues and recipients | Command Center ledger |
| Integration delivery state | Transactional outbox and Shopify sync-attempt records |

The current Shopify `available` value is online stock. It must not be presented as total physical stock.

## Recommended data model

- `products`: internal ID, SKU (unique), name, pack size, active state, barcode metadata.
- `shopify_mappings`: product ID, Shopify product/variant/inventory-item/location IDs, mapping status, last verified time.
- `warehouse_locations`: Kandi, Narsingi, racks/bins, location type and active state.
- `inventory_batches`: product, batch, manufacture/expiry/best-before dates and received quantity.
- `inventory_balances`: product, warehouse location, channel bucket, batch, on-hand/reserved/available and row version.
- `inventory_transactions`: immutable header with type, reference, actor, reason, idempotency key and timestamp.
- `inventory_transaction_lines`: signed quantity, bucket/location/batch, opening and closing balance.
- `retail_recipients`: recipient type and destination/contact metadata.
- `stock_requests` and `stock_request_lines`: request and approval lifecycle.
- `replenishment_requests`: recommendation inputs, quantity and approval state.
- `incoming_shipments` and `incoming_shipment_lines`: Kandi dispatch through Narsingi QC.
- `shopify_events`: webhook ID/topic/payload hash/processed state with a unique event ID.
- `integration_outbox` and `shopify_sync_attempts`: retryable Command Center-to-Shopify operations.
- `alerts`, `decisions`, and `audit_events`: detection, recommendation, approval and configuration history.

Balance-changing commands must execute the ledger entry and balance update in one database transaction with row locking or optimistic version checks. Unique idempotency keys must protect webhook events and user retries. Shopify calls should occur after commit through an outbox worker, never inside the warehouse balance transaction.

## APIs/services to add

- SKU mapping import/review and validation.
- Inventory balance and product drill-down queries.
- Receive-and-allocate command.
- Retail issue, return, damage, adjustment and transfer commands.
- Stock request and replenishment approval commands.
- Shopify webhook ingestion with deduplication.
- Shopify inventory update adapter that reuses the existing authenticated client.
- Outbox worker, retry policy, sync health and reconciliation services.
- Role-aware authorization and audit logging.

## Implementation order

1. Live read-only Command Center using the current Shopify adapter.
2. Select and connect a transactional PostgreSQL database; apply the core product, mapping, balance, ledger, idempotency and audit schema.
3. Import Shopify identities and resolve missing/duplicate SKUs.
4. Add receiving/allocation and retail issue workflows.
5. Add transfers and manager approvals with protected online/reserved stock.
6. Add outbox-based Shopify write-back through the existing adapter.
7. Add webhook ingestion, reconciliation, sync status, replenishment and role-specific workspaces.

## Risks and open integration decisions

- Vercel Blob is suitable for snapshots but not concurrent inventory accounting.
- The brief refers to a separate working Shopify Stock App, but this repository currently communicates with Shopify directly. Its API/contract must be supplied if it is a different service.
- Current inventory queries expose `available` only; committed/reserved inventory must be added and verified against the installed app scopes and selected Shopify API version before online stock can be moved safely.
- Current authentication represents one configured dashboard user. Operational workflows require durable users and roles.
- Shopify order polling is not an idempotent event stream. Webhook delivery IDs or another durable cursor are required before order events can write to the ledger.
