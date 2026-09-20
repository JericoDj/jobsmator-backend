CREATE TABLE "boards" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"day" date NOT NULL,
	"job_ids" uuid[] DEFAULT '{}' NOT NULL,
	"shuffles" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "industry" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_industry_idx" ON "jobs" USING btree ("industry");