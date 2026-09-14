import { Hono } from "hono";
import { and, desc, eq, gt, inArray, sql as dsql } from "drizzle-orm";
import { db } from "@/db/client";
import { jobs, resumes, runs, users } from "@/db/schema";
import { CreateRunBody, type Run } from "@/contracts";
import { ApiError } from "@/lib/errors";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { runEngine } from "@/services/engine";
import { signedResumeUrl } from "@/services/storage";
import type { AppEnv, AppUser } from "@/middleware";

const toRun = (r: typeof runs.$inferSelect): Run => ({
  id: r.id,
  status: r.status,
  resumeId: r.resumeId,
  request: r.request as Run["request"],
  stats: (r.stats as Run["stats"]) ?? null,
  sheet: (r.sheet as Run["sheet"]) ?? null,
  errorCode: r.errorCode,
  startedAt: r.startedAt.toISOString(),
  finishedAt: r.finishedAt?.toISOString() ?? null,
});

/** Runs the engine in the background and persists the outcome. Never throws. */
async function executeRun(runId: string, user: AppUser, resume: typeof resumes.$inferSelect, body: CreateRunBody) {
  try {
    await db.update(runs).set({ status: "running" }).where(eq(runs.id, runId));
    const resumeUrl = await signedResumeUrl(resume.storagePath);
    const result = await runEngine({
      resume_url: resumeUrl,
      user_id: user.id,
      job_interests: body.interests,
      jobsites: body.sites,
      jobs_per_site: body.jobsPerSite,
      location: body.location,
      remote_only: body.remoteOnly,
      min_score: body.minScore,
      save_to_sheet: body.saveToSheet,
      sheet_id: user.sheetId ?? undefined,
      share_with_email: body.saveToSheet && user.email ? user.email : undefined,
    });

    await db.transaction(async (tx) => {
      if (result.jobs.length) {
        await tx
          .insert(jobs)
          .values(
            result.jobs.map((j) => ({
              runId, userId: user.id, fingerprint: j.fingerprint, rank: j.rank, score: j.score, tier: j.tier,
              title: j.title, company: j.company, location: j.location, remote: j.remote, salary: j.salary,
              postedAt: j.postedAt ? new Date(j.postedAt) : null, url: j.url, site: j.site, source: j.source,
              matchedInterest: j.matchedInterest, why: j.why, redFlags: j.redFlags,
            })),
          )
          .onConflictDoNothing();
      }
      await tx
        .update(runs)
        .set({
          status: "done",
          stats: result.stats ?? null,
          sheet: result.sheet ? { id: result.sheet.id ?? null, url: result.sheet.url ?? null, rowsAdded: result.sheet.rows_added ?? null } : null,
          rawResponse: result,
          finishedAt: new Date(),
        })
        .where(eq(runs.id, runId));
      if (result.profile) await tx.update(resumes).set({ profile: result.profile }).where(eq(resumes.id, resume.id));
      if (result.sheet?.id && !user.sheetId) await tx.update(users).set({ sheetId: result.sheet.id }).where(eq(users.id, user.id));
    });
  } catch (err) {
    const code = err instanceof ApiError ? err.code : "internal";
    logger.error({ err, runId }, "run failed");
    await db.update(runs).set({ status: "failed", errorCode: code, finishedAt: new Date() }).where(eq(runs.id, runId));
  }
}

export const runRoutes = new Hono<AppEnv>()
  .post("/", async (c) => {
    const user = c.get("user");
    const body = CreateRunBody.parse(await c.req.json());

    const [resume] = await db.select().from(resumes).where(and(eq(resumes.id, body.resumeId), eq(resumes.userId, user.id)));
    if (!resume || resume.deletedAt) throw new ApiError("not_found", "Upload a resume first.");

    const [activeRow] = await db
      .select({ active: dsql<number>`count(*)::int` })
      .from(runs)
      .where(and(eq(runs.userId, user.id), inArray(runs.status, ["queued", "running"])));
    if ((activeRow?.active ?? 0) > 0) throw new ApiError("run_in_progress", "A search is already running — hang on.");

    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const [recentRow] = await db
      .select({ recent: dsql<number>`count(*)::int` })
      .from(runs)
      .where(and(eq(runs.userId, user.id), gt(runs.startedAt, hourAgo)));
    if ((recentRow?.recent ?? 0) >= env.RUNS_PER_HOUR) throw new ApiError("too_many_runs", `You've used ${env.RUNS_PER_HOUR} searches this hour. Try again later.`);

    const { resumeId, ...request } = body;
    const [run] = await db.insert(runs).values({ userId: user.id, resumeId, request }).returning();

    void executeRun(run!.id, user, resume, body);
    return c.json({ runId: run!.id }, 202);
  })
  .get("/", async (c) => {
    const rows = await db.select().from(runs).where(eq(runs.userId, c.get("user").id)).orderBy(desc(runs.startedAt)).limit(50);
    return c.json({ items: rows.map(toRun) });
  })
  .get("/:id", async (c) => {
    const [row] = await db.select().from(runs).where(and(eq(runs.id, c.req.param("id")), eq(runs.userId, c.get("user").id)));
    if (!row) throw new ApiError("not_found", "We can't find that search.");
    return c.json(toRun(row));
  });

/** On boot: anything left queued/running from a previous process is dead. */
export async function sweepStaleRuns() {
  const cutoff = new Date(Date.now() - 3 * 60 * 1000);
  await db
    .update(runs)
    .set({ status: "failed", errorCode: "engine_unavailable", finishedAt: new Date() })
    .where(and(inArray(runs.status, ["queued", "running"]), dsql`${runs.startedAt} < ${cutoff}`));
}
