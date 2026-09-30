CREATE TYPE "public"."product_category" AS ENUM('noodles', 'cookies', 'rte', 'other');--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "category" "product_category" DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "unit_price_paisa" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD COLUMN "supplier_name" text;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD COLUMN "invoice_value_paisa" integer;--> statement-breakpoint
ALTER TABLE "offline_sales" ADD COLUMN "order_type" text DEFAULT 'retail' NOT NULL;--> statement-breakpoint
ALTER TABLE "offline_sales" ADD COLUMN "delivery_status" text DEFAULT 'packing' NOT NULL;--> statement-breakpoint
ALTER TABLE "offline_sales" ADD COLUMN "location" text;--> statement-breakpoint
ALTER TABLE "offline_sales" ADD COLUMN "delivery_partner" text;--> statement-breakpoint
ALTER TABLE "offline_sales" ADD COLUMN "delivery_cost_paisa" integer;--> statement-breakpoint
ALTER TABLE "offline_sales" ADD COLUMN "lr_number" text;--> statement-breakpoint
ALTER TABLE "offline_sales" ADD COLUMN "lines" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "inventory_batches_expiry_idx" ON "inventory_batches" USING btree ("expiry_date");
