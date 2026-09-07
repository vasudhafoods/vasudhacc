CREATE TYPE "public"."integration_status" AS ENUM('pending', 'processing', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."inventory_bucket" AS ENUM('online', 'retail', 'buffer', 'qc', 'damaged');--> statement-breakpoint
CREATE TYPE "public"."inventory_transaction_type" AS ENUM('opening_balance', 'stock_received', 'shopify_sale', 'retail_issue', 'channel_transfer', 'return', 'damage', 'manual_adjustment', 'cycle_count_adjustment', 'kandi_dispatch', 'narsingi_receipt', 'shopify_reconciliation');--> statement-breakpoint
CREATE TYPE "public"."mapping_status" AS ENUM('mapped', 'missing_sku', 'conflict', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."recipient_type" AS ENUM('salesperson', 'retail_store', 'distributor', 'event', 'sampling', 'institutional_customer', 'other');--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('admin', 'management', 'warehouse_manager', 'warehouse_staff', 'retail_sales');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_username" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"previous_value" jsonb,
	"new_value" jsonb,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "integration_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_outbox_attempts_nonnegative" CHECK ("integration_outbox"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"warehouse_location_id" uuid NOT NULL,
	"bucket" "inventory_bucket" NOT NULL,
	"on_hand" integer DEFAULT 0 NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_balances_on_hand_nonnegative" CHECK ("inventory_balances"."on_hand" >= 0),
	CONSTRAINT "inventory_balances_reserved_nonnegative" CHECK ("inventory_balances"."reserved" >= 0),
	CONSTRAINT "inventory_balances_reserved_within_on_hand" CHECK ("inventory_balances"."reserved" <= "inventory_balances"."on_hand"),
	CONSTRAINT "inventory_balances_version_positive" CHECK ("inventory_balances"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"warehouse_location_id" uuid NOT NULL,
	"batch_number" text NOT NULL,
	"manufacturing_date" timestamp with time zone,
	"expiry_date" timestamp with time zone,
	"best_before_date" timestamp with time zone,
	"received_quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_batches_received_nonnegative" CHECK ("inventory_batches"."received_quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_transaction_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"warehouse_location_id" uuid NOT NULL,
	"batch_id" uuid,
	"bucket" "inventory_bucket" NOT NULL,
	"quantity_delta" integer NOT NULL,
	"opening_balance" integer NOT NULL,
	"closing_balance" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_transaction_lines_delta_nonzero" CHECK ("inventory_transaction_lines"."quantity_delta" <> 0),
	CONSTRAINT "inventory_transaction_lines_opening_nonnegative" CHECK ("inventory_transaction_lines"."opening_balance" >= 0),
	CONSTRAINT "inventory_transaction_lines_closing_nonnegative" CHECK ("inventory_transaction_lines"."closing_balance" >= 0),
	CONSTRAINT "inventory_transaction_lines_reconciles" CHECK ("inventory_transaction_lines"."opening_balance" + "inventory_transaction_lines"."quantity_delta" = "inventory_transaction_lines"."closing_balance")
);
--> statement-breakpoint
CREATE TABLE "inventory_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_number" text NOT NULL,
	"type" "inventory_transaction_type" NOT NULL,
	"idempotency_key" text NOT NULL,
	"reference_id" text,
	"shopify_order_id" text,
	"stock_request_id" uuid,
	"actor_username" text NOT NULL,
	"reason" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"pack_size" text,
	"barcode" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retail_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "recipient_type" NOT NULL,
	"name" text NOT NULL,
	"destination" text,
	"contact" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shopify_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"shopify_product_id" text NOT NULL,
	"shopify_variant_id" text NOT NULL,
	"shopify_inventory_item_id" text NOT NULL,
	"shopify_inventory_level_id" text NOT NULL,
	"shopify_location_id" text NOT NULL,
	"shopify_location_name" text NOT NULL,
	"status" "mapping_status" DEFAULT 'mapped' NOT NULL,
	"last_verified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shopify_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shopify_event_id" text NOT NULL,
	"topic" text NOT NULL,
	"payload_hash" text NOT NULL,
	"status" "integration_status" DEFAULT 'pending' NOT NULL,
	"processed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"role" "staff_role" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "warehouse_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"location_type" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration_outbox" ADD CONSTRAINT "integration_outbox_transaction_id_inventory_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."inventory_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_warehouse_location_id_warehouse_locations_id_fk" FOREIGN KEY ("warehouse_location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_warehouse_location_id_warehouse_locations_id_fk" FOREIGN KEY ("warehouse_location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transaction_lines" ADD CONSTRAINT "inventory_transaction_lines_transaction_id_inventory_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."inventory_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transaction_lines" ADD CONSTRAINT "inventory_transaction_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transaction_lines" ADD CONSTRAINT "inventory_transaction_lines_warehouse_location_id_warehouse_locations_id_fk" FOREIGN KEY ("warehouse_location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transaction_lines" ADD CONSTRAINT "inventory_transaction_lines_batch_id_inventory_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."inventory_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_mappings" ADD CONSTRAINT "shopify_mappings_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_outbox_idempotency_unique" ON "integration_outbox" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "integration_outbox_pending_idx" ON "integration_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_balances_scope_unique" ON "inventory_balances" USING btree ("product_id","warehouse_location_id","bucket");--> statement-breakpoint
CREATE INDEX "inventory_balances_bucket_idx" ON "inventory_balances" USING btree ("bucket");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_batches_identity_unique" ON "inventory_batches" USING btree ("product_id","warehouse_location_id","batch_number");--> statement-breakpoint
CREATE INDEX "inventory_transaction_lines_transaction_idx" ON "inventory_transaction_lines" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "inventory_transaction_lines_product_idx" ON "inventory_transaction_lines" USING btree ("product_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_transactions_number_unique" ON "inventory_transactions" USING btree ("transaction_number");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_transactions_idempotency_unique" ON "inventory_transactions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "inventory_transactions_occurred_idx" ON "inventory_transactions" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "inventory_transactions_shopify_order_idx" ON "inventory_transactions" USING btree ("shopify_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_sku_unique" ON "products" USING btree ("sku");--> statement-breakpoint
CREATE UNIQUE INDEX "products_barcode_unique" ON "products" USING btree ("barcode") WHERE "products"."barcode" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_mappings_item_location_unique" ON "shopify_mappings" USING btree ("shopify_inventory_item_id","shopify_location_id");--> statement-breakpoint
CREATE INDEX "shopify_mappings_product_idx" ON "shopify_mappings" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_webhook_events_event_unique" ON "shopify_webhook_events" USING btree ("shopify_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_users_username_unique" ON "staff_users" USING btree ("username");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouse_locations_code_unique" ON "warehouse_locations" USING btree ("code");--> statement-breakpoint
INSERT INTO "warehouse_locations" ("code", "name", "location_type") VALUES
  ('KANDI', 'Kandi Production / Kitchen', 'production'),
  ('NARSINGI', 'Narsingi Warehouse', 'warehouse')
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_immutable_inventory_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is immutable; create a correcting inventory transaction instead', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER inventory_transactions_immutable
BEFORE UPDATE OR DELETE ON "inventory_transactions"
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_inventory_mutation();--> statement-breakpoint
CREATE TRIGGER inventory_transaction_lines_immutable
BEFORE UPDATE OR DELETE ON "inventory_transaction_lines"
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_inventory_mutation();--> statement-breakpoint
CREATE TRIGGER audit_events_immutable
BEFORE UPDATE OR DELETE ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_inventory_mutation();
