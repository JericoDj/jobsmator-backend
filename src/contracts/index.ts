/**
 * Shared request/response contracts. The API is the source of truth;
 * `bun run sync:web` copies this file into jobsmator-web/lib/contracts.ts.
 * Keep it dependency-free apart from zod.
 */
import { z } from "zod";

export const JOB_SITES = [
  "LinkedIn", "JobStreet", "OnlineJobs.ph", "Indeed", "BossJob",
  "Kalibrr", "Glassdoor", "ZipRecruiter", "Google Jobs", "Wellfound",
] as const;
export type JobSite = (typeof JOB_SITES)[number];

export const Tier = z.enum(["strong", "good", "skip"]);
export type Tier = z.infer<typeof Tier>;

export const RunStatus = z.enum(["queued", "running", "done", "failed"]);
export type RunStatus = z.infer<typeof RunStatus>;

// ---------- user ----------
export const UserDefaults = z.object({
  interests: z.array(z.string().min(1)).max(5).default([]),
  sites: z.array(z.enum(JOB_SITES)).default([...JOB_SITES]),
  jobsPerSite: z.number().int().min(5).max(50).default(20),
  location: z.string().default("Philippines"),
  remoteOnly: z.boolean().default(false),
  minScore: z.number().int().min(0).max(100).default(60),
});
export type UserDefaults = z.infer<typeof UserDefaults>;

export const SubscriptionPlan = z.enum(["free", "pro"]);
export type SubscriptionPlan = z.infer<typeof SubscriptionPlan>;

export const SubscriptionInfo = z.object({
  plan: SubscriptionPlan.default("free"),
  searchesUsed: z.number().int().min(0).default(0),
  renewsAt: z.string().nullable().default(null),
});
export type SubscriptionInfo = z.infer<typeof SubscriptionInfo>;

export const RegisterBody = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  displayName: z.string().min(1, "Name is required").max(100),
});
export type RegisterBody = z.infer<typeof RegisterBody>;

export const RegisterResponse = z.object({
  user: z.lazy(() => Me),
  token: z.string(),
});
export type RegisterResponse = z.infer<typeof RegisterResponse>;

export const Me = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid().optional(),
  email: z.string().email().nullable(),
  displayName: z.string().nullable(),
  defaults: UserDefaults,
  sheetId: z.string().nullable(),
  subscription: SubscriptionInfo.optional(),
  profile: z.record(z.string(), z.unknown()).optional(),
  automations: z.array(z.lazy(() => Automation)).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});
export type Me = z.infer<typeof Me>;

// ---------- automations ----------
export const AutomationFrequency = z.enum(["daily", "weekdays", "weekly"]);
export type AutomationFrequency = z.infer<typeof AutomationFrequency>;

export const CreateAutomationBody = z.object({
  name: z.string().min(1).max(80).optional(),
  resumeId: z.string().uuid(),
  interests: z.array(z.string().min(1)).min(1).max(5),
  sites: z.array(z.enum(JOB_SITES)).min(1),
  jobsPerSite: z.number().int().min(5).max(50).default(20),
  frequency: AutomationFrequency,
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59).default(0),
  weekday: z.number().int().min(0).max(6).optional().describe("0 = Sunday … 6 = Saturday; required for `weekly`"),
  tzOffsetMinutes: z.number().int().min(-840).max(840).default(0).describe("Client UTC offset in minutes, e.g. 480 for Manila"),
});
export type CreateAutomationBody = z.infer<typeof CreateAutomationBody>;

export const UpdateAutomationBody = z.object({
  name: z.string().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
});

export const Automation = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid().optional(),
  name: z.string(),
  /** Human label, e.g. "Every day · 8:00". */
  schedule: z.string(),
  frequency: AutomationFrequency,
  hour: z.number(),
  minute: z.number(),
  weekday: z.number().nullable(),
  interests: z.array(z.string()),
  sites: z.array(z.string()),
  enabled: z.boolean(),
  lastRunAt: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  lastResultCount: z.number().nullable(),
});
export type Automation = z.infer<typeof Automation>;

// ---------- resumes ----------
export const CreateResumeBody = z.object({
  storagePath: z.string().regex(/^resumes\/[^/]+\/[^/]+$/).optional(),
  url: z.string().url().optional(),
  filename: z.string().min(1).max(200),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024).optional(),
}).refine(data => data.storagePath || data.url, { message: "Must provide either storagePath or url" });
export const Resume = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid().optional(),
  filename: z.string(),
  sizeBytes: z.number().nullable(),
  createdAt: z.string(),
});
export type Resume = z.infer<typeof Resume>;

