import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { validator } from "hono-openapi";
import { z } from "zod";
import { db } from "@/db/client";
import { resumes, users } from "@/db/schema";
import { Me, UserDefaults } from "@/contracts";
import { route } from "@/lib/openapi";
import { firebaseAuth } from "@/services/auth";
import { deleteObject } from "@/services/storage";
import { logger } from "@/lib/logger";
import { listAutomations, toAutomation } from "@/routes/automations";
import { planLimits, searchesUsed } from "@/lib/plan";
import type { AppEnv } from "@/middleware";

export async function toMe(u: typeof users.$inferSelect): Promise<Me> {
  const autos = await listAutomations(u.id);
  const limits = planLimits(u);
  const used = await searchesUsed(u.id, limits.since);

  const renewsAt = u.renewsAt?.toISOString() ?? null;
  const source = (u.planSource as "none" | "voucher" | "revenuecat" | "manual") ?? "none";
  const entitlementActive = source === "revenuecat" && u.plan === "pro" && (!u.renewsAt || u.renewsAt.getTime() > Date.now());

  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    defaults: UserDefaults.parse(u.defaults ?? {}),
    sheetId: u.sheetId,
    subscription: {
      plan: u.plan as "free" | "pro",
      searchesUsed: used,
      searchLimit: limits.searchLimit,
      period: limits.period,
      renewsAt,
      source,
      entitlementActive,
    },
    profile: {},
    automations: autos.map(toAutomation),
    settings: {},
  };
}

export const me = new Hono<AppEnv>()
  .get("/", route({ tag: "Me", summary: "Current user and saved defaults", ok: { schema: Me } }), async (c) => c.json(await toMe(c.get("user"))))

  .post(
    "/",
    route({
      tag: "Me",
      summary: "Initialize or update user profile and defaults",
      ok: { schema: Me },
      errors: { 400: "Invalid field" },
    }),
    validator(
      "json",
      z
        .object({
          displayName: z.string().optional(),
          defaults: UserDefaults.partial().optional(),
        })
        .optional(),
    ),
    async (c) => {
      const body = c.req.valid("json") ?? {};
      const user = c.get("user");
      const current = UserDefaults.parse(user.defaults ?? {});
      const nextDefaults = body.defaults ? { ...current, ...body.defaults } : current;
      const [updated] = await db
        .update(users)
        .set({
          defaults: nextDefaults,
          ...(body.displayName ? { displayName: body.displayName } : {}),
        })
        .where(eq(users.id, user.id))
        .returning();
      return c.json(await toMe(updated ?? user));
    },
  )

  .patch(
    "/",
    route({ tag: "Me", summary: "Update default interests, sites and limits", ok: { schema: Me }, errors: { 400: "Invalid field" } }),
    validator("json", UserDefaults.partial()),
    async (c) => {
      const patch = c.req.valid("json");
      const current = UserDefaults.parse(c.get("user").defaults ?? {});
      const [updated] = await db.update(users).set({ defaults: { ...current, ...patch } }).where(eq(users.id, c.get("user").id)).returning();
      return c.json(await toMe(updated!));
    },
  )

  .delete(
    "/",
    route({
      tag: "Me",
      summary: "Delete the account",
      description: "Removes Postgres rows (cascades to resumes, runs, jobs), Storage objects and the Firebase user. Irreversible.",
      noContent: true,
    }),
    async (c) => {
      const user = c.get("user");
      const files = await db.select({ storagePath: resumes.storagePath }).from(resumes).where(eq(resumes.userId, user.id));
      const validPaths = files.map(f => f.storagePath).filter((p): p is string => p !== null);
      await Promise.allSettled(validPaths.map((p) => deleteObject(p)));
      await db.delete(users).where(eq(users.id, user.id));
      await firebaseAuth.deleteUser(user.firebaseUid).catch((err) => logger.warn({ err, uid: user.firebaseUid }, "firebase deleteUser failed"));
      logger.info({ userId: user.id }, "account deleted");
      return c.body(null, 204);
    },
  );
