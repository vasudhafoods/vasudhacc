ALTER TABLE "offline_sales" ADD COLUMN "delivered_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "offline_sales" AS sale
SET "delivered_at" = delivery_audit."created_at"
FROM (
	SELECT DISTINCT ON ("entity_id") "entity_id", "created_at"
	FROM "audit_events"
	WHERE "action" = 'offline_sale.delivery_status_updated'
		AND "new_value" ->> 'deliveryStatus' = 'delivered'
	ORDER BY "entity_id", "created_at" ASC
) AS delivery_audit
WHERE sale."id"::text = delivery_audit."entity_id"
	AND sale."delivery_status" = 'delivered';
