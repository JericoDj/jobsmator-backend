import { Hono } from "hono";
import { z } from "zod";
import { sql } from "@/db/client";
import { route } from "@/lib/openapi";

const HealthBody = z.object({ ok: z.boolean(), db: z.boolean(), version: z.string() });

export const health = new Hono().get(
  "/",
  route({ tag: "System", summary: "Liveness + database check", ok: { schema: HealthBody }, auth: false }),
  async (c) => {
    let dbOk = false;
    try {
      await sql`select 1`;
      dbOk = true;
    } catch {}
    return c.json({ ok: dbOk, db: dbOk, version: "0.1.0" }, dbOk ? 200 : 503);
  },
);
