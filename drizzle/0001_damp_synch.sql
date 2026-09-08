CREATE TABLE "inventory_snapshot_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"snapshot_date" text,
	"total_inventory" integer,
	"total_products" integer,
	"message" text NOT NULL,
	"alert_results" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_snapshot_runs_source_valid" CHECK ("inventory_snapshot_runs"."source" in ('cron', 'manual')),
	CONSTRAINT "inventory_snapshot_runs_status_valid" CHECK ("inventory_snapshot_runs"."status" in ('success', 'failure'))
);
--> statement-breakpoint
CREATE TABLE "inventory_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_date" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"inventory" jsonb NOT NULL,
	"total_inventory" integer NOT NULL,
	"total_products" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operations_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "inventory_snapshot_runs_started_idx" ON "inventory_snapshot_runs" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_snapshots_date_unique" ON "inventory_snapshots" USING btree ("snapshot_date");--> statement-breakpoint
CREATE INDEX "inventory_snapshots_captured_idx" ON "inventory_snapshots" USING btree ("captured_at");