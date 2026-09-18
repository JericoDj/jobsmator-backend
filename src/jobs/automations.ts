import { and, eq, inArray, lte, sql as dsql } from "drizzle-orm";
import { db } from "@/db/client";
import { automations, resumes, runs, users } from "@/db/schema";
import type { CreateRunBody } from "@/contracts";
import { logger } from "@/lib/logger";
import { nextRunAfter } from "@/lib/schedule";
import { executeRun } from "@/routes/runs";

/**
 * Fire every enabled automation whose `nextRunAt` has passed. Each one is
 * re-armed before its run starts so a slow engine can't double-fire, and a
 * user with a search already in progress is skipped until the next slot.
 */
export async function runDueAutomations() {
  const now = new Date();
  const due = await db
    .select()
    .from(automations)
    .where(and(eq(automations.enabled, true), lte(automations.nextRunAt, now)));

  for (const a of due) {
    const next = nextRunAfter(a, now);
    await db.update(automations).set({ nextRunAt: next }).where(eq(automations.id, a.id));

    const [user] = await db.select().from(users).where(eq(users.id, a.userId));
    const [resume] = await db.select().from(resumes).where(eq(resumes.id, a.resumeId));
    if (!user || !resume || resume.deletedAt) {
      await db.update(automations).set({ enabled: false }).where(eq(automations.id, a.id));
      logger.warn({ automationId: a.id }, "automation disabled: user or resume gone");
      continue;
    }

    const [active] = await db
      .select({ n: dsql<number>`count(*)::int` })
      .from(runs)
      .where(and(eq(runs.userId, a.userId), inArray(runs.status, ["queued", "running"])));
    if ((active?.n ?? 0) > 0) {
      logger.info({ automationId: a.id }, "automation skipped: a run is already in progress");
      continue;
    }

    const request = a.request as Omit<CreateRunBody, "resumeId">;
    const body: CreateRunBody = { ...request, resumeId: a.resumeId };
    const [run] = await db.insert(runs).values({ userId: a.userId, resumeId: a.resumeId, request }).returning();
    await db.update(automations).set({ lastRunId: run!.id, lastRunAt: now }).where(eq(automations.id, a.id));

    void executeRun(run!.id, user, resume, body).then(async () => {
      const [done] = await db.select({ stats: runs.stats }).from(runs).where(eq(runs.id, run!.id));
      const count = (done?.stats as { recommended?: number } | null)?.recommended ?? null;
      await db.update(automations).set({ lastResultCount: count }).where(eq(automations.id, a.id));
    });
  }
}

/** Ticks once a minute alongside the maintenance jobs. */
export function startAutomations() {
  const tick = () => runDueAutomations().catch((err) => logger.warn({ err }, "runDueAutomations failed"));
  tick();
  setInterval(tick, 60 * 1000);
}
