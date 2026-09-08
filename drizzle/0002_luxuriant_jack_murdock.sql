ALTER TABLE "staff_users" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "last_login_at" timestamp with time zone;