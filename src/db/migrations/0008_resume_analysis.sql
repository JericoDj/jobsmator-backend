ALTER TABLE "resumes" ADD COLUMN "analysis" jsonb;--> statement-breakpoint
ALTER TABLE "resumes" ADD COLUMN "analyzed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "resumes" ADD COLUMN "analysis_error" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "plan_source" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "plan_updated_at" timestamp with time zone;