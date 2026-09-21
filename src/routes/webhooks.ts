import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { validator } from "hono-openapi";
import { z } from "zod";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { route } from "@/lib/openapi";
import { ApiError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { decideFromWebhook, verifyWebhookAuth, type RevenueCatEvent } from "@/services/revenuecat";
import type { AppEnv } from "@/middleware";

// RevenueCat's payload is loosely typed on their end too — validate just enough to act on it safely.
const RevenueCatEventBody = z.object({
  api_version: z.string().optional(),
  event: z.object({
    type: z.string(),
    app_user_id: z.string(),
    original_app_user_id: z.string().optional(),
    entitlement_ids: z.array(z.string()).nullable().optional(),
    expiration_at_ms: z.number().nullable().optional(),
    environment: z.enum(["SANDBOX", "PRODUCTION"]).optional(),
    id: z.string().optional(),
  }),
});

export const webhookRoutes = new Hono<AppEnv>().post(
  "/revenuecat",
  route({
    tag: "Webhooks",
    summary: "RevenueCat subscription events",
    description:
      "Unauthenticated except for a shared-secret `Authorization` header we configure in the RevenueCat dashboard. " +
      "Untrusted input — validated, never trusted blindly. Idempotent; always returns 200 quickly so RevenueCat doesn't retry.",
    auth: false,
    ok: { schema: z.object({ ok: z.boolean() }) },
    errors: { 401: "Bad or missing webhook secret" },
  }),
  validator("json", RevenueCatEventBody),
  async (c) => {
    if (!verifyWebhookAuth(c.req.header("authorization"))) {
      throw new ApiError("unauthenticated", "Bad webhook secret.");
    }

    const body = c.req.valid("json") as RevenueCatEvent;
    const { event } = body;
    const appUserId = event.app_user_id;

    const [user] = await db.select().from(users).where(eq(users.firebaseUid, appUserId));
    if (!user) {
      logger.warn({ appUserId, type: event.type }, "revenuecat webhook: unknown user");
      return c.json({ ok: true });
    }

    const decision = decideFromWebhook(event);
    if (!decision) {
      logger.info({ appUserId, type: event.type }, "revenuecat webhook: no-op");
      return c.json({ ok: true });
    }
    // A lapsed store subscription must not take away Pro that came from a voucher or was set by hand.
    if (decision.plan === "free" && user.plan === "pro" && user.planSource !== "revenuecat") {
      logger.info({ appUserId, type: event.type, planSource: user.planSource }, "revenuecat webhook: plan not owned by revenuecat, no-op");
      return c.json({ ok: true });
    }

    // Idempotent: setting the same plan/renewsAt again is harmless, and a stale
    // out-of-order event can only ever set what RevenueCat currently reports.
    await db
      .update(users)
      .set({ plan: decision.plan, renewsAt: decision.renewsAt, planSource: "revenuecat", planUpdatedAt: new Date() })
      .where(eq(users.id, user.id));

    logger.info({ userId: user.id, type: event.type, plan: decision.plan }, "revenuecat webhook applied");
    return c.json({ ok: true });
  },
);
