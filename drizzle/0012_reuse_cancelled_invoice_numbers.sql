DROP INDEX "offline_sales_billing_invoice_number_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "offline_sales_billing_invoice_number_unique"
ON "offline_sales" ("billing_invoice_number")
WHERE "delivery_status" <> 'cancelled';
