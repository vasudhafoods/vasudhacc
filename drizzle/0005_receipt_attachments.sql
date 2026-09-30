CREATE TABLE "inventory_receipt_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"file_size" integer NOT NULL,
	"content_base64" text NOT NULL,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_receipt_attachments_file_size_positive" CHECK ("inventory_receipt_attachments"."file_size" > 0)
);--> statement-breakpoint
ALTER TABLE "inventory_receipt_attachments" ADD CONSTRAINT "inventory_receipt_attachments_transaction_id_inventory_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."inventory_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_receipt_attachments_transaction_idx" ON "inventory_receipt_attachments" USING btree ("transaction_id");
