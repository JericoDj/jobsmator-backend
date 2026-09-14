import { Hono } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { resumes } from "@/db/schema";
import { CreateResumeBody, type Resume } from "@/contracts";
import { ApiError } from "@/lib/errors";
import { deleteObject } from "@/services/storage";
import type { AppEnv } from "@/middleware";

const toResume = (r: typeof resumes.$inferSelect): Resume => ({
  id: r.id, filename: r.filename, sizeBytes: r.sizeBytes, createdAt: r.createdAt.toISOString(),
});

export const resumeRoutes = new Hono<AppEnv>()
  .post("/", async (c) => {
    const body = CreateResumeBody.parse(await c.req.json());
    const user = c.get("user");
    if (!body.storagePath.startsWith(`resumes/${user.firebaseUid}/`)) {
      throw new ApiError("forbidden", "That file isn't in your folder.");
    }
    const [row] = await db.insert(resumes).values({ userId: user.id, ...body }).returning();
    return c.json({ resumeId: row!.id }, 201);
  })
  .get("/", async (c) => {
    const rows = await db
      .select()
      .from(resumes)
      .where(and(eq(resumes.userId, c.get("user").id), isNull(resumes.deletedAt)))
      .orderBy(desc(resumes.createdAt));
    return c.json({ items: rows.map(toResume) });
  })
  .delete("/:id", async (c) => {
    const [row] = await db
      .update(resumes)
      .set({ deletedAt: new Date() })
      .where(and(eq(resumes.id, c.req.param("id")), eq(resumes.userId, c.get("user").id), isNull(resumes.deletedAt)))
      .returning();
    if (!row) throw new ApiError("not_found", "That resume is already gone.");
    await deleteObject(row.storagePath);
    return c.body(null, 204);
  });
