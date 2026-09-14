import { Hono } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import { validator } from "hono-openapi";
import { z } from "zod";
import { db } from "@/db/client";
import { resumes } from "@/db/schema";
import { CreateResumeBody, Resume } from "@/contracts";
import { ApiError } from "@/lib/errors";
import { IdParam, route } from "@/lib/openapi";
import { deleteObject } from "@/services/storage";
import type { AppEnv } from "@/middleware";

const toResume = (r: typeof resumes.$inferSelect): Resume => ({
  id: r.id, filename: r.filename, sizeBytes: r.sizeBytes, createdAt: r.createdAt.toISOString(),
});

export const resumeRoutes = new Hono<AppEnv>()
  .post(
    "/",
    route({
      tag: "Resumes",
      summary: "Register an uploaded resume",
      description: "The client uploads straight to Firebase Storage at `resumes/{uid}/{file}` and then registers the path here.",
      ok: { status: 201, schema: z.object({ resumeId: z.string().uuid() }) },
      errors: { 400: "Bad path or size", 403: "Path is outside the caller's folder" },
    }),
    validator("json", CreateResumeBody),
    async (c) => {
      const body = c.req.valid("json");
      const user = c.get("user");
      if (!body.storagePath.startsWith(`resumes/${user.firebaseUid}/`)) throw new ApiError("forbidden", "That file isn't in your folder.");
      const [row] = await db.insert(resumes).values({ userId: user.id, ...body }).returning();
      return c.json({ resumeId: row!.id }, 201);
    },
  )

  .get("/", route({ tag: "Resumes", summary: "List resumes, newest first", ok: { schema: z.object({ items: z.array(Resume) }) } }), async (c) => {
    const rows = await db
      .select().from(resumes)
      .where(and(eq(resumes.userId, c.get("user").id), isNull(resumes.deletedAt)))
      .orderBy(desc(resumes.createdAt));
    return c.json({ items: rows.map(toResume) });
  })

  .delete(
    "/:id",
    route({ tag: "Resumes", summary: "Delete a resume and its file", noContent: true, errors: { 404: "Unknown or already deleted" } }),
    validator("param", IdParam),
    async (c) => {
      const [row] = await db
        .update(resumes).set({ deletedAt: new Date() })
        .where(and(eq(resumes.id, c.req.valid("param").id), eq(resumes.userId, c.get("user").id), isNull(resumes.deletedAt)))
        .returning();
      if (!row) throw new ApiError("not_found", "That resume is already gone.");
      await deleteObject(row.storagePath);
      return c.body(null, 204);
    },
  );
