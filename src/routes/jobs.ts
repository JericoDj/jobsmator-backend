import { Hono } from "hono";
import { and, asc, eq, getTableColumns, gt, sql as dsql } from "drizzle-orm";
import { validator } from "hono-openapi";
import { z } from "zod";
import { db } from "@/db/client";
import { jobActions, jobs, runs } from "@/db/schema";
import { Job, JobsPage, Tier } from "@/contracts";
import { ApiError } from "@/lib/errors";
import { IdParam, route } from "@/lib/openapi";
import type { AppEnv } from "@/middleware";

type JobRow = typeof jobs.$inferSelect & { saved: boolean; hidden: boolean; applied: boolean };

const toJob = (j: JobRow): Job => ({
  id: j.id, rank: j.rank, score: j.score, tier: j.tier, title: j.title, company: j.company, location: j.location,
  remote: j.remote, salary: j.salary, postedAt: j.postedAt?.toISOString() ?? null, url: j.url, site: j.site,
  matchedInterest: j.matchedInterest, why: j.why, redFlags: j.redFlags, saved: j.saved, hidden: j.hidden, applied: j.applied,
});

const flag = (userId: string, action: string) =>
  dsql<boolean>`exists(select 1 from ${jobActions} a where a.job_id = ${jobs.id} and a.user_id = ${userId} and a.action = ${action})`;

const withActions = (userId: string) => ({
  ...getTableColumns(jobs),
  saved: flag(userId, "saved"),
  hidden: flag(userId, "hidden"),
  applied: flag(userId, "applied"),
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

function toggle(action: "saved" | "hidden" | "applied") {
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
const toggleRoute = (key: "saved" | "hidden" | "applied", summary: string) =>
  route({ tag: "Jobs", summary, description: "Toggles the flag and returns its new value.", ok: { schema: ToggleBody(key) }, errors: { 404: "Unknown job" } });

export const jobRoutes = new Hono<AppEnv>()
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
  .post("/:id/save", toggleRoute("saved", "Save / unsave a job"), validator("param", IdParam), toggle("saved"))
  .post("/:id/hide", toggleRoute("hidden", "Hide / unhide a job"), validator("param", IdParam), toggle("hidden"))
  .post("/:id/applied", toggleRoute("applied", "Mark / unmark as applied"), validator("param", IdParam), toggle("applied"));
