import { Hono } from "hono";
import { and, desc, eq, inArray, isNull, sql as dsql } from "drizzle-orm";
import { validator } from "hono-openapi";
import { z } from "zod";
import { db } from "@/db/client";
import { jobActions, jobs, resumes } from "@/db/schema";
import { CreateResumeBody, Resume, ResumeAnalysis, ResumeAnalysisStatus, ResumeMatches } from "@/contracts";
import { ApiError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { IdParam, route } from "@/lib/openapi";
import { toJob, withActions } from "@/routes/jobs";
import { analyzeResume } from "@/services/resume-analysis";
import { deleteObject } from "@/services/storage";
import type { AppEnv } from "@/middleware";

type ResumeRow = typeof resumes.$inferSelect;

const analysisStatus = (r: ResumeRow): ResumeAnalysisStatus => (r.analysis ? "done" : r.analysisError ? "failed" : "pending");

const toResume = (r: ResumeRow): Resume => ({
  id: r.id,
  filename: r.filename,
  sizeBytes: r.sizeBytes,
  createdAt: r.createdAt.toISOString(),
  analysis: (r.analysis as ResumeAnalysis | null) ?? null,
  analyzedAt: r.analyzedAt ? r.analyzedAt.toISOString() : null,
  analysisStatus: analysisStatus(r),
});

async function loadOwnResume(userId: string, id: string): Promise<ResumeRow> {
  const [row] = await db.select().from(resumes).where(and(eq(resumes.id, id), eq(resumes.userId, userId), isNull(resumes.deletedAt)));
  if (!row) throw new ApiError("not_found", "That resume is gone.");
  return row;
}

// ---------------------------------------------------------------------------
// Matches: rank the shared job pool (same one /v1/jobs/feed draws from) by
// how many of the résumé's analysis tags a listing's title/industry/matched
// interest hits. SQL does the coarse ILIKE filter (so we don't pull every
// non-expired job into memory); `rankMatches` does the exact scoring and tie
// breaks, and is exported for tests to exercise on a fixture list.
// ---------------------------------------------------------------------------

export type MatchCandidate = { id: string; title: string; industry: string; matchedInterest: string; score: number; userId: string };

/** Tags worth matching on: lowercase, deduped, and at least 3 characters (two-letter tags match far too much). */
export function usableTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 3))];
}

/** Escapes `%`, `_` and `\` so a tag can be dropped straight into an ILIKE pattern. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => "\\" + c);
}

/**
 * Ranks candidate jobs by how many distinct tags they hit (desc), then
 * `score` (desc), then the caller's own jobs before others on ties. Only
 * candidates that hit at least one tag are kept.
 */
export function rankMatches<T extends MatchCandidate>(rows: T[], tags: string[], currentUserId: string): (T & { tagsHit: number })[] {
  // Whole-word matches only, so "go" doesn't hit "manager" and "c" doesn't hit everything.
  const matchers = usableTags(tags).map((t) => new RegExp(`(^|[^a-z0-9+#])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9+#]|$)`));
  return rows
    .map((r) => {
      const haystack = `${r.title} ${r.industry} ${r.matchedInterest}`.toLowerCase();
      const tagsHit = matchers.filter((m) => m.test(haystack)).length;
      return { ...r, tagsHit };
    })
    .filter((r) => r.tagsHit > 0)
    .sort((a, b) => {
      if (b.tagsHit !== a.tagsHit) return b.tagsHit - a.tagsHit;
      if (b.score !== a.score) return b.score - a.score;
      return (b.userId === currentUserId ? 1 : 0) - (a.userId === currentUserId ? 1 : 0);
    });
}

/** Coarse pool: non-expired jobs the user hasn't hidden, matching at least one tag by ILIKE. */
async function candidatePool(userId: string, tags: string[]): Promise<MatchCandidate[]> {
  const usable = usableTags(tags);
  if (!usable.length) return [];
  const patterns = usable.map((t) => `%${escapeLike(t)}%`);
  const hitClauses = patterns.map(
    (p) => dsql`(${jobs.title} ilike ${p} escape '\\' or ${jobs.industry} ilike ${p} escape '\\' or ${jobs.matchedInterest} ilike ${p} escape '\\')`,
  );
  const anyHit = dsql.join(hitClauses, dsql` or `);
  const rows = await db
    .select({ id: jobs.id, title: jobs.title, industry: jobs.industry, matchedInterest: jobs.matchedInterest, score: jobs.score, userId: jobs.userId })
    .from(jobs)
    .where(
      and(
        isNull(jobs.expiredAt),
        anyHit,
        dsql`not exists (select 1 from ${jobActions} a where a.job_id = ${jobs.id} and a.user_id = ${userId} and a.action = 'hidden')`,
      ),
    )
    .limit(500);
  return rows;
}

const MatchesQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) });

export const resumeRoutes = new Hono<AppEnv>()
  .post(
    "/",
    route({
      tag: "Resumes",
      summary: "Register an uploaded resume",
      description:
        "The client uploads straight to Firebase Storage at `resumes/{uid}/{file}` and then registers the path here. " +
        "Kicks off résumé analysis in the background; poll `GET /v1/resumes/{id}` and watch `analysisStatus`.",
      ok: { status: 201, schema: z.object({ resumeId: z.string().uuid() }) },
      errors: { 400: "Bad path or size", 403: "Path is outside the caller's folder" },
    }),
    validator("json", CreateResumeBody),
    async (c) => {
      const body = c.req.valid("json");
      const user = c.get("user");
      if (body.storagePath && !body.storagePath.startsWith(`resumes/${user.firebaseUid}/`)) {
        throw new ApiError("forbidden", "That file isn't in your folder.");
      }
      const [row] = await db.insert(resumes).values({ userId: user.id, ...body }).returning();
      void analyzeResume(row!.id).catch((err) => logger.warn({ err, resumeId: row!.id }, "resume analysis kick-off failed"));
      return c.json({ resumeId: row!.id }, 201);
    },
  )

  .get("/", route({ tag: "Resumes", summary: "List resumes, newest first", ok: { schema: z.object({ items: z.array(Resume) }) } }), async (c) => {
    const rows = await db
      .select().from(resumes)
      .where(and(eq(resumes.userId, c.get("user").id), isNull(resumes.deletedAt)))
      .orderBy(desc(resumes.createdAt));
    return c.json({ items: rows.map(toResume) });
  })

  .get(
    "/:id",
    route({ tag: "Resumes", summary: "One resume, with its analysis if ready", ok: { schema: Resume }, errors: { 404: "Unknown resume" } }),
    validator("param", IdParam),
    async (c) => {
      const row = await loadOwnResume(c.get("user").id, c.req.valid("param").id);
      return c.json(toResume(row));
    },
  )

  .post(
    "/:id/analyze",
    route({
      tag: "Resumes",
      summary: "Re-run résumé analysis now",
      description: "Awaits the analysis (a few seconds) and returns the updated resume. No quota for now.",
      ok: { schema: Resume },
      errors: { 404: "Unknown resume", 503: "The assistant isn't available right now" },
    }),
    validator("param", IdParam),
    async (c) => {
      const user = c.get("user");
      const row = await loadOwnResume(user.id, c.req.valid("param").id);
      await analyzeResume(row.id);
      const updated = await loadOwnResume(user.id, row.id);
      return c.json(toResume(updated));
    },
  )

  .get(
    "/:id/matches",
    route({
      tag: "Resumes",
      summary: "Jobs matching this resume's analysis tags",
      description:
        "Ranks the same job pool `/v1/jobs/feed` draws from (the user's own jobs plus other non-expired listings) by how many of the résumé's " +
        "`tags` a listing's title/industry/matched interest hits, best first. Empty until the resume has been analyzed.",
      ok: { schema: ResumeMatches },
      errors: { 404: "Unknown resume" },
    }),
    validator("param", IdParam),
    validator("query", MatchesQuery),
    async (c) => {
      const user = c.get("user");
      const row = await loadOwnResume(user.id, c.req.valid("param").id);
      const { limit } = c.req.valid("query");
      const analysis = (row.analysis as ResumeAnalysis | null) ?? null;
      const tags = analysis?.tags ?? [];
      if (!tags.length) return c.json({ items: [], tags: [] });

      const pool = await candidatePool(user.id, tags);
      const ranked = rankMatches(pool, tags, user.id).slice(0, limit);
      const ids = ranked.map((r) => r.id);
      const fullRows = ids.length ? ((await db.select(withActions(user.id)).from(jobs).where(inArray(jobs.id, ids))) as any[]) : [];
      const byId = new Map(fullRows.map((r) => [r.id, r]));
      const items = ids.map((id) => byId.get(id)).filter(Boolean).map((r) => toJob(r));
      return c.json({ items, tags });
    },
  )

  .delete(
    "/:id",
    route({ tag: "Resumes", summary: "Delete a resume and its file", noContent: true, errors: { 404: "Unknown or already deleted" } }),
    validator("param", IdParam),
    async (c) => {
      const [row] = await db
        .update(resumes).set({ deletedAt: new Date() })
        .where(and(eq(resumes.id, c.req.valid("param").id), eq(resumes.userId, c.get("user").id), isNull(resumes.deletedAt)))
        .returning();
      if (!row) throw new ApiError("not_found", "That resume is already gone.");
      if (row.storagePath) {
        await deleteObject(row.storagePath);
      }
      return c.body(null, 204);
    },
  );
