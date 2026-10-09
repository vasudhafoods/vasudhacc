CREATE TABLE "shopify_sync_state" (
	"key" text PRIMARY KEY NOT NULL,
	"enabled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_through" timestamp with time zone,
	"cursor" text,
	"scan_until" timestamp with time zone,
	"locked_until" timestamp with time zone,
	"subscriptions_checked_at" timestamp with time zone,
	"last_succeeded_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "shopify_webhook_events" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "shopify_webhook_events" ADD COLUMN "locked_at" timestamp with time zone;