// ---------- runs ----------
export const CreateRunBody = z.object({
  resumeId: z.string().uuid(),
  interests: z.array(z.string().min(1)).min(1).max(5),
  sites: z.array(z.enum(JOB_SITES)).min(1),
  jobsPerSite: z.number().int().min(5).max(50).default(20),
  location: z.string().optional(),
  remoteOnly: z.boolean().optional(),
  minScore: z.number().int().min(0).max(100).optional(),
  saveToSheet: z.boolean().default(false),
});
export type CreateRunBody = z.infer<typeof CreateRunBody>;

export const RunStats = z.object({
  fetched_unique: z.number(),
  already_processed: z.number(),
  scored: z.number(),
  recommended: z.number(),
  feedback: z.string().optional(),
  recommended_per_site: z.record(z.string(), z.number()),
});
export const Run = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid().optional(),
  status: RunStatus,
  resumeId: z.string().uuid(),
  request: CreateRunBody.omit({ resumeId: true }),
  stats: RunStats.nullable(),
  sheet: z.object({ id: z.string().nullable(), url: z.string().nullable(), rowsAdded: z.number().nullable() }).nullable(),
  errorCode: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type Run = z.infer<typeof Run>;

// ---------- jobs ----------
export const Job = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid().optional(),
  rank: z.number(),
  score: z.number(),
  tier: Tier,
  title: z.string(),
  company: z.string(),
  location: z.string(),
  remote: z.boolean(),
  salary: z.string().nullable(),
  postedAt: z.string().nullable(),
  url: z.string().url(),
  site: z.string(),
  matchedInterest: z.string(),
  industry: z.string().default(""),
  why: z.string(),
  redFlags: z.array(z.string()),
  saved: z.boolean(),
  hidden: z.boolean(),
  applied: z.boolean(),
  /** The company replied after you applied. */
  responded: z.boolean(),
  /** You have (or had) an interview. */
  interview: z.boolean(),
});
export type Job = z.infer<typeof Job>;

export const JobsPage = z.object({
  items: z.array(Job),
  nextCursor: z.string().nullable(),
  /** Board only: reshuffles left today. */
  shufflesLeft: z.number().int().optional(),
});

// ---------- errors ----------
export const ApiErrorBody = z.object({
  error: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});

// ---------- engine (n8n) ----------
export const EngineRequest = z.object({
  resume_url: z.string().url(),
  user_id: z.string(),
  job_interests: z.array(z.string()).min(1).max(5),
  jobsites: z.array(z.string()).min(1),
  jobs_per_site: z.number().int(),
  location: z.string().optional(),
  remote_only: z.boolean().optional(),
  min_score: z.number().int().optional(),
  save_to_sheet: z.boolean().optional(),
  sheet_id: z.string().optional(),
  share_with_email: z.string().email().optional(),
});
export type EngineRequest = z.infer<typeof EngineRequest>;

export const EngineJob = z.object({
  rank: z.number(),
  score: z.number(),
  // Engine may label weak matches "skip"/"weak" or omit the tier; the API
  // recomputes it from score + minScore anyway.
  tier: z.enum(["strong", "good", "skip", "weak"]).optional(),
  title: z.string(),
  company: z.string().default(""),
  location: z.string().default(""),
  remote: z.boolean().default(false),
  salary: z.string().nullable().default(null),
  postedAt: z.string().nullable().default(null),
  url: z.string(),
  site: z.string(),
  source: z.string().default(""),
  matchedInterest: z.string().default(""),
  why: z.string().default(""),
  redFlags: z.array(z.string()).default([]),
  fingerprint: z.string(),
});
export const EngineResponse = z.object({
  ok: z.boolean(),
  message: z.string().optional(),
  profile: z.record(z.string(), z.unknown()).optional(),
  stats: RunStats.partial().optional(),
  sheet: z
    .object({ id: z.string().nullable(), url: z.string().nullable(), rows_added: z.number().nullable(), error: z.string().nullable() })
    .partial()
    .nullable()
    .optional(),
  jobs: z.array(EngineJob).default([]),
  recommendation: z.string().optional(),
  generated_at: z.string().optional(),
});
export type EngineResponse = z.infer<typeof EngineResponse>;
