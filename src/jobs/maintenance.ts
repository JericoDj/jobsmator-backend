import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { db } from "@/db/client";
import { jobs, runs } from "@/db/schema";
import { classifyIndustry } from "@/lib/industry";
import { logger } from "@/lib/logger";

/** Anything left queued/running from a previous process (or hung) is dead after 3 minutes. */
export async function sweepStaleRuns() {
  const cutoff = new Date(Date.now() - 3 * 60 * 1000);
  const rows = await db
    .update(runs)
    .set({ status: "failed", errorCode: "engine_unavailable", finishedAt: new Date() })
    .where(and(inArray(runs.status, ["queued", "running"]), lt(runs.startedAt, cutoff)))
    .returning({ id: runs.id });
  if (rows.length) logger.warn({ count: rows.length }, "marked stale runs as failed");
}

/** Raw engine payloads are kept 7 days for debugging, then dropped (they hold resume-derived text). */
export async function purgeRawResponses() {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rows = await db
    .update(runs)
    .set({ rawResponse: null })
    .where(and(isNotNull(runs.rawResponse), lt(runs.finishedAt, cutoff)))
    .returning({ id: runs.id });
  if (rows.length) logger.info({ count: rows.length }, "purged raw engine responses");
}

/** Labels jobs inserted before the industry column existed. Idempotent: only rows still at ''. */
export async function backfillIndustry() {
  const rows = await db.select({ id: jobs.id, title: jobs.title, company: jobs.company }).from(jobs).where(eq(jobs.industry, ""));
  for (const r of rows) await db.update(jobs).set({ industry: classifyIndustry(r.title, r.company) }).where(eq(jobs.id, r.id));
  if (rows.length) logger.info({ count: rows.length }, "labelled job industries");
}

/** In-process scheduler — enough for one API instance. Move to Railway cron if we scale out. */
export function startMaintenance() {
  const safe = (name: string, fn: () => Promise<void>) => () => fn().catch((err) => logger.warn({ err }, `${name} failed`));
  safe("sweepStaleRuns", sweepStaleRuns)();
  safe("purgeRawResponses", purgeRawResponses)();
  safe("backfillIndustry", backfillIndustry)();
  setInterval(safe("sweepStaleRuns", sweepStaleRuns), 60 * 1000);
  setInterval(safe("purgeRawResponses", purgeRawResponses), 6 * 60 * 60 * 1000);
}

// keep drizzle's sql import referenced for future raw queries

