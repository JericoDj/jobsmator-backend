CREATE TABLE "job_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"rank" integer NOT NULL,
	"score" integer NOT NULL,
	"tier" text NOT NULL,
	"title" text NOT NULL,
	"company" text DEFAULT '' NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"remote" boolean DEFAULT false NOT NULL,
	"salary" text,
	"posted_at" timestamp with time zone,
	"url" text NOT NULL,
	"site" text NOT NULL,
	"source" text DEFAULT '' NOT NULL,
	"matched_interest" text DEFAULT '' NOT NULL,
	"why" text DEFAULT '' NOT NULL,
	"red_flags" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resumes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"storage_path" text NOT NULL,
	"filename" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"profile" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"resume_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"request" jsonb NOT NULL,
	"stats" jsonb,
	"sheet" jsonb,
	"error_code" text,
	"raw_response" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firebase_uid" text NOT NULL,
	"email" text,
	"display_name" text,
	"defaults" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sheet_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_firebase_uid_unique" UNIQUE("firebase_uid")
);
--> statement-breakpoint
ALTER TABLE "job_actions" ADD CONSTRAINT "job_actions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_actions" ADD CONSTRAINT "job_actions_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resumes" ADD CONSTRAINT "resumes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_resume_id_resumes_id_fk" FOREIGN KEY ("resume_id") REFERENCES "public"."resumes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_actions_uq" ON "job_actions" USING btree ("user_id","job_id","action");--> statement-breakpoint
CREATE INDEX "job_actions_user_action_idx" ON "job_actions" USING btree ("user_id","action");--> statement-breakpoint
CREATE INDEX "jobs_run_tier_rank_idx" ON "jobs" USING btree ("run_id","tier","rank");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_user_fingerprint_uq" ON "jobs" USING btree ("user_id","fingerprint");--> statement-breakpoint
CREATE INDEX "resumes_user_idx" ON "resumes" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_user_started_idx" ON "runs" USING btree ("user_id","started_at");