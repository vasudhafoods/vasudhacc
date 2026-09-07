import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const auditColumns = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const inventoryBucket = pgEnum("inventory_bucket", ["online", "retail", "buffer", "qc", "damaged"]);
export const inventoryTransactionType = pgEnum("inventory_transaction_type", [
  "opening_balance",
  "stock_received",
  "shopify_sale",
  "retail_issue",
  "channel_transfer",
  "return",
  "damage",
  "manual_adjustment",
  "cycle_count_adjustment",
  "kandi_dispatch",
  "narsingi_receipt",
  "shopify_reconciliation",
]);
export const mappingStatus = pgEnum("mapping_status", ["mapped", "missing_sku", "conflict", "inactive"]);
export const integrationStatus = pgEnum("integration_status", ["pending", "processing", "succeeded", "failed", "cancelled"]);
export const staffRole = pgEnum("staff_role", ["admin", "management", "warehouse_manager", "warehouse_staff", "retail_sales"]);
export const recipientType = pgEnum("recipient_type", ["salesperson", "retail_store", "distributor", "event", "sampling", "institutional_customer", "other"]);

export const staffUsers = pgTable("staff_users", {
  id: uuid("id").defaultRandom().primaryKey(),
  username: text("username").notNull(),
  displayName: text("display_name").notNull(),
  role: staffRole("role").notNull(),
  active: boolean("active").default(true).notNull(),
  ...auditColumns,
}, (table) => [uniqueIndex("staff_users_username_unique").on(table.username)]);

export const products = pgTable("products", {
  id: uuid("id").defaultRandom().primaryKey(),
  sku: text("sku").notNull(),
  name: text("name").notNull(),
  packSize: text("pack_size"),
  barcode: text("barcode"),
  active: boolean("active").default(true).notNull(),
  ...auditColumns,
}, (table) => [
  uniqueIndex("products_sku_unique").on(table.sku),
  uniqueIndex("products_barcode_unique").on(table.barcode).where(sql`${table.barcode} is not null`),
]);

export const warehouseLocations = pgTable("warehouse_locations", {
  id: uuid("id").defaultRandom().primaryKey(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  locationType: text("location_type").notNull(),
  active: boolean("active").default(true).notNull(),
  ...auditColumns,
}, (table) => [uniqueIndex("warehouse_locations_code_unique").on(table.code)]);

export const shopifyMappings = pgTable("shopify_mappings", {
  id: uuid("id").defaultRandom().primaryKey(),
  productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
  shopifyProductId: text("shopify_product_id").notNull(),
  shopifyVariantId: text("shopify_variant_id").notNull(),
  shopifyInventoryItemId: text("shopify_inventory_item_id").notNull(),
  shopifyInventoryLevelId: text("shopify_inventory_level_id").notNull(),
  shopifyLocationId: text("shopify_location_id").notNull(),
  shopifyLocationName: text("shopify_location_name").notNull(),
  status: mappingStatus("status").default("mapped").notNull(),
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }).notNull(),
  ...auditColumns,
}, (table) => [
  uniqueIndex("shopify_mappings_item_location_unique").on(table.shopifyInventoryItemId, table.shopifyLocationId),
  index("shopify_mappings_product_idx").on(table.productId),
]);

export const inventoryBatches = pgTable("inventory_batches", {
  id: uuid("id").defaultRandom().primaryKey(),
  productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
  warehouseLocationId: uuid("warehouse_location_id").notNull().references(() => warehouseLocations.id, { onDelete: "restrict" }),
  batchNumber: text("batch_number").notNull(),
  manufacturingDate: timestamp("manufacturing_date", { withTimezone: true }),
  expiryDate: timestamp("expiry_date", { withTimezone: true }),
  bestBeforeDate: timestamp("best_before_date", { withTimezone: true }),
  receivedQuantity: integer("received_quantity").notNull(),
  ...auditColumns,
}, (table) => [
  uniqueIndex("inventory_batches_identity_unique").on(table.productId, table.warehouseLocationId, table.batchNumber),
  check("inventory_batches_received_nonnegative", sql`${table.receivedQuantity} >= 0`),
]);

export const inventoryBalances = pgTable("inventory_balances", {
  id: uuid("id").defaultRandom().primaryKey(),
  productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
  warehouseLocationId: uuid("warehouse_location_id").notNull().references(() => warehouseLocations.id, { onDelete: "restrict" }),
  bucket: inventoryBucket("bucket").notNull(),
  onHand: integer("on_hand").default(0).notNull(),
  reserved: integer("reserved").default(0).notNull(),
  version: integer("version").default(1).notNull(),
  ...auditColumns,
}, (table) => [
  uniqueIndex("inventory_balances_scope_unique").on(table.productId, table.warehouseLocationId, table.bucket),
  index("inventory_balances_bucket_idx").on(table.bucket),
  check("inventory_balances_on_hand_nonnegative", sql`${table.onHand} >= 0`),
  check("inventory_balances_reserved_nonnegative", sql`${table.reserved} >= 0`),
  check("inventory_balances_reserved_within_on_hand", sql`${table.reserved} <= ${table.onHand}`),
  check("inventory_balances_version_positive", sql`${table.version} > 0`),
]);

export const inventoryTransactions = pgTable("inventory_transactions", {
  id: uuid("id").defaultRandom().primaryKey(),
  transactionNumber: text("transaction_number").notNull(),
  type: inventoryTransactionType("type").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  referenceId: text("reference_id"),
  shopifyOrderId: text("shopify_order_id"),
  stockRequestId: uuid("stock_request_id"),
  actorUsername: text("actor_username").notNull(),
  reason: text("reason").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("inventory_transactions_number_unique").on(table.transactionNumber),
  uniqueIndex("inventory_transactions_idempotency_unique").on(table.idempotencyKey),
  index("inventory_transactions_occurred_idx").on(table.occurredAt),
  index("inventory_transactions_shopify_order_idx").on(table.shopifyOrderId),
]);

export const inventoryTransactionLines = pgTable("inventory_transaction_lines", {
  id: uuid("id").defaultRandom().primaryKey(),
  transactionId: uuid("transaction_id").notNull().references(() => inventoryTransactions.id, { onDelete: "restrict" }),
  productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
  warehouseLocationId: uuid("warehouse_location_id").notNull().references(() => warehouseLocations.id, { onDelete: "restrict" }),
  batchId: uuid("batch_id").references(() => inventoryBatches.id, { onDelete: "restrict" }),
  bucket: inventoryBucket("bucket").notNull(),
  quantityDelta: integer("quantity_delta").notNull(),
  openingBalance: integer("opening_balance").notNull(),
  closingBalance: integer("closing_balance").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("inventory_transaction_lines_transaction_idx").on(table.transactionId),
  index("inventory_transaction_lines_product_idx").on(table.productId, table.createdAt),
  check("inventory_transaction_lines_delta_nonzero", sql`${table.quantityDelta} <> 0`),
  check("inventory_transaction_lines_opening_nonnegative", sql`${table.openingBalance} >= 0`),
  check("inventory_transaction_lines_closing_nonnegative", sql`${table.closingBalance} >= 0`),
  check("inventory_transaction_lines_reconciles", sql`${table.openingBalance} + ${table.quantityDelta} = ${table.closingBalance}`),
]);

export const retailRecipients = pgTable("retail_recipients", {
  id: uuid("id").defaultRandom().primaryKey(),
  type: recipientType("type").notNull(),
  name: text("name").notNull(),
  destination: text("destination"),
  contact: text("contact"),
  active: boolean("active").default(true).notNull(),
  ...auditColumns,
});

export const integrationOutbox = pgTable("integration_outbox", {
  id: uuid("id").defaultRandom().primaryKey(),
  transactionId: uuid("transaction_id").notNull().references(() => inventoryTransactions.id, { onDelete: "restrict" }),
  operation: text("operation").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  status: integrationStatus("status").default("pending").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  lastError: text("last_error"),
  ...auditColumns,
}, (table) => [
  uniqueIndex("integration_outbox_idempotency_unique").on(table.idempotencyKey),
  index("integration_outbox_pending_idx").on(table.status, table.nextAttemptAt),
  check("integration_outbox_attempts_nonnegative", sql`${table.attempts} >= 0`),
]);

export const shopifyWebhookEvents = pgTable("shopify_webhook_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  shopifyEventId: text("shopify_event_id").notNull(),
  topic: text("topic").notNull(),
  payloadHash: text("payload_hash").notNull(),
  status: integrationStatus("status").default("pending").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex("shopify_webhook_events_event_unique").on(table.shopifyEventId)]);

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  actorUsername: text("actor_username").notNull(),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  previousValue: jsonb("previous_value").$type<Record<string, unknown> | null>(),
  newValue: jsonb("new_value").$type<Record<string, unknown> | null>(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("audit_events_entity_idx").on(table.entityType, table.entityId, table.createdAt)]);

export type InventoryBucket = (typeof inventoryBucket.enumValues)[number];
export type InventoryTransactionType = (typeof inventoryTransactionType.enumValues)[number];
