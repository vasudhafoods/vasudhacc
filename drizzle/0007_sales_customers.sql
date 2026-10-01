CREATE TABLE "sales_customers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "company_name" text,
  "address" text NOT NULL,
  "phone" text NOT NULL,
  "gst_number" text,
  "active" boolean DEFAULT true NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "sales_customers_name_idx" ON "sales_customers" USING btree ("name");
--> statement-breakpoint
CREATE INDEX "sales_customers_company_idx" ON "sales_customers" USING btree ("company_name");
--> statement-breakpoint
ALTER TABLE "offline_sales" ADD COLUMN "customer_company_name" text;
