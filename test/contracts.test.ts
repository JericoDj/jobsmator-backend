import { describe, expect, test } from "bun:test";
import { CreateRunBody, EngineResponse, JOB_SITES, UserDefaults } from "@/contracts";

describe("contracts", () => {
  test("UserDefaults fills sensible defaults", () => {
    const d = UserDefaults.parse({});
    expect(d.sites).toEqual([...JOB_SITES]);
    expect(d.jobsPerSite).toBe(20);
    expect(d.minScore).toBe(60);
    expect(d.location).toBe("Philippines");
  });

  test("CreateRunBody caps interests at 5 and requires a site", () => {
    const base = { resumeId: "3f2b1a1e-0000-4000-8000-000000000000", sites: ["LinkedIn"] };
    expect(CreateRunBody.safeParse({ ...base, interests: ["a", "b", "c", "d", "e", "f"] }).success).toBe(false);
    expect(CreateRunBody.safeParse({ ...base, interests: [] }).success).toBe(false);
    expect(CreateRunBody.safeParse({ ...base, interests: ["Flutter Developer"], sites: [] }).success).toBe(false);
    expect(CreateRunBody.parse({ ...base, interests: ["Flutter Developer"] }).jobsPerSite).toBe(20);
  });

  test("EngineResponse tolerates a sparse engine payload", () => {
    const r = EngineResponse.parse({ ok: true, jobs: [{ rank: 1, score: 91, tier: "strong", title: "Dev", url: "https://x.y", site: "Kalibrr", fingerprint: "x-dev" }] });
    expect(r.jobs[0]?.redFlags).toEqual([]);
    expect(r.jobs[0]?.company).toBe("");
    expect(r.stats).toBeUndefined();
  });
});
