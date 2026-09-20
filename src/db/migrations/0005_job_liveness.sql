ALTER TABLE "jobs" ADD COLUMN "checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "expired_at" timestamp with time zone;