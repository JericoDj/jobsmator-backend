import { afterEach, describe, expect, mock, test } from "bun:test";

// `@/lib/env` is a module-level `EnvSchema.parse(process.env)` — whichever test
// file imports it FIRST in this process wins, and other files (e.g.
// engine.test.ts) don't set REVENUECAT_*. So mock the module outright rather
// than racing on process.env; it also means we don't need real Firebase/DB env.
mock.module("@/lib/env", () => ({
  env: {
    PORT: 3001,
    NODE_ENV: "test",
    DATABASE_URL: "postgres://x:x@localhost:5432/x",
    N8N_BASE_URL: "https://n8n.test",
    N8N_WEBHOOK_SECRET: "s",
    OPENROUTER_MODEL: "test-model",
    AI_MESSAGES_PER_DAY_FREE: 30,
    AI_MESSAGES_PER_DAY_PRO: 300,
    FIREBASE_SERVICE_ACCOUNT: "e30=",
    FIREBASE_STORAGE_BUCKET: "b",
    WEB_ORIGIN: "http://localhost:3000",
    RUNS_PER_HOUR: 100,
    ENGINE_TIMEOUT_MS: 120000,
    API_PUBLIC_URL: "http://localhost:3001",
    CANVA_SCOPES: "profile:read design:meta:read design:content:write asset:write",
    CANVA_APP_RETURN_URL: "jobsmator://integrations/canva",
    REVENUECAT_WEBHOOK_SECRET: "whsec_test",
    REVENUECAT_SECRET_KEY: "sk_test",
  },
}));

const { decideFromWebhook, verifyWebhookAuth, fetchProEntitlement } = await import("@/services/revenuecat");
const { ApiError } = await import("@/lib/errors");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(status: number, body: unknown) {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
}

const baseEvent = {
  app_user_id: "firebase-uid-1",
  entitlement_ids: ["pro"] as string[] | null,
  expiration_at_ms: Date.now() + 24 * 60 * 60 * 1000,
  environment: "SANDBOX" as const,
  id: "evt_1",
};

describe("decideFromWebhook — plan transitions per event type", () => {
  for (const type of ["INITIAL_PURCHASE", "RENEWAL", "UNCANCELLATION", "PRODUCT_CHANGE", "NON_RENEWING_PURCHASE", "TRANSFER"]) {
    test(`${type} with active pro entitlement → pro`, () => {
      const decision = decideFromWebhook({ ...baseEvent, type });
      expect(decision).toEqual({ plan: "pro", renewsAt: new Date(baseEvent.expiration_at_ms) });
    });

    test(`${type} without pro in entitlement_ids → no-op`, () => {
      const decision = decideFromWebhook({ ...baseEvent, type, entitlement_ids: [] });
      expect(decision).toBeNull();
    });

    test(`${type} with an already-expired entitlement → no-op (not a downgrade)`, () => {
      const decision = decideFromWebhook({ ...baseEvent, type, expiration_at_ms: Date.now() - 1000 });
      expect(decision).toBeNull();
    });
  }

  test("EXPIRATION → free", () => {
    const decision = decideFromWebhook({ ...baseEvent, type: "EXPIRATION", entitlement_ids: [], expiration_at_ms: Date.now() - 1000 });
    expect(decision).toEqual({ plan: "free", renewsAt: null });
  });

  test("CANCELLATION while still within the paid period → no-op", () => {
    const decision = decideFromWebhook({ ...baseEvent, type: "CANCELLATION" });
    expect(decision).toBeNull();
  });

  test("CANCELLATION once expired → free", () => {
    const decision = decideFromWebhook({ ...baseEvent, type: "CANCELLATION", expiration_at_ms: Date.now() - 1000 });
    expect(decision).toEqual({ plan: "free", renewsAt: null });
  });

  test("BILLING_ISSUE while entitlement still active → no-op", () => {
    const decision = decideFromWebhook({ ...baseEvent, type: "BILLING_ISSUE" });
    expect(decision).toBeNull();
  });

  test("BILLING_ISSUE once the entitlement has expired → free", () => {
    const decision = decideFromWebhook({ ...baseEvent, type: "BILLING_ISSUE", expiration_at_ms: Date.now() - 1000 });
    expect(decision).toEqual({ plan: "free", renewsAt: null });
  });

  test("unknown event type → no-op", () => {
    expect(decideFromWebhook({ ...baseEvent, type: "TEST" })).toBeNull();
  });
});

