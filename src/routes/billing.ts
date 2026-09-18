import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { validator } from "hono-openapi";
import { z } from "zod";
import { db } from "@/db/client";
import { users, vouchers, voucherRedemptions } from "@/db/schema";
import { route } from "@/lib/openapi";
import { ApiError } from "@/lib/errors";
import { toMe } from "@/routes/me";
import { env } from "@/lib/env";
import type { AppEnv } from "@/middleware";

export const billingRoutes = new Hono<AppEnv>()
  .post(
    "/checkout",
    route({
      tag: "Billing",
      summary: "Mock upgrade to Pro",
      ok: { schema: z.any() },
    }),
    validator("json", z.object({ plan: z.enum(["free", "pro"]) })),
    async (c) => {
      const user = c.get("user");
      const { plan } = c.req.valid("json");
      
      const [updated] = await db
        .update(users)
        .set({ plan, renewsAt: null })
        .where(eq(users.id, user.id))
        .returning();
      
      return c.json(await toMe(updated!));
    }
  )
  .post(
    "/redeem",
    route({
      tag: "Billing",
      summary: "Redeem a voucher code for Pro access",
      ok: { schema: z.any() },
      errors: { 400: "Invalid or expired code" },
    }),
    validator("json", z.object({ code: z.string().trim().min(1) })),
    async (c) => {
      const user = c.get("user");
      const { code } = c.req.valid("json");
      
      return await db.transaction(async (tx) => {
        // Find voucher
        const [voucher] = await tx.select().from(vouchers).where(eq(vouchers.code, code));
        
        if (!voucher) {
          throw new ApiError("invalid_request", "Invalid voucher code.");
        }
        
        if (voucher.expiresAt && voucher.expiresAt < new Date()) {
          throw new ApiError("invalid_request", "This voucher code has expired.");
        }
        
        if (voucher.maxUses !== null && voucher.useCount >= voucher.maxUses) {
          throw new ApiError("invalid_request", "This voucher code has reached its maximum uses.");
        }
        
        // Check if user already redeemed
        const [existing] = await tx
          .select()
          .from(voucherRedemptions)
          .where(sql`${voucherRedemptions.userId} = ${user.id} AND ${voucherRedemptions.code} = ${code}`);
          
        if (existing) {
          throw new ApiError("invalid_request", "You have already redeemed this voucher code.");
        }
        
        // Grant Pro
        const renewsAt = voucher.durationDays 
          ? new Date(Date.now() + voucher.durationDays * 24 * 60 * 60 * 1000) 
          : null;
          
        const [updatedUser] = await tx
          .update(users)
          .set({ plan: "pro", renewsAt })
          .where(eq(users.id, user.id))
          .returning();
          
        // Record redemption and increment count
        await tx.insert(voucherRedemptions).values({ code, userId: user.id });
        await tx.update(vouchers).set({ useCount: sql`${vouchers.useCount} + 1` }).where(eq(vouchers.code, code));
        
        return c.json(await toMe(updatedUser!));
      });
    }
  )
  .post(
    "/admin/vouchers",
    route({
      tag: "Admin",
      summary: "Create a new voucher code (Admin only)",
      ok: { schema: z.any() },
      errors: { 403: "Unauthorized" },
    }),
    validator("json", z.object({
      code: z.string().trim().min(1),
      durationDays: z.number().int().positive().nullable().optional(),
      maxUses: z.number().int().positive().nullable().optional(),
      expiresInDays: z.number().int().positive().nullable().optional(),
      adminSecret: z.string()
    })),
    async (c) => {
      // In a real app this would use a proper admin auth middleware, 
      // but for now we just use a simple secret from the request body.
      const body = c.req.valid("json");
      
      // Simple hardcoded secret for now since this is MVP
      if (body.adminSecret !== "admin123") {
        throw new ApiError("forbidden", "Invalid admin secret");
      }
      
      const expiresAt = body.expiresInDays 
        ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000)
        : null;
        
      const [voucher] = await db.insert(vouchers).values({
        code: body.code,
        durationDays: body.durationDays ?? null,
        maxUses: body.maxUses ?? null,
        expiresAt,
      }).returning();
      
      return c.json({ voucher });
    }
  );
