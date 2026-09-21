import { pgTable, uuid, text, integer, boolean, timestamp, jsonb, date, uniqueIndex, index } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  firebaseUid: text("firebase_uid").notNull().unique(),
  email: text("email"),
  displayName: text("display_name"),
  defaults: jsonb("defaults").notNull().default({}),
  sheetId: text("sheet_id"),
  plan: text("plan", { enum: ["free", "pro"] }).notNull().default("free"),
  renewsAt: timestamp("renews_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const resumes = pgTable(
  "resumes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    storagePath: text("storage_path"),
    url: text("url"),
    filename: text("filename").notNull(),
    sizeBytes: integer("size_bytes"),
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
    industry: text("industry").notNull().default(""),
    coverLetter: text("cover_letter"),
    // Liveness of the source URL: when we last looked, and when it was gone (404/410).
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("jobs_run_tier_rank_idx").on(t.runId, t.tier, t.rank),
    uniqueIndex("jobs_user_fingerprint_uq").on(t.userId, t.fingerprint),
    index("jobs_industry_idx").on(t.industry),
  ],
);

/** The job board a user sees today: fixed picks, at most 5 reshuffles a day. */
export const boards = pgTable(
  "boards",
  {
    userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    jobIds: uuid("job_ids").array().notNull().default([]),
    shuffles: integer("shuffles").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
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

export const vouchers = pgTable("vouchers", {
  code: text("code").primaryKey(),
  durationDays: integer("duration_days"), // null means forever
  maxUses: integer("max_uses"), // null means unlimited
  useCount: integer("use_count").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }), // null means never expires
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const voucherRedemptions = pgTable("voucher_redemptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().references(() => vouchers.code, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  redeemedAt: timestamp("redeemed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("voucher_redemptions_user_code_uq").on(t.userId, t.code)]);

/** A connected third-party account (Canva today), one row per user × provider. */
export const integrations = pgTable(
  "integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: ["canva"] }).notNull(),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    scopes: text("scopes").array().notNull().default([]),
    externalUserId: text("external_user_id"),
    externalDisplayName: text("external_display_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("integrations_user_provider_uq").on(t.userId, t.provider)],
);

/** In-flight OAuth handshakes: the state we sent out and the PKCE verifier it needs on return. */
export const oauthStates = pgTable("oauth_states", {
  state: text("state").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider", { enum: ["canva"] }).notNull(),
  codeVerifier: text("code_verifier").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/** One Ask JobsMator conversation. `tool` is set when the thread came from the Tools tab. */
export const aiThreads = pgTable(
  "ai_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("New conversation"),
    tool: text("tool"),
    /** Rolling summary of turns that no longer fit the context window. */
    summary: text("summary"),
    /** `created_at` of the last message the summary covers; later ones are sent verbatim. */
    summaryThrough: timestamp("summary_through", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("ai_threads_user_updated_idx").on(t.userId, t.updatedAt)],
);

export const aiMessages = pgTable(
  "ai_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id").notNull().references(() => aiThreads.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    /** Images the user attached to this message. */
    attachmentIds: uuid("attachment_ids").array().notNull().default([]),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ai_messages_thread_created_idx").on(t.threadId, t.createdAt), index("ai_messages_user_created_idx").on(t.userId, t.createdAt)],
);

/**
 * An image the user uploaded for the assistant. The model describes it once
 * on upload; that `analysis` is what later turns see, so the picture is only
 * ever sent to the model on the turn it was attached to.
 */
export const aiAttachments = pgTable(
  "ai_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    storagePath: text("storage_path").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    /** What kind of thing the picture is: job_posting, resume, screenshot, other. */
    kind: text("kind").notNull().default("other"),
    analysis: text("analysis"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ai_attachments_user_idx").on(t.userId, t.createdAt)],
);
