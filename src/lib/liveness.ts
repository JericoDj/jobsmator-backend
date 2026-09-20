import { inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { jobs } from "@/db/schema";
import { logger } from "@/lib/logger";

const RECHECK_AFTER_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 6000;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * Is the listing still up? Only a definite "gone" counts: 404, or 410 —
 * which is what OnlineJobs.ph returns for expired posts. Bot walls (403,
 * 429, LinkedIn's 999) and timeouts are treated as alive so we never hide
 * a job we simply couldn't reach.
 */
export async function isListingGone(url: string): Promise<boolean> {
  const probe = async (method: "HEAD" | "GET") => {
    const res = await fetch(url, { method, redirect: "follow", headers: { "user-agent": UA, accept: "text/html" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.body && method === "GET") await res.body.cancel().catch(() => {});
    return res.status;
  };
  try {
    let status = await probe("HEAD");
    if (status === 405 || status === 501) status = await probe("GET");
    return status === 404 || status === 410;
  } catch {
    return false;
  }
}

/**
 * Checks the given jobs' URLs (skipping ones checked in the last day),
 * stamps checked_at, and marks every row sharing an expired fingerprint.
 * Returns the ids that turned out to be gone.
 */
export async function markExpired(candidates: Array<{ id: string; url: string; fingerprint: string; checkedAt: Date | null; expiredAt: Date | null }>): Promise<Set<string>> {
  const gone = new Set<string>();
  const due = candidates.filter((j) => !j.expiredAt && (!j.checkedAt || Date.now() - j.checkedAt.getTime() > RECHECK_AFTER_MS));
  if (!due.length) return gone;
  const results = await Promise.all(due.map(async (j) => [j, await isListingGone(j.url)] as const));
  const now = new Date();
  const goneFps = results.filter(([, g]) => g).map(([j]) => j.fingerprint);
  const aliveIds = results.filter(([, g]) => !g).map(([j]) => j.id);
  if (aliveIds.length) await db.update(jobs).set({ checkedAt: now }).where(inArray(jobs.id, aliveIds));
  if (goneFps.length) {
    await db.update(jobs).set({ checkedAt: now, expiredAt: now }).where(inArray(jobs.fingerprint, goneFps));
    for (const [j, g] of results) if (g) gone.add(j.id);
    logger.info({ count: goneFps.length }, "marked expired listings");
  }
  return gone;
}
