import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { UserDefaults, type Me } from "@/contracts";
import type { AppEnv } from "@/middleware";

function toMe(u: typeof users.$inferSelect): Me {
  return { id: u.id, email: u.email, displayName: u.displayName, defaults: UserDefaults.parse(u.defaults ?? {}), sheetId: u.sheetId };
}

export const me = new Hono<AppEnv>()
  .get("/", (c) => c.json(toMe(c.get("user"))))
  .patch("/", async (c) => {
    const patch = UserDefaults.partial().parse(await c.req.json());
    const current = UserDefaults.parse(c.get("user").defaults ?? {});
    const [updated] = await db
      .update(users)
      .set({ defaults: { ...current, ...patch } })
      .where(eq(users.id, c.get("user").id))
      .returning();
    return c.json(toMe(updated!));
  });
