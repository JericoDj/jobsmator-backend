/**
 * Labels every job row that has no industry yet.
 *
 *   bun run industry:backfill            # label rows with industry = ''
 *   bun run industry:backfill -- --all   # relabel every row (after changing the rules)
 *
 * Needs DATABASE_URL (Railway: `railway run bun run industry:backfill`).
 */
import { eq, sql as dsql } from "drizzle-orm";
import { db, sql } from "@/db/client";
import { jobs } from "@/db/schema";
import { classifyIndustry } from "@/lib/industry";

const all = process.argv.includes("--all");
const rows = await db
  .select({ id: jobs.id, title: jobs.title, company: jobs.company, industry: jobs.industry })
  .from(jobs)
  .where(all ? dsql`true` : eq(jobs.industry, ""));

console.log(`${rows.length} job(s) to label${all ? " (all)" : ""}`);
const counts: Record<string, number> = {};
let changed = 0;
for (const r of rows) {
  const industry = classifyIndustry(r.title, r.company);
  counts[industry] = (counts[industry] ?? 0) + 1;
  if (industry === r.industry) continue;
  await db.update(jobs).set({ industry }).where(eq(jobs.id, r.id));
  changed++;
}
console.table(Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([industry, n]) => ({ industry, n })));
console.log(`updated ${changed} row(s)`);
await sql.end();
