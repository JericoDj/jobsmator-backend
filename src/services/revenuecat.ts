import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { ApiError } from "@/lib/errors";

/**
 * RevenueCat webhook payload — https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields
 * We only read the fields we act on; everything else is ignored.
 */
export type RevenueCatEvent = {
  api_version: string;
  event: {
    type: string;
    app_user_id: string;
    original_app_user_id?: string;
    entitlement_ids: string[] | null;
    expiration_at_ms: number | null;
    environment: "SANDBOX" | "PRODUCTION";
    id: string;
    [key: string]: unknown;
  };
};

/** Event types that grant/extend the `pro` entitlement when it's in `entitlement_ids`. */
const GRANT_EVENTS = new Set([
  "INITIAL_PURCHASE",
  "RENEWAL",
  "UNCANCELLATION",
  "PRODUCT_CHANGE",
  "NON_RENEWING_PURCHASE",
  "TRANSFER",
]);

/** Event types that can downgrade the user, subject to expiration checks below. */
const REVOKE_EVENTS = new Set(["EXPIRATION", "CANCELLATION", "BILLING_ISSUE"]);

export type PlanDecision = { plan: "free" | "pro"; renewsAt: Date | null } | null;

/**
 * Decides the plan transition for a webhook event. Returns null when the
 * event isn't one we act on (so the caller can no-op + 200).
 */
export function decideFromWebhook(event: RevenueCatEvent["event"]): PlanDecision {
  const hasPro = (event.entitlement_ids ?? []).includes("pro");
  const expiresAt = event.expiration_at_ms ? new Date(event.expiration_at_ms) : null;
  const expired = expiresAt ? expiresAt.getTime() <= Date.now() : false;

  if (GRANT_EVENTS.has(event.type)) {
    if (hasPro && !expired) return { plan: "pro", renewsAt: expiresAt };
    // Entitlement isn't actually active — treat as a no-op rather than downgrading on a stray event.
    return null;
  }
  if (REVOKE_EVENTS.has(event.type)) {
    if (event.type === "BILLING_ISSUE") {
      // Only downgrade a billing issue once the entitlement has actually lapsed.
      return expired ? { plan: "free", renewsAt: null } : null;
    }
    // EXPIRATION / CANCELLATION: downgrade unless RevenueCat says the entitlement is still active (e.g. cancelled but not yet expired).
    if (hasPro && !expired) return null;
    return { plan: "free", renewsAt: null };
  }
  return null;
}

export type Entitlement = { active: boolean; expiresAt: Date | null };

/** GET /v1/subscribers/{app_user_id} — reads the `pro` entitlement straight from RevenueCat. */
export async function fetchProEntitlement(appUserId: string): Promise<Entitlement> {
  if (!env.REVENUECAT_SECRET_KEY) throw new ApiError("integration_unavailable", "Subscription sync is not configured.");

  const res = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(appUserId)}`, {
    headers: { Authorization: `Bearer ${env.REVENUECAT_SECRET_KEY}` },
  });
  if (!res.ok) {
    logger.warn({ status: res.status, appUserId }, "revenuecat subscriber lookup failed");
    throw new ApiError("integration_unavailable", "Could not reach RevenueCat.");
  }
  const data = (await res.json()) as { subscriber?: { entitlements?: Record<string, { expires_date: string | null }> } };
  const pro = data.subscriber?.entitlements?.pro;
  if (!pro) return { active: false, expiresAt: null };
  const expiresAt = pro.expires_date ? new Date(pro.expires_date) : null;
  const active = !expiresAt || expiresAt.getTime() > Date.now();
  return { active, expiresAt };
}

/** Verifies the webhook `Authorization` header against `REVENUECAT_WEBHOOK_SECRET`. Accepts `Bearer <secret>` or the bare secret. */
export function verifyWebhookAuth(header: string | undefined): boolean {
  if (!env.REVENUECAT_WEBHOOK_SECRET) return false;
  if (!header) return false;
  const value = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : header);
  const secret = Buffer.from(env.REVENUECAT_WEBHOOK_SECRET);
  return value.length === secret.length && timingSafeEqual(value, secret);
}
