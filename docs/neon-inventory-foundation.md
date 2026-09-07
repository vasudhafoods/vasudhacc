# Neon inventory foundation

## Environment

The application expects the Neon pooled connection string in the server-only `DATABASE_URL` variable. The Vercel Neon integration normally creates this variable for deployed environments.

For local migration work, pull the Vercel environment into an ignored `.env.local` file or copy the Neon pooled connection string there manually:

```dotenv
DATABASE_URL=postgresql://...
```

Never add the connection string to `.env.example` or prefix it with `NEXT_PUBLIC_`.

## Create and apply migrations

```bash
npm run db:generate
npm run db:migrate
```

The first migration creates the core SKU catalog, Shopify mappings, Kandi/Narsingi locations, balances, batches, immutable inventory ledger, audit events, webhook deduplication and integration outbox.

## Initial operating sequence

1. Apply migrations to a Neon development branch first.
2. Call `POST /api/operations/catalog/sync` while signed into the dashboard.
3. Resolve every missing or conflicted SKU before receiving stock.
4. Enter a verified Narsingi opening receipt with `POST /api/operations/receipts` and allocate the entire received quantity across Online, Retail, Buffer and Damaged.
5. Use `POST /api/operations/transfers` for Buffer/Retail transfers. An `Idempotency-Key` header is mandatory for every write.
6. Transfers into Online create a pending Shopify adjustment in `integration_outbox`; they do not claim success until a future outbox worker confirms Shopify.

Moving inventory out of Online remains disabled until Shopify committed/reserved quantities are synchronized. This prevents committed customer stock from being reallocated.

## Write API contracts

### Receive and allocate stock

```http
POST /api/operations/receipts
Idempotency-Key: receipt-unique-reference
Content-Type: application/json

{
  "productId": "internal-product-uuid",
  "warehouseLocationId": "narsingi-location-uuid",
  "receivedQuantity": 1000,
  "damagedQuantity": 0,
  "onlineQuantity": 400,
  "retailQuantity": 400,
  "bufferQuantity": 200,
  "batchNumber": "AJ-2026-09-001",
  "source": "Kandi Production",
  "reason": "Production receipt",
  "shopifyMappingId": "required-when-online-is-positive"
}
```

### Transfer inventory

```http
POST /api/operations/transfers
Idempotency-Key: transfer-unique-reference
Content-Type: application/json

{
  "productId": "internal-product-uuid",
  "warehouseLocationId": "narsingi-location-uuid",
  "fromBucket": "buffer",
  "toBucket": "online",
  "quantity": 150,
  "reason": "Approved online replenishment",
  "shopifyMappingId": "required-for-online-destination"
}
```

## Integrity controls

- PostgreSQL check constraints prevent negative stock and reserved stock above on-hand stock.
- Balance rows are locked during commands, and commands run at serializable isolation.
- Transaction and audit rows cannot be updated or deleted; corrections require a new transaction.
- Unique idempotency keys protect user retries.
- Shopify-affecting commands write an outbox record in the same database transaction as the ledger and balances.
- Shopify mappings in conflict cannot be used for online adjustments.
