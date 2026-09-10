CREATE TYPE "public"."offline_customer_type" AS ENUM('retail', 'b2b');--> statement-breakpoint
CREATE TABLE "offline_sale_collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offline_sale_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"amount_paisa" integer NOT NULL,
	"collected_at" timestamp with time zone NOT NULL,
	"reference" text,
	"notes" text,
	"recorded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offline_sale_collections_amount_positive" CHECK ("offline_sale_collections"."amount_paisa" > 0)
);
--> statement-breakpoint
CREATE TABLE "offline_sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sale_number" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"sale_date" timestamp with time zone NOT NULL,
	"customer_name" text NOT NULL,
	"customer_contact" text,
	"customer_type" "offline_customer_type" DEFAULT 'retail' NOT NULL,
	"is_new_b2b_customer" boolean DEFAULT false NOT NULL,
	"total_amount_paisa" integer NOT NULL,
	"reference" text,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offline_sales_total_positive" CHECK ("offline_sales"."total_amount_paisa" > 0)
);
--> statement-breakpoint
ALTER TABLE "offline_sale_collections" ADD CONSTRAINT "offline_sale_collections_offline_sale_id_offline_sales_id_fk" FOREIGN KEY ("offline_sale_id") REFERENCES "public"."offline_sales"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "offline_sale_collections_idempotency_unique" ON "offline_sale_collections" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "offline_sale_collections_sale_idx" ON "offline_sale_collections" USING btree ("offline_sale_id","collected_at");--> statement-breakpoint
CREATE INDEX "offline_sale_collections_collected_idx" ON "offline_sale_collections" USING btree ("collected_at");--> statement-breakpoint
CREATE UNIQUE INDEX "offline_sales_number_unique" ON "offline_sales" USING btree ("sale_number");--> statement-breakpoint
CREATE UNIQUE INDEX "offline_sales_idempotency_unique" ON "offline_sales" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "offline_sales_sale_date_idx" ON "offline_sales" USING btree ("sale_date");--> statement-breakpoint
CREATE INDEX "offline_sales_customer_type_idx" ON "offline_sales" USING btree ("customer_type","sale_date");