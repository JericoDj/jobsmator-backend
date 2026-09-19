import { Hono } from "hono";
import { and, asc, desc, eq, getTableColumns, gt, sql as dsql } from "drizzle-orm";
import { validator } from "hono-openapi";
import { z } from "zod";
import { db } from "@/db/client";
import { jobActions, jobs, runs, users, resumes } from "@/db/schema";
import { Job, JobsPage, Tier } from "@/contracts";
import { ApiError } from "@/lib/errors";
import { IdParam, route } from "@/lib/openapi";
import type { AppEnv } from "@/middleware";
import { env } from "@/lib/env";

type JobRow = typeof jobs.$inferSelect & { saved: boolean; hidden: boolean; applied: boolean; responded: boolean; interview: boolean };

const toJob = (j: JobRow): Job => ({
  id: j.id, runId: (j as any).runId ?? (j as any).run_id, rank: j.rank, score: j.score, tier: j.tier, title: j.title, company: j.company, location: j.location,
  remote: j.remote, salary: j.salary, postedAt: j.postedAt?.toISOString() ?? null, url: j.url, site: j.site,
  matchedInterest: j.matchedInterest, why: j.why, redFlags: j.redFlags, saved: j.saved, hidden: j.hidden, applied: j.applied,
  responded: j.responded, interview: j.interview,
});

const flag = (userId: string, action: string) =>
  dsql<boolean>`exists(select 1 from ${jobActions} a where a.job_id = ${jobs.id} and a.user_id = ${userId} and a.action = ${action})`;

const withActions = (userId: string) => ({
  ...getTableColumns(jobs),
  saved: flag(userId, "saved"),
  hidden: flag(userId, "hidden"),
  applied: flag(userId, "applied"),
  responded: flag(userId, "responded"),
  interview: flag(userId, "interview"),
});

const PAGE = 50;
const JobsQuery = z.object({
  tier: Tier.optional(),
  site: z.string().optional(),
  cursor: z.coerce.number().int().min(0).optional().describe("`nextCursor` from the previous page (a rank)"),
});

export const runJobRoutes = new Hono<AppEnv>().get(
  "/:id/jobs",
  route({
    tag: "Jobs",
    summary: "Jobs for a run, best first",
    description: `Pages of ${PAGE}. Filter with \`tier\` and \`site\`; pass \`nextCursor\` back as \`cursor\` for the next page.`,
    ok: { schema: JobsPage },
    errors: { 404: "Unknown run" },
  }),
  validator("param", IdParam),
  validator("query", JobsQuery),
  async (c) => {
    const user = c.get("user");
    const [run] = await db.select({ id: runs.id }).from(runs).where(and(eq(runs.id, c.req.valid("param").id), eq(runs.userId, user.id)));
    if (!run) throw new ApiError("not_found", "We can't find that search.");

    const q = c.req.valid("query");
    const conditions = [eq(jobs.runId, run.id)];
    if (q.tier) conditions.push(eq(jobs.tier, q.tier));
    if (q.site) conditions.push(eq(jobs.site, q.site));
    if (q.cursor !== undefined) conditions.push(gt(jobs.rank, q.cursor));

    const rows = (await db.select(withActions(user.id)).from(jobs).where(and(...conditions)).orderBy(asc(jobs.rank)).limit(PAGE + 1)) as JobRow[];
    const page = rows.slice(0, PAGE);
    const nextCursor = rows.length > PAGE ? String(page[page.length - 1]!.rank) : null;
    return c.json({ items: page.map(toJob), nextCursor });
  },
);

type Action = "saved" | "hidden" | "applied" | "responded" | "interview";

function toggle(action: Action) {
  return async (c: any) => {
    const user = c.get("user");
    const [job] = await db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.id, c.req.valid("param").id), eq(jobs.userId, user.id)));
    if (!job) throw new ApiError("not_found", "That job is no longer here.");
    const existing = await db
      .select({ id: jobActions.id })
      .from(jobActions)
      .where(and(eq(jobActions.jobId, job.id), eq(jobActions.userId, user.id), eq(jobActions.action, action)));
    if (existing.length) await db.delete(jobActions).where(eq(jobActions.id, existing[0]!.id));
    else await db.insert(jobActions).values({ userId: user.id, jobId: job.id, action });
    return c.json({ [action]: existing.length === 0 });
  };
}

