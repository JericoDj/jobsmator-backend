import { Hono } from "hono";
import { validator } from "hono-openapi";
import { z } from "zod";
import { aiAttachments, aiMessages, aiThreads } from "@/db/schema";
import { AiAttachment, AiMessage, AiThread, SendAiMessageBody, SendAiMessageResponse } from "@/contracts";
import { ApiError } from "@/lib/errors";
import { IdParam, route } from "@/lib/openapi";
import * as ai from "@/services/ai";
import type { AppEnv } from "@/middleware";

type AttachmentRow = typeof aiAttachments.$inferSelect;

const toThread = (t: Pick<typeof aiThreads.$inferSelect, "id" | "title" | "tool" | "createdAt" | "updatedAt">): AiThread => ({
  id: t.id, title: t.title, tool: t.tool, createdAt: t.createdAt.toISOString(), updatedAt: t.updatedAt.toISOString(),
});

const toAttachment = async (a: AttachmentRow): Promise<AiAttachment> => ({
  id: a.id, filename: a.filename, mimeType: a.mimeType, sizeBytes: a.sizeBytes, kind: a.kind, analysis: a.analysis,
  url: await ai.signedAttachmentUrl(a), createdAt: a.createdAt.toISOString(),
});

const toMessage = async (m: typeof aiMessages.$inferSelect, attachments: Map<string, AttachmentRow>): Promise<AiMessage> => ({
  id: m.id, threadId: m.threadId, role: m.role, content: m.content, createdAt: m.createdAt.toISOString(),
  attachments: await Promise.all(m.attachmentIds.map((id) => attachments.get(id)).filter((a): a is AttachmentRow => !!a).map(toAttachment)),
});

export const aiRoutes = new Hono<AppEnv>()
  .get("/threads", route({ tag: "Ask JobsMator", summary: "List conversations, newest first", ok: { schema: z.object({ items: z.array(AiThread) }) } }), async (c) => {
    const rows = await ai.listThreads(c.get("user"));
    return c.json({ items: rows.map(toThread) });
  })

  .get(
    "/threads/:id",
    route({ tag: "Ask JobsMator", summary: "A conversation with all its messages", ok: { schema: z.object({ thread: AiThread, messages: z.array(AiMessage) }) }, errors: { 404: "Unknown conversation" } }),
    validator("param", IdParam),
    async (c) => {
      const user = c.get("user");
      const thread = await ai.getThread(user, c.req.valid("param").id);
      const { messages, attachments } = await ai.listMessages(user, thread.id);
      return c.json({ thread: toThread(thread), messages: await Promise.all(messages.map((m) => toMessage(m, attachments))) });
    },
  )

  .delete(
    "/threads/:id",
    route({ tag: "Ask JobsMator", summary: "Delete a conversation", noContent: true, errors: { 404: "Unknown or already deleted" } }),
    validator("param", IdParam),
    async (c) => {
      await ai.deleteThread(c.get("user"), c.req.valid("param").id);
      return c.body(null, 204);
    },
  )

  .post(
    "/messages",
    route({
      tag: "Ask JobsMator",
      summary: "Send a message and get the reply",
      description:
        "Omit `threadId` to start a new conversation. Attach images by uploading them first to `POST /v1/ai/attachments` and passing their ids. " +
        "The reply is generated with the user's resume profile, recent matched jobs and the thread's history as context, and both turns are saved.",
      ok: { schema: SendAiMessageResponse },
      errors: { 400: "Empty message or unknown tool", 404: "Unknown thread or attachment", 429: "Daily message limit reached", 503: "Assistant unavailable" },
    }),
    validator("json", SendAiMessageBody),
    async (c) => {
      const user = c.get("user");
      const body = c.req.valid("json");
      const result = await ai.sendMessage(user, body);
      const [message, reply, usage] = await Promise.all([toMessage(result.user, result.attachments), toMessage(result.assistant, result.attachments), ai.usageToday(user)]);
      return c.json({ thread: toThread(result.thread), message, reply, usage });
    },
  )

  .post(
    "/attachments",
    route({
      tag: "Ask JobsMator",
      summary: "Upload an image for the assistant",
      description:
        "`multipart/form-data` with a single `file` field (JPEG, PNG, WebP or GIF, ≤ 8 MB). The image is stored, described once by the model, " +
        "and the description is kept so later messages can refer to it without resending the picture. Pass the returned `id` in `attachmentIds`.",
      ok: { status: 201, schema: AiAttachment },
      errors: { 400: "Not an image, or too large", 429: "Daily message limit reached" },
    }),
    async (c) => {
      const body = await c.req.parseBody();
      const file = body["file"];
      if (!(file instanceof File)) throw new ApiError("invalid_request", "Send the image as a `file` form field.");
      const row = await ai.createAttachment(c.get("user"), { name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
      return c.json(await toAttachment(row), 201);
    },
  )

  .get("/usage", route({ tag: "Ask JobsMator", summary: "Messages used today against the plan's limit", ok: { schema: z.object({ used: z.number().int(), limit: z.number().int(), tools: z.array(z.string()) }) } }), async (c) => {
    return c.json({ ...(await ai.usageToday(c.get("user"))), tools: ai.TOOL_IDS });
  });