describe("verifyWebhookAuth", () => {
  test("accepts the bare secret", () => expect(verifyWebhookAuth("whsec_test")).toBe(true));
  test("accepts a Bearer-prefixed secret", () => expect(verifyWebhookAuth("Bearer whsec_test")).toBe(true));
  test("rejects the wrong secret", () => expect(verifyWebhookAuth("Bearer nope")).toBe(false));
  test("rejects a missing header", () => expect(verifyWebhookAuth(undefined)).toBe(false));
});

describe("fetchProEntitlement", () => {
  test("active entitlement", async () => {
    mockFetch(200, { subscriber: { entitlements: { pro: { expires_date: new Date(Date.now() + 86_400_000).toISOString(), product_identifier: "pro_monthly", purchase_date: "2026-01-01T00:00:00Z" } } } });
    const ent = await fetchProEntitlement("firebase-uid-1");
    expect(ent.active).toBe(true);
    expect(ent.expiresAt).not.toBeNull();
  });

  test("no pro entitlement on the subscriber", async () => {
    mockFetch(200, { subscriber: { entitlements: {} } });
    const ent = await fetchProEntitlement("firebase-uid-1");
    expect(ent.active).toBe(false);
    expect(ent.expiresAt).toBeNull();
  });

  test("expired entitlement reads as inactive", async () => {
    mockFetch(200, { subscriber: { entitlements: { pro: { expires_date: new Date(Date.now() - 86_400_000).toISOString(), product_identifier: "pro_monthly", purchase_date: "2026-01-01T00:00:00Z" } } } });
    const ent = await fetchProEntitlement("firebase-uid-1");
    expect(ent.active).toBe(false);
  });

  test("RevenueCat error response → integration_unavailable", async () => {
    mockFetch(500, { message: "boom" });
    await expect(fetchProEntitlement("firebase-uid-1")).rejects.toMatchObject({ code: "integration_unavailable" } satisfies Partial<InstanceType<typeof ApiError>>);
  });
});

// ---------------------------------------------------------------------------
// POST /webhooks/revenuecat — full route, with the DB layer mocked out.
// ---------------------------------------------------------------------------

type FakeUser = { id: string; firebaseUid: string; plan: "free" | "pro"; renewsAt: Date | null; planSource: string };

// A single mutable "DB" the mock reads/writes — mock.module only needs to run
// once, before `@/routes/webhooks` (and its `@/db/client` import) is first
// loaded; each test just resets `currentUsers`/`updates` before making requests.
let currentUsers: FakeUser[] = [];
let updates: Array<{ id: string; set: any }> = [];

mock.module("@/db/client", () => ({
  db: {
    select: () => ({
      from: () => ({
        // `where` isn't parsed — the mock just returns whichever single user this test set up.
        where: async () => (currentUsers.length ? [currentUsers[0]] : []),
      }),
    }),
    update: () => ({
      set: (set: any) => ({
        where: async () => {
          updates.push({ id: currentUsers[0]?.id ?? "", set });
          if (currentUsers[0]) Object.assign(currentUsers[0], set);
          return undefined;
        },
      }),
    }),
  },
}));

const { webhookRoutes } = await import("@/routes/webhooks");
const { Hono } = await import("hono");
const { errorHandler } = await import("@/lib/errors");

// Mirror how `src/index.ts` mounts it: with the shared `onError` handler, so an
// ApiError (e.g. the auth check) turns into the JSON response clients see.
const testApp = new Hono().onError(errorHandler).route("/", webhookRoutes);

function loadWebhookApp(users: FakeUser[]) {
  currentUsers = users;
  updates = [];
  return { app: testApp, updates };
}

