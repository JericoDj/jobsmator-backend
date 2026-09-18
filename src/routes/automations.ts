import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { validator } from "hono-openapi";
import { z } from "zod";
import { db } from "@/db/client";
import { automations, resumes } from "@/db/schema";
import { Automation, CreateAutomationBody, UpdateAutomationBody } from "@/contracts";
import { ApiError } from "@/lib/errors";
import { IdParam, route } from "@/lib/openapi";
import { nextRunAfter, scheduleLabel } from "@/lib/schedule";
import type { AppEnv } from "@/middleware";

type Row = typeof automations.$inferSelect;

export const toAutomation = (a: Row): Automation => {
  const req = a.request as { interests?: string[]; sites?: string[] };
  const cadence = { frequency: a.frequency, hour: a.hour, minute: a.minute, weekday: a.weekday, tzOffsetMinutes: a.tzOffsetMinutes };
  return {
    id: a.id,
    name: a.name,
    schedule: scheduleLabel(cadence),
    frequency: a.frequency,
    hour: a.hour,
    minute: a.minute,
    weekday: a.weekday,
    interests: req.interests ?? [],
    sites: req.sites ?? [],
    enabled: a.enabled,
    lastRunAt: a.lastRunAt?.toISOString() ?? null,
    nextRunAt: a.enabled ? (a.nextRunAt?.toISOString() ?? null) : null,
    lastResultCount: a.lastResultCount,
  };
};

export const listAutomations = (userId: string) =>
  db.select().from(automations).where(eq(automations.userId, userId)).orderBy(desc(automations.createdAt));

export const automationRoutes = new Hono<AppEnv>()
  .get("/", route({ tag: "Automations", summary: "Scheduled searches", ok: { schema: z.object({ items: z.array(Automation) }) } }), async (c) => {
    const rows = await listAutomations(c.get("user").id);
    return c.json({ items: rows.map(toAutomation) });
  })
  .post(
    "/",
    route({
      tag: "Automations",
      summary: "Schedule a search",
      description: "Runs the same request as `POST /v1/runs` on the cadence given. Scheduled runs count against the plan like manual ones.",
      ok: { status: 201, schema: Automation },
      errors: { 400: "Invalid body", 404: "Resume not found" },
    }),
    validator("json", CreateAutomationBody),
    async (c) => {
      const user = c.get("user");
      const b = c.req.valid("json");
      if (b.frequency === "weekly" && b.weekday === undefined) throw new ApiError("invalid_request", "Pick a day of the week.");
      const [resume] = await db.select({ id: resumes.id }).from(resumes).where(and(eq(resumes.id, b.resumeId), eq(resumes.userId, user.id)));
      if (!resume) throw new ApiError("not_found", "Upload a resume first.");

      const cadence = { frequency: b.frequency, hour: b.hour, minute: b.minute, weekday: b.weekday ?? null, tzOffsetMinutes: b.tzOffsetMinutes };
      const name = b.name?.trim() || `${scheduleLabel(cadence).split(" · ")[0]} search for ${b.interests[0]}`;
      const [row] = await db
        .insert(automations)
        .values({
          userId: user.id,
          resumeId: b.resumeId,
          name,
          request: { interests: b.interests, sites: b.sites, jobsPerSite: b.jobsPerSite, saveToSheet: false },
          frequency: b.frequency,
          hour: b.hour,
          minute: b.minute,
          weekday: b.weekday ?? null,
          tzOffsetMinutes: b.tzOffsetMinutes,
          nextRunAt: nextRunAfter(cadence),
        })
        .returning();
      return c.json(toAutomation(row!), 201);
    },
  )
  .patch(
    "/:id",
    route({ tag: "Automations", summary: "Rename, pause or resume", ok: { schema: Automation }, errors: { 404: "Unknown automation" } }),
    validator("param", IdParam),
    validator("json", UpdateAutomationBody),
    async (c) => {
      const user = c.get("user");
      const b = c.req.valid("json");
      const [existing] = await db.select().from(automations).where(and(eq(automations.id, c.req.valid("param").id), eq(automations.userId, user.id)));
      if (!existing) throw new ApiError("not_found", "That schedule is gone.");
      const patch: Partial<Row> = {};
      if (b.name !== undefined) patch.name = b.name.trim();
      if (b.enabled !== undefined) {
        patch.enabled = b.enabled;
        // Resuming re-arms from now so a long pause doesn't fire immediately.
        if (b.enabled) patch.nextRunAt = nextRunAfter({ ...existing });
      }
      const [row] = await db.update(automations).set(patch).where(eq(automations.id, existing.id)).returning();
      return c.json(toAutomation(row!));
    },
  )
  .delete(
    "/:id",
    route({ tag: "Automations", summary: "Delete a schedule", noContent: true, errors: { 404: "Unknown automation" } }),
    validator("param", IdParam),
    async (c) => {
      const rows = await db
        .delete(automations)
        .where(and(eq(automations.id, c.req.valid("param").id), eq(automations.userId, c.get("user").id)))
        .returning({ id: automations.id });
      if (!rows.length) throw new ApiError("not_found", "That schedule is gone.");
      return c.body(null, 204);
    },
  );
