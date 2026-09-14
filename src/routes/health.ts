import { Hono } from "hono";
import { sql } from "@/db/client";

export const health = new Hono().get("/", async (c) => {
  let dbOk = false;
  try {
    await sql`select 1`;
    dbOk = true;
  } catch {}
  return c.json({ ok: dbOk, db: dbOk, version: process.env.npm_package_version ?? "0.1.0" }, dbOk ? 200 : 503);
});
