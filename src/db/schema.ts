import { pgTable, uuid, text, integer, boolean, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  firebaseUid: text("firebase_uid").notNull().unique(),
  email: text("email"),
  displayName: text("display_name"),
  defaults: jsonb("defaults").notNull().default({}),
  sheetId: text("sheet_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const resumes = pgTable(
  "resumes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    storagePath: text("storage_path").notNull(),
    filename: text("filename").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    profile: jsonb("profile"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("resumes_user_idx").on(t.userId, t.createdAt)],
);

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    resumeId: uuid("resume_id").notNull().references(() => resumes.id),
    status: text("status", { enum: ["queued", "running", "done", "failed"] }).notNull().default("queued"),
    request: jsonb("request").notNull(),
    stats: jsonb("stats"),
    sheet: jsonb("sheet"),
    errorCode: text("error_code"),
    rawResponse: jsonb("raw_response"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("runs_user_started_idx").on(t.userId, t.startedAt)],
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(),
    rank: integer("rank").notNull(),
    score: integer("score").notNull(),
    tier: text("tier", { enum: ["strong", "good", "skip"] }).notNull(),
    title: text("title").notNull(),
    company: text("company").notNull().default(""),
    location: text("location").notNull().default(""),
    remote: boolean("remote").notNull().default(false),
    salary: text("salary"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    url: text("url").notNull(),
    site: text("site").notNull(),
    source: text("source").notNull().default(""),
    matchedInterest: text("matched_interest").notNull().default(""),
    why: text("why").notNull().default(""),
    redFlags: text("red_flags").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("jobs_run_tier_rank_idx").on(t.runId, t.tier, t.rank),
    uniqueIndex("jobs_user_fingerprint_uq").on(t.userId, t.fingerprint),
  ],
);

export const jobActions = pgTable(
  "job_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    action: text("action", { enum: ["saved", "hidden", "applied", "responded", "interview"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("job_actions_uq").on(t.userId, t.jobId, t.action), index("job_actions_user_action_idx").on(t.userId, t.action)],
);

/** A saved search that the in-process scheduler runs on a cadence. */
export const automations = pgTable(
  "automations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    resumeId: uuid("resume_id").notNull().references(() => resumes.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** The run request minus resumeId — same shape as `runs.request`. */
    request: jsonb("request").notNull(),
    frequency: text("frequency", { enum: ["daily", "weekdays", "weekly"] }).notNull(),
    hour: integer("hour").notNull(),
    minute: integer("minute").notNull().default(0),
    /** 0 = Sunday … 6 = Saturday; only used by `weekly`. */
    weekday: integer("weekday"),
    /** Client's UTC offset in minutes, so "8:00" means the user's 8:00. */
    tzOffsetMinutes: integer("tz_offset_minutes").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    lastRunId: uuid("last_run_id"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastResultCount: integer("last_result_count"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("automations_due_idx").on(t.enabled, t.nextRunAt)],
);
