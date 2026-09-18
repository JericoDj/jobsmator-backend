ALTER TABLE "resumes" ALTER COLUMN "storage_path" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "resumes" ALTER COLUMN "size_bytes" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "resumes" ADD COLUMN "url" text;