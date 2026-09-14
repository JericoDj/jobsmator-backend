import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { z } from "zod";

process.env.DATABASE_URL ??= "postgres://x:x@localhost:5432/x";
process.env.N8N_BASE_URL ??= "https://n8n.test";
process.env.N8N_WEBHOOK_SECRET ??= "s";
process.env.FIREBASE_SERVICE_ACCOUNT ??= "e30=";
process.env.FIREBASE_STORAGE_BUCKET ??= "b";
const { ApiError, errorHandler } = await import("@/lib/errors");

const app = new Hono()
  .onError(errorHandler)
  .get("/api", () => { throw new ApiError("too_many_runs", "Slow down."); })
  .get("/zod", () => { z.object({ a: z.number() }).parse({ a: "x" }); return new Response("never"); })
  .get("/boom", () => { throw new Error("kaboom"); });

describe("errorHandler", () => {
  test("ApiError → its status and code", async () => {
    const res = await app.request("/api");
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "too_many_runs", message: "Slow down." });
  });
  test("ZodError → 400 invalid_request with issues", async () => {
    const res = await app.request("/zod");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_request");
    expect(Array.isArray(body.details)).toBe(true);
  });
  test("unknown error → 500 without leaking the message", async () => {
    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    expect((await res.json()).message).not.toContain("kaboom");
  });
});