const AUTH = { authorization: "Bearer whsec_test" };

describe("POST /webhooks/revenuecat", () => {
  test("rejects a missing/bad secret", async () => {
    const { app } = loadWebhookApp([{ id: "u1", firebaseUid: "firebase-uid-1", plan: "free", renewsAt: null, planSource: "none" }]);
    const res = await app.request("/revenuecat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify({ event: { ...baseEvent, type: "INITIAL_PURCHASE" } }),
    });
    expect(res.status).toBe(401);
  });

  test("unknown app_user_id → 200, no update", async () => {
    const { app, updates } = loadWebhookApp([]);
    const res = await app.request("/revenuecat", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({ event: { ...baseEvent, type: "INITIAL_PURCHASE" } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(updates.length).toBe(0);
  });

  test("INITIAL_PURCHASE grants pro and records the RevenueCat source", async () => {
    const user: FakeUser = { id: "u1", firebaseUid: "firebase-uid-1", plan: "free", renewsAt: null, planSource: "none" };
    const { app, updates } = loadWebhookApp([user]);
    const res = await app.request("/revenuecat", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({ event: { ...baseEvent, type: "INITIAL_PURCHASE" } }),
    });
    expect(res.status).toBe(200);
    expect(updates.length).toBe(1);
    expect(updates[0]!.set).toMatchObject({ plan: "pro", planSource: "revenuecat" });
    expect(user.plan).toBe("pro");
  });

  test("EXPIRATION downgrades to free", async () => {
    const user: FakeUser = { id: "u1", firebaseUid: "firebase-uid-1", plan: "pro", renewsAt: new Date(), planSource: "revenuecat" };
    const { app, updates } = loadWebhookApp([user]);
    const res = await app.request("/revenuecat", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({ event: { ...baseEvent, type: "EXPIRATION", entitlement_ids: [], expiration_at_ms: Date.now() - 1000 } }),
    });
    expect(res.status).toBe(200);
    expect(updates.length).toBe(1);
    expect(updates[0]!.set).toMatchObject({ plan: "free", renewsAt: null });
    expect(user.plan).toBe("free");
  });

  test("EXPIRATION leaves a voucher-granted Pro alone", async () => {
    const user: FakeUser = { id: "u1", firebaseUid: "firebase-uid-1", plan: "pro", renewsAt: new Date(Date.now() + 86_400_000), planSource: "voucher" };
    const { app, updates } = loadWebhookApp([user]);
    const res = await app.request("/revenuecat", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({ event: { ...baseEvent, type: "EXPIRATION", entitlement_ids: [], expiration_at_ms: Date.now() - 1000 } }),
    });
    expect(res.status).toBe(200);
    expect(updates.length).toBe(0);
    expect(user.plan).toBe("pro");
  });

  test("a no-op event (e.g. CANCELLATION mid-period) returns 200 without writing", async () => {
    const user: FakeUser = { id: "u1", firebaseUid: "firebase-uid-1", plan: "pro", renewsAt: new Date(Date.now() + 86_400_000), planSource: "revenuecat" };
    const { app, updates } = loadWebhookApp([user]);
    const res = await app.request("/revenuecat", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({ event: { ...baseEvent, type: "CANCELLATION" } }),
    });
    expect(res.status).toBe(200);
    expect(updates.length).toBe(0);
  });

  test("idempotent: replaying the same event twice yields the same state", async () => {
    const user: FakeUser = { id: "u1", firebaseUid: "firebase-uid-1", plan: "free", renewsAt: null, planSource: "none" };
    const { app, updates } = loadWebhookApp([user]);
    const payload = JSON.stringify({ event: { ...baseEvent, type: "RENEWAL" } });
    const res1 = await app.request("/revenuecat", { method: "POST", headers: { "content-type": "application/json", ...AUTH }, body: payload });
    const res2 = await app.request("/revenuecat", { method: "POST", headers: { "content-type": "application/json", ...AUTH }, body: payload });
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(updates.length).toBe(2);
    expect(user.plan).toBe("pro");
  });
});
