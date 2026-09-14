import { Hono } from "hono";
import { and, asc, eq, getTableColumns, sql as dsql } from "drizzle-orm";
import { db } from "@/db/client";
import { jobActions, jobs, runs } from "@/db/schema";
import { Tier, type Job } from "@/contracts";
import { ApiError } from "@/lib/errors";
import type { AppEnv } from "@/middleware";

type JobRow = typeof jobs.$inferSelect & { saved: boolean; hidden: boolean };

const toJob = (j: JobRow): Job => ({
  id: j.id, rank: j.rank, score: j.score, tier: j.tier, title: j.title, company: j.company, location: j.location,
  remote: j.remote, salary: j.salary, postedAt: j.postedAt?.toISOString() ?? null, url: j.url, site: j.site,
  matchedInterest: j.matchedInterest, why: j.why, redFlags: j.redFlags, saved: j.saved, hidden: j.hidden,
});

const withActions = (userId: string) => ({
  ...getTableColumns(jobs),
  saved: dsql<boolean>`exists(select 1 from ${jobActions} a where a.job_id = ${jobs.id} and a.user_id = ${userId} and a.action = 'saved')`,
  hidden: dsql<boolean>`exists(select 1 from ${jobActions} a where a.job_id = ${jobs.id} and a.user_id = ${userId} and a.action = 'hidden')`,
});

export const runJobRoutes = new Hono<AppEnv>().get("/:id/jobs", async (c) => {
  const user = c.get("user");
  const [run] = await db.select({ id: runs.id }).from(runs).where(and(eq(runs.id, c.req.param("id")), eq(runs.userId, user.id)));
  if (!run) throw new ApiError("not_found", "We can't find that search.");

  const tier = c.req.query("tier");
  const site = c.req.query("site");
  const conditions = [eq(jobs.runId, run.id)];
  if (tier) conditions.push(eq(jobs.tier, Tier.parse(tier)));
  if (site) conditions.push(eq(jobs.site, site));

  const rows = await db.select(withActions(user.id)).from(jobs).where(and(...conditions)).orderBy(asc(jobs.rank)).limit(200);
  return c.json({ items: rows.map((r) => toJob(r as JobRow)), nextCursor: null });
});

function toggle(action: "saved" | "hidden") {
  return async (c: any) => {
    const user = c.get("user");
    const [job] = await db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.id, c.req.param("id")), eq(jobs.userId, user.id)));
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

export const jobRoutes = new Hono<AppEnv>()
  .get("/saved", async (c) => {
    const user = c.get("user");
    const rows = await db
      .select(withActions(user.id))
      .from(jobs)
      .innerJoin(jobActions, and(eq(jobActions.jobId, jobs.id), eq(jobActions.action, "saved")))
      .where(eq(jobs.userId, user.id))
      .orderBy(asc(jobs.rank));
    return c.json({ items: rows.map((r) => toJob(r as JobRow)), nextCursor: null });
  })
  .post("/:id/save", toggle("saved"))
  .post("/:id/hide", toggle("hidden"));
