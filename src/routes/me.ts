import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { validator } from "hono-openapi";
import { db } from "@/db/client";
import { resumes, users } from "@/db/schema";
import { Me, UserDefaults } from "@/contracts";
import { route } from "@/lib/openapi";
import { firebaseAuth } from "@/services/auth";
import { deleteObject } from "@/services/storage";
import { logger } from "@/lib/logger";
import type { AppEnv } from "@/middleware";

function toMe(u: typeof users.$inferSelect): Me {
  return { id: u.id, email: u.email, displayName: u.displayName, defaults: UserDefaults.parse(u.defaults ?? {}), sheetId: u.sheetId };
}

export const me = new Hono<AppEnv>()
  .get("/", route({ tag: "Me", summary: "Current user and saved defaults", ok: { schema: Me } }), (c) => c.json(toMe(c.get("user"))))

  .patch(
    "/",
    route({ tag: "Me", summary: "Update default interests, sites and limits", ok: { schema: Me }, errors: { 400: "Invalid field" } }),
    validator("json", UserDefaults.partial()),
    async (c) => {
      const patch = c.req.valid("json");
      const current = UserDefaults.parse(c.get("user").defaults ?? {});
      const [updated] = await db.update(users).set({ defaults: { ...current, ...patch } }).where(eq(users.id, c.get("user").id)).returning();
      return c.json(toMe(updated!));
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
      await Promise.allSettled(files.map((f) => deleteObject(f.storagePath)));
      await db.delete(users).where(eq(users.id, user.id));
      await firebaseAuth.deleteUser(user.firebaseUid).catch((err) => logger.warn({ err, uid: user.firebaseUid }, "firebase deleteUser failed"));
      logger.info({ userId: user.id }, "account deleted");
      return c.body(null, 204);
    },
  );
