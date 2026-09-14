import { afterEach, describe, expect, test } from "bun:test";
import { ApiError } from "@/lib/errors";

// Minimal env so `@/lib/env` parses at import time.
process.env.DATABASE_URL ??= "postgres://x:x@localhost:5432/x";
process.env.N8N_BASE_URL ??= "https://n8n.test";
process.env.N8N_WEBHOOK_SECRET ??= "s";
process.env.FIREBASE_SERVICE_ACCOUNT ??= "e30=";
process.env.FIREBASE_STORAGE_BUCKET ??= "b";

const { runEngine } = await import("@/services/engine");

const input = {
  resume_url: "https://files.test/r.pdf", user_id: "u1", job_interests: ["Flutter Developer"],
  jobsites: ["LinkedIn"], jobs_per_site: 10,
};
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockFetch(status: number, body: unknown) {
  globalThis.fetch = (async (_url: any, init?: RequestInit) => {
    mockFetch.last = init;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
mockFetch.last = undefined as RequestInit | undefined;

describe("runEngine", () => {
  test("sends the shared secret and parses a good response", async () => {
    mockFetch(200, { ok: true, jobs: [], stats: { recommended: 0 } });
    const res = await runEngine(input);
    expect(res.jobs).toEqual([]);
    expect((mockFetch.last?.headers as Record<string, string>)["x-jobsmator-key"]).toBe("s");
  });

  test("maps 422 to resume_unreadable", async () => {
    mockFetch(422, { error: "resume_unreadable" });
    await expect(runEngine(input)).rejects.toMatchObject({ code: "resume_unreadable" } satisfies Partial<ApiError>);
  });

  test("maps 400 to invalid_request with details", async () => {
    mockFetch(400, { error: "invalid_request", details: ["job_interests required"] });
    await expect(runEngine(input)).rejects.toMatchObject({ code: "invalid_request", details: ["job_interests required"] });
  });

  test("maps 5xx and network failures to engine_unavailable", async () => {
    mockFetch(502, "bad gateway");
    await expect(runEngine(input)).rejects.toMatchObject({ code: "engine_unavailable" });
    globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    await expect(runEngine(input)).rejects.toMatchObject({ code: "engine_unavailable" });
  });
});
