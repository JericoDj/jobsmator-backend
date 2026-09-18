import { Hono } from "hono";
import { validator } from "hono-openapi";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { RegisterBody, RegisterResponse } from "@/contracts";
import { route } from "@/lib/openapi";
import { firebaseAuth } from "@/services/auth";
import { ApiError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { toMe } from "./me";
import type { AppEnv } from "@/middleware";

export const authRoutes = new Hono<AppEnv>().post(
  "/register",
  route({
    tag: "Auth",
    summary: "Create a new user account with email and password",
    description: "Creates the Firebase user and local database user row, returning the user and a Firebase custom auth token.",
    ok: { schema: RegisterResponse, status: 201 },
    errors: { 400: "Invalid input", 409: "Email already registered" },
  }),
  validator("json", RegisterBody),
  async (c) => {
    const { email, password, displayName } = c.req.valid("json");

    let fbUser;
    try {
      fbUser = await firebaseAuth.createUser({
        email,
        password,
        displayName,
      });
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "auth/email-already-exists") {
        throw new ApiError("conflict", "There is already an account for that email. Sign in instead.");
      }
      if (code === "auth/invalid-password") {
        throw new ApiError("invalid_request", "Password must be at least 8 characters.");
      }
      logger.error({ err, email }, "Failed to create Firebase user");
      throw new ApiError("internal", "Could not create account. Try again later.");
    }

    try {
      const [user] = await db
        .insert(users)
        .values({
          firebaseUid: fbUser.uid,
          email: fbUser.email ?? email,
          displayName: fbUser.displayName ?? displayName,
        })
        .onConflictDoUpdate({
          target: users.firebaseUid,
          set: {
            email: fbUser.email ?? email,
            displayName: fbUser.displayName ?? displayName,
          },
        })
        .returning();

      if (!user) {
        throw new ApiError("internal", "Could not save account details.");
      }

      const customToken = await firebaseAuth.createCustomToken(fbUser.uid);

      return c.json(
        {
          user: await toMe(user),
          token: customToken,
        },
        201,
      );
    } catch (err) {
      if (err instanceof ApiError) throw err;
      logger.error({ err, uid: fbUser.uid }, "Failed to persist user in database");
      throw new ApiError("internal", "Could not save account details.");
    }
  },
);
