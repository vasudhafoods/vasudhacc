ALTER TABLE "offline_sales" ADD COLUMN "tracking_url" text;
--> statement-breakpoint
ALTER TABLE "offline_sale_documents" DROP CONSTRAINT "offline_sale_documents_kind_valid";
--> statement-breakpoint
ALTER TABLE "offline_sale_documents" ADD CONSTRAINT "offline_sale_documents_kind_valid" CHECK ("offline_sale_documents"."kind" IN ('invoice', 'payment_proof', 'tracking_slip'));
