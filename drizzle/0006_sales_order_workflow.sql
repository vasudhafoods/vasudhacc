ALTER TABLE "offline_sales"
  ADD COLUMN "billing_invoice_number" text,
  ADD COLUMN "billing_address" text DEFAULT '' NOT NULL,
  ADD COLUMN "shipping_address" text DEFAULT '' NOT NULL,
  ADD COLUMN "shipping_same_as_billing" boolean DEFAULT true NOT NULL,
  ADD COLUMN "gst_number" text,
  ADD COLUMN "subtotal_amount_paisa" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "discount_paisa" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "tax_paisa" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "warehouse_location_id" uuid REFERENCES "warehouse_locations"("id") ON DELETE RESTRICT,
  ADD COLUMN "expected_next_payment_date" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "offline_sales_billing_invoice_number_unique" ON "offline_sales" USING btree ("billing_invoice_number");
--> statement-breakpoint
ALTER TABLE "offline_sale_collections"
  ADD COLUMN "payment_mode" text,
  ADD COLUMN "transaction_id" text,
  ADD COLUMN "receiver_name" text,
  ADD COLUMN "expected_next_payment_date" text;
--> statement-breakpoint
CREATE TABLE "offline_sale_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "offline_sale_id" uuid NOT NULL REFERENCES "offline_sales"("id") ON DELETE RESTRICT,
  "kind" text NOT NULL,
  "file_name" text NOT NULL,
  "content_type" text NOT NULL,
  "file_size" integer NOT NULL,
  "content_base64" text NOT NULL,
  "uploaded_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "offline_sale_documents_kind_valid" CHECK ("kind" IN ('invoice', 'payment_proof')),
  CONSTRAINT "offline_sale_documents_file_size_positive" CHECK ("file_size" > 0)
);
--> statement-breakpoint
CREATE INDEX "offline_sale_documents_sale_idx" ON "offline_sale_documents" USING btree ("offline_sale_id");
