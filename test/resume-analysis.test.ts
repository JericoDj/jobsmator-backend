import { describe, expect, test } from "bun:test";

// Minimal env so `@/lib/env` and Firebase Admin init succeed at import time
// (mirrors the pattern in engine.test.ts / errors.test.ts).
process.env.DATABASE_URL ??= "postgres://x:x@localhost:5432/x";
process.env.N8N_BASE_URL ??= "https://n8n.test";
process.env.N8N_WEBHOOK_SECRET ??= "s";
process.env.FIREBASE_SERVICE_ACCOUNT ??= Buffer.from(
  JSON.stringify({
    project_id: "p",
    client_email: "a@b.c",
    private_key: "-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEAu\n-----END PRIVATE KEY-----\n",
  }),
).toString("base64");
process.env.FIREBASE_STORAGE_BUCKET ??= "b";

const { normalizeAnalysis, normalizeTags } = await import("@/services/resume-analysis");
const { escapeLike, rankMatches } = await import("@/routes/resumes");
const { ResumeAnalysis } = await import("@/contracts");

describe("normalizeTags", () => {
  test("trims, lowercases, dedupes and drops overlong entries", () => {
    const out = normalizeTags(["Flutter", " Firebase ", "flutter", "x".repeat(41), "", 42, "Dart"], 25);
    expect(out).toEqual(["flutter", "firebase", "dart"]);
  });

  test("caps at max", () => {
    const out = normalizeTags(["a", "b", "c", "d"], 2);
    expect(out).toEqual(["a", "b"]);
  });

  test("ignores non-array input", () => {
    expect(normalizeTags(null, 5)).toEqual([]);
    expect(normalizeTags("flutter", 5)).toEqual([]);
  });
});

describe("normalizeAnalysis + ResumeAnalysis schema", () => {
  test("shapes and validates a well-formed model reply", () => {
    const raw = {
      summary: "A mid-level mobile developer with a Flutter focus.",
      headline: "Mid-level Flutter developer, 3 yrs",
      seniority: "mid",
      strengths: ["Ships fast", "Strong UI sense"],
      fixes: ["Quantify impact with numbers"],
      skills: ["Flutter", "Firebase", "Dart", "flutter"],
      roles: ["Flutter Developer", "Mobile Engineer"],
      tags: ["flutter", "firebase", "mobile", "Flutter"],
      industries: ["Software & IT"],
    };
    const parsed = ResumeAnalysis.safeParse(normalizeAnalysis(raw));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.skills).toEqual(["flutter", "firebase", "dart"]);
      expect(parsed.data.tags).toEqual(["flutter", "firebase", "mobile"]);
      expect(parsed.data.seniority).toBe("mid");
    }
  });

  test("caps oversized arrays before validating", () => {
    const raw = {
      summary: "s",
      headline: "h",
      seniority: "senior",
      strengths: Array.from({ length: 20 }, (_, i) => `strength ${i}`),
      fixes: Array.from({ length: 20 }, (_, i) => `fix ${i}`),
      skills: Array.from({ length: 60 }, (_, i) => `skill${i}`),
      roles: Array.from({ length: 20 }, (_, i) => `role ${i}`),
      tags: Array.from({ length: 60 }, (_, i) => `tag${i}`),
      industries: Array.from({ length: 20 }, (_, i) => `industry ${i}`),
    };
    const parsed = ResumeAnalysis.safeParse(normalizeAnalysis(raw));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.strengths.length).toBe(5);
      expect(parsed.data.fixes.length).toBe(5);
      expect(parsed.data.skills.length).toBe(25);
      expect(parsed.data.roles.length).toBe(8);
      expect(parsed.data.tags.length).toBe(20);
      expect(parsed.data.industries.length).toBe(5);
    }
  });

  test("rejects an unknown seniority value", () => {
    const raw = { summary: "s", headline: "h", seniority: "junior-ish", strengths: [], fixes: [], skills: [], roles: [], tags: [], industries: [] };
    const parsed = ResumeAnalysis.safeParse(normalizeAnalysis(raw));
    expect(parsed.success).toBe(false);
  });

  test("tolerates a malformed reply (missing fields, wrong types) without throwing", () => {
    const parsed = ResumeAnalysis.safeParse(normalizeAnalysis({ strengths: "not an array", skills: null }));
    expect(parsed.success).toBe(false); // seniority missing — still a clean safeParse failure, not a throw
  });
});

describe("escapeLike", () => {
  test("escapes %, _ and backslash", () => {
    expect(escapeLike("c++_dev%")).toBe("c++\\_dev\\%");
    expect(escapeLike("a\\b")).toBe("a\\\\b");
  });
});

describe("rankMatches", () => {
  const rows = [
    { id: "a", title: "Flutter Developer", industry: "Software & IT", matchedInterest: "flutter", score: 60, userId: "other" },
    { id: "b", title: "Senior Flutter & Firebase Engineer", industry: "Software & IT", matchedInterest: "flutter", score: 90, userId: "other" },
    { id: "c", title: "Backend Engineer", industry: "Software & IT", matchedInterest: "", score: 95, userId: "other" },
    { id: "d", title: "Flutter Developer", industry: "Software & IT", matchedInterest: "flutter", score: 60, userId: "me" },
  ];
  const tags = ["flutter", "firebase"];

  test("ranks by distinct tags hit desc, then score desc", () => {
    const ranked = rankMatches(rows, tags, "someone-else");
    // "b" hits both tags; "a" and "d" hit one each (tied score, order settled by ownership elsewhere); "c" hits none.
    expect(ranked[0]!.id).toBe("b");
    expect(ranked.map((r) => r.id).sort()).toEqual(["a", "b", "d"]);
  });

  test("drops candidates that hit no tags", () => {
    const ranked = rankMatches(rows, tags, "me");
    expect(ranked.find((r) => r.id === "c")).toBeUndefined();
  });

  test("matches whole words only and ignores tags under 3 characters", () => {
    const pool = [
      { id: "m", title: "Product Manager", industry: "", matchedInterest: "", score: 80, userId: "other" },
      { id: "g", title: "Go Developer", industry: "", matchedInterest: "", score: 70, userId: "other" },
      { id: "cpp", title: "C++ Engineer", industry: "", matchedInterest: "", score: 70, userId: "other" },
    ];
    // "go" is too short to count at all; "c++" matches literally, not inside "engineer"; "manager" is a whole word.
    expect(rankMatches(pool, ["go", "c++", "manager"], "me").map((r) => r.id)).toEqual(["m", "cpp"]);
    expect(rankMatches(pool, ["c"], "me")).toEqual([]);
  });

  test("own jobs win ties on tagsHit and score", () => {
    const ranked = rankMatches(rows, tags, "me");
    // "a" and "d" both hit 1 tag ("flutter") at score 60; "d" is the caller's own job.
    const aIdx = ranked.findIndex((r) => r.id === "a");
    const dIdx = ranked.findIndex((r) => r.id === "d");
    expect(dIdx).toBeLessThan(aIdx);
  });

  test("is case-insensitive and tolerates an empty tag list", () => {
    expect(rankMatches(rows, [], "me")).toEqual([]);
    const ranked = rankMatches(rows, ["FLUTTER"], "me");
    expect(ranked.length).toBeGreaterThan(0);
  });
});
