import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { firebaseAuth } from "@/services/auth";
import { ApiError } from "@/lib/errors";

export type AppUser = typeof users.$inferSelect;
export type AppEnv = { Variables: { user: AppUser; requestId: string } };

/** Verifies the Firebase ID token and upserts the user row on first sight. */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) throw new ApiError("unauthenticated", "Sign in to continue.");

  let decoded;
  try {
    decoded = await firebaseAuth.verifyIdToken(token);
  } catch {
    throw new ApiError("unauthenticated", "Your session expired. Sign in again.");
  }

  const [user] = await db
    .insert(users)
    .values({ firebaseUid: decoded.uid, email: decoded.email ?? null, displayName: decoded.name ?? null })
    .onConflictDoUpdate({ target: users.firebaseUid, set: { email: decoded.email ?? null } })
    .returning();
  if (!user) throw new ApiError("internal", "Could not load your account.");

  c.set("user", user);
  await next();
});

export const requestId = createMiddleware<AppEnv>(async (c, next) => {
  c.set("requestId", c.req.header("x-request-id") ?? crypto.randomUUID());
  await next();
  c.header("x-request-id", c.get("requestId"));
});