const ToggleBody = (key: string) => z.object({ [key]: z.boolean() });
const toggleRoute = (key: Action, summary: string) =>
  route({ tag: "Jobs", summary, description: "Toggles the flag and returns its new value.", ok: { schema: ToggleBody(key) }, errors: { 404: "Unknown job" } });

const FeedQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const jobRoutes = new Hono<AppEnv>()
  .get(
    "/",
    route({
      tag: "Jobs",
      summary: "Every job found for this user, across runs, best first",
      description: "Backs the Jobs tab and Home. Hidden jobs are included with `hidden: true` so the client can filter locally.",
      ok: { schema: JobsPage },
    }),
    async (c) => {
      const user = c.get("user");
      const rows = (await db
        .select(withActions(user.id))
        .from(jobs)
        .where(eq(jobs.userId, user.id))
        .orderBy(desc(jobs.score), asc(jobs.rank))
        .limit(500)) as JobRow[];
      return c.json({ items: rows.map(toJob), nextCursor: null });
    },
  )
  .get(
    "/feed",
    route({
      tag: "Jobs",
      summary: "The job board: a random sample of everything in the database",
      description:
        "Jobs found for any user, one per distinct listing, in random order. Not scored against the caller, so `score`/`tier`/`why` reflect whoever the engine found it for. `saved`/`hidden`/`applied` are always false and the toggle endpoints do not apply — open `url` instead.",
      ok: { schema: JobsPage },
    }),
    validator("query", FeedQuery),
    async (c) => {
      try {
        const { limit } = c.req.valid("query");
        // DISTINCT ON collapses the same listing found for several users, then
        // the outer query shuffles the sample.
        const rows = (await db.execute(dsql`
          select * from (
            select distinct on (fingerprint) ${jobs}.*
            from ${jobs}
            where tier <> 'skip'
            order by fingerprint, score desc
          ) j
          order by random()
          limit ${limit}
        `)) as any[];
        
        const items = rows.map((r) =>
          toJob({
            id: r.id,
            runId: r.run_id,
            userId: r.user_id,
            fingerprint: r.fingerprint,
            rank: r.rank,
            score: r.score,
            tier: r.tier,
            title: r.title,
            company: r.company,
            location: r.location,
            remote: r.remote,
            salary: r.salary,
            url: r.url,
            site: r.site,
            source: r.source,
            why: r.why,
            createdAt: r.created_at ? new Date(r.created_at) : new Date(),
            postedAt: r.posted_at ? new Date(r.posted_at) : null,
            matchedInterest: r.matched_interest ?? "",
            redFlags: r.red_flags ?? [],
            saved: false,
            hidden: false,
            applied: false,
            responded: false,
            interview: false,
          }),
        );
        return c.json({ items, nextCursor: null });
      } catch (err) {
        console.error("Feed error:", err);
        return c.json({ items: [], nextCursor: null });
      }
    },
  )
  .get("/saved", route({ tag: "Jobs", summary: "Saved jobs across all runs", ok: { schema: JobsPage } }), async (c) => {
    const user = c.get("user");
    const rows = (await db
      .select(withActions(user.id))
      .from(jobs)
      .innerJoin(jobActions, and(eq(jobActions.jobId, jobs.id), eq(jobActions.action, "saved"), eq(jobActions.userId, user.id)))
      .where(eq(jobs.userId, user.id))
      .orderBy(asc(jobs.rank))) as unknown as JobRow[];
    return c.json({ items: rows.map(toJob), nextCursor: null });
  })
  .get(
    "/:id",
    route({ tag: "Jobs", summary: "One job", ok: { schema: Job }, errors: { 404: "Unknown job" } }),
    validator("param", IdParam),
    async (c) => {
      const user = c.get("user");
      const [row] = (await db.select(withActions(user.id)).from(jobs).where(and(eq(jobs.id, c.req.valid("param").id), eq(jobs.userId, user.id)))) as JobRow[];
      if (!row) throw new ApiError("not_found", "That job is no longer here.");
      return c.json(toJob(row));
    },
  )
  .post(
    "/:id/score",
    route({
      tag: "Jobs",
      summary: "Score a job for the current user",
      description: "Recalculates fit using OpenRouter, consumes 1 credit, creates a new job record for this user if it's from the feed.",
      ok: { schema: Job },
      errors: { 404: "Unknown job" }
    }),
    validator("param", IdParam),
    async (c) => {
      const user = c.get("user");
      const id = c.req.valid("param").id;
      
      if (!env.OPENROUTER_API_KEY) throw new ApiError("engine_unavailable", "OpenRouter API key is not configured.");

      // Check run limits
      const isPro = user.plan === "pro";
      const searchLimit = isPro ? 5 : 1;
      const periodLabel = isPro ? "this hour" : "today";
      const periodMs = isPro ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
      const since = new Date(Date.now() - periodMs);

      const [recentRow] = await db
        .select({ recent: dsql<number>`count(*)::int` })
        .from(runs)
        .where(and(eq(runs.userId, user.id), gt(runs.startedAt, since)));
        
      if ((recentRow?.recent ?? 0) >= searchLimit) {
        throw new ApiError("too_many_runs", `You've used ${searchLimit} searches ${periodLabel}. Upgrade or try again later.`);
      }

      // Find the job being requested
      const [sourceJob] = await db.select().from(jobs).where(eq(jobs.id, id));
      if (!sourceJob) throw new ApiError("not_found", "That job is no longer here.");

      // Fetch user's latest resume profile
      const [resume] = await db.select().from(resumes).where(eq(resumes.userId, user.id)).orderBy(desc(resumes.createdAt)).limit(1);
      if (!resume || !resume.profile) throw new ApiError("invalid_request", "You need to upload a resume first.");
      
      const interests = (user.defaults as any).interests || [];

      const prompt = `You are an expert AI recruiting assistant. 
Score this job posting against the user's career profile and interests.
Output ONLY a JSON object with this exact schema:
{
  "score": number (0-100),
  "tier": "strong" | "good" | "skip",
  "why": string (short explanation of why it fits or doesn't, address the user directly as 'you'),
  "redFlags": string[] (any concerning things, e.g., 'requires 10 years experience but you have 2', empty array if none)
}

USER PROFILE:
${JSON.stringify(resume.profile, null, 2)}
USER JOB INTERESTS:
${interests.join(", ")}

JOB POSTING:
Title: ${sourceJob.title}
Company: ${sourceJob.company}
Remote: ${sourceJob.remote}
Location: ${sourceJob.location}
Summary/Why: ${sourceJob.why}
`;

      let aiRes;
      try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "openai/gpt-4o-mini",
            response_format: { type: "json_object" },
            messages: [{ role: "user", content: prompt }]
          })
        });
        if (!response.ok) throw new Error("OpenRouter API error");
        const data = (await response.json()) as any;
        aiRes = JSON.parse(data.choices[0].message.content);
      } catch (err) {
        throw new ApiError("engine_unavailable", "Failed to score job.");
      }

      // Charge 1 credit by inserting a dummy run
      const [run] = await db.insert(runs).values({ 
        userId: user.id, 
        resumeId: resume.id, 
        request: { job_interests: interests, jobsites: ["jobsmator"], jobs_per_site: 1, resume_url: resume.url! },
        status: "done",
        stats: { jobsFound: 1, matches: 1 }
      }).returning();

      // Create new job row for this user
      const [newJob] = await db.insert(jobs).values({
        runId: run!.id,
        userId: user.id,
        fingerprint: sourceJob.fingerprint,
        rank: sourceJob.rank,
        score: aiRes.score,
        tier: aiRes.score >= 70 ? "strong" : aiRes.score >= 60 ? "good" : "skip",
        title: sourceJob.title,
        company: sourceJob.company,
        location: sourceJob.location,
        remote: sourceJob.remote,
        salary: sourceJob.salary,
        postedAt: sourceJob.postedAt,
        url: sourceJob.url,
        site: sourceJob.site,
        matchedInterest: interests[0] || "Custom",
        why: aiRes.why || "",
        redFlags: aiRes.redFlags || [],
      }).returning();

      return c.json(toJob(newJob as any));
    }
  )
  .post("/:id/save", toggleRoute("saved", "Save / unsave a job"), validator("param", IdParam), toggle("saved"))
  .post("/:id/hide", toggleRoute("hidden", "Hide / unhide a job"), validator("param", IdParam), toggle("hidden"))
  .post("/:id/applied", toggleRoute("applied", "Mark / unmark as applied"), validator("param", IdParam), toggle("applied"))
  .post("/:id/responded", toggleRoute("responded", "Mark / unmark as got a response"), validator("param", IdParam), toggle("responded"))
  .post("/:id/interview", toggleRoute("interview", "Mark / unmark as interview"), validator("param", IdParam), toggle("interview"));
