import { and, eq, gt, sql as dsql } from "drizzle-orm";
import { db } from "@/db/client";
import { runs, users } from "@/db/schema";

export type PlanLimits = {
  isPro: boolean;
  /** Searches allowed per `period`: free 1/day, pro 5/hour. */
  searchLimit: number;
  period: "day" | "hour";
  /** Human label for error messages, e.g. "You've used 1 search today." */
  periodLabel: string;
  periodMs: number;
  /** Start of the current period — pass to a `startedAt >` query to count usage. */
  since: Date;
};

/** Single source of truth for plan-based search limits — used by `me`, `runs` and `jobs`. */
export function planLimits(user: typeof users.$inferSelect): PlanLimits {
  const isPro = user.plan === "pro";
  const searchLimit = isPro ? 5 : 1;
  const period: "day" | "hour" = isPro ? "hour" : "day";
  const periodLabel = isPro ? "this hour" : "today";
  const periodMs = isPro ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  return { isPro, searchLimit, period, periodLabel, periodMs, since: new Date(Date.now() - periodMs) };
}

/** Runs started since `since` — what counts against the plan's search limit. */
export async function searchesUsed(userId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ count: dsql<number>`count(*)::int` })
    .from(runs)
    .where(and(eq(runs.userId, userId), gt(runs.startedAt, since)));
  return row?.count ?? 0;
}
