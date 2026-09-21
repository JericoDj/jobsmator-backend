import { and, desc, eq, gt, inArray, isNull, sql as dsql } from "drizzle-orm";
import { db } from "@/db/client";
import { aiAttachments, aiMessages, aiThreads, jobActions, jobs, resumes } from "@/db/schema";
import { env } from "@/lib/env";
import { ApiError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { bucket } from "@/services/auth";
import { chatCompletion, parseJsonReply, type LlmImagePart, type LlmMessage, type LlmTextPart } from "@/services/llm";
import type { AppUser } from "@/middleware";

type Thread = typeof aiThreads.$inferSelect;
type Message = typeof aiMessages.$inferSelect;
type Attachment = typeof aiAttachments.$inferSelect;

/** How many recent turns ride along verbatim; older ones are folded into `threads.summary`. */
const HISTORY_WINDOW = 24;
/** Fold history once it grows past the window by this much, so we don't re-summarise every turn. */
const SUMMARISE_AT = HISTORY_WINDOW + 8;
const MAX_ATTACHMENTS_PER_MESSAGE = 4;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const ATTACHMENT_MIME = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

// ---------------------------------------------------------------------------
// Prompt: a fixed persona first (identical for every user, so a provider
// that caches prefixes gets a hit), then the user's own facts.
// ---------------------------------------------------------------------------

const PERSONA = `You are Ask JobsMator, the assistant inside JobsMator, a job-search app for people in the Philippines and remote roles worldwide.
You help with exactly one thing: the user's job search — finding and judging listings, resumes, cover letters, application emails, interview prep, salary expectations and career moves.
If asked about anything unrelated, say briefly that you only help with job hunting and offer something you can do.

Style: talk to the user as "you". Be concrete and short — a few sentences or a tight list, never a wall of text. Use plain Markdown (bold, short bullet lists) only when it helps. Give numbers and specifics from the user's profile and jobs when you have them. Never invent listings, companies or salary figures; if you don't know, say so and say what would help.
When the user shows you an image (a job post, a resume, a chat screenshot), work from what it says. Remember earlier images in this conversation from their descriptions.`;

const TOOL_PROMPTS: Record<string, { title: string; instructions: string }> = {
  "resume-analyzer": {
    title: "Resume analysis",
    instructions:
      "Review the user's resume for the target role they name (or their main interest if they don't). Output three short sections in Markdown: **Strong** (what reads well), **Fix first** (the 2–3 changes that matter most, each with a concrete rewrite or example), **Missing keywords** for the target role. Keep it under 220 words.",
  },
  "cover-letter": {
    title: "Cover letter",
    instructions:
      "Write a one-page cover letter for the job description the user pasted, in the user's voice, using real facts from their resume. Three or four short paragraphs, no placeholders, no clichés like 'I am writing to apply'. Start with 'Dear Hiring Team,' unless a name is given.",
  },
  "application-email": {
    title: "Application email",
    instructions:
      "Draft a short application email for the job and company the user names. Format: 'Subject: …' on the first line, then a 4–6 sentence email that names one relevant achievement from the resume and ends with a clear ask. Sign with the user's first name if known.",
  },
  "job-match": {
    title: "Job match",
    instructions:
      "Score the job the user pasted against their resume. Output: '**Score: N — Strong|Good|Skip**' (strong ≥ 70, good ≥ 60) on the first line, then **Why it fits**, **Gaps**, and **Watch out for** (red flags in the posting). Be honest; under 180 words.",
  },
  salary: {
    title: "Salary estimate",
    instructions:
      "Give a realistic monthly salary range for the role, level and location the user describes, in PHP for Philippine roles (and USD for remote roles at foreign companies). State the range in bold, then two or three factors that move it, and what the user's own profile suggests they should ask for. If you are unsure, give a wider range and say so.",
  },
  "resume-builder": {
    title: "Resume draft",
    instructions:
      "Rebuild the user's resume around the target role they name, using only facts from their current resume. Output Markdown: a headline line, a 2-sentence summary, then experience bullets rewritten to lead with impact (number first where possible), then skills, then education. Do not invent employers, dates or numbers.",
  },
  "interview-prep": {
    title: "Interview prep",
    instructions:
      "Prepare the user for an interview for the role/company they describe. Output **Likely questions** (5, specific to the role and their resume), then for the two hardest a suggested answer outline (situation → what you did → the number that changed), then **Ask them** (2 good questions for the interviewer). Under 260 words.",
  },
  "jd-analyzer": {
    title: "Job description analysis",
    instructions:
      "Decode the job description the user pasted. Output **They actually want** (one sentence), **Must-haves**, **Nice-to-haves**, **Red flags** (vague pay, 'fast-paced', scope creep, on-site demands), and **Your angle** — how this user should pitch themselves given their resume. Under 200 words.",
  },
};

export const TOOL_IDS = Object.keys(TOOL_PROMPTS);

/** Everything we know about the user, rendered as a compact block for the system prompt. */
async function profileBlock(user: AppUser): Promise<string> {
  const [resume] = await db
    .select({ filename: resumes.filename, profile: resumes.profile, createdAt: resumes.createdAt })
    .from(resumes)
    .where(and(eq(resumes.userId, user.id), isNull(resumes.deletedAt)))
    .orderBy(desc(resumes.createdAt))
    .limit(1);

  const recent = await db
    .select({ title: jobs.title, company: jobs.company, score: jobs.score, remote: jobs.remote, salary: jobs.salary, site: jobs.site })
    .from(jobs)
    .where(and(eq(jobs.userId, user.id), isNull(jobs.expiredAt)))
    .orderBy(desc(jobs.createdAt), desc(jobs.score))
    .limit(12);

  const acted = await db
    .select({ action: jobActions.action, title: jobs.title, company: jobs.company })
    .from(jobActions)
    .innerJoin(jobs, eq(jobs.id, jobActions.jobId))
    .where(and(eq(jobActions.userId, user.id), inArray(jobActions.action, ["saved", "applied", "interview"])))
    .orderBy(desc(jobActions.createdAt))
    .limit(10);

  const defaults = (user.defaults ?? {}) as Record<string, unknown>;
  const lines: string[] = [];
  lines.push(`Name: ${user.displayName ?? "unknown"}. Plan: ${user.plan}.`);
  const interests = Array.isArray(defaults.interests) ? (defaults.interests as string[]) : [];
  if (interests.length) lines.push(`Job interests: ${interests.join(", ")}.`);
  if (defaults.location) lines.push(`Location: ${String(defaults.location)}${defaults.remoteOnly ? " (remote only)" : ""}.`);

  if (resume?.profile) {
    // The engine's profile is already a compact extraction of the resume; cap it so a
    // huge one can't crowd out the conversation.
    const json = JSON.stringify(resume.profile);
    lines.push(`Resume "${resume.filename}" (uploaded ${resume.createdAt.toISOString().slice(0, 10)}), extracted profile:\n${json.length > 6000 ? json.slice(0, 6000) + "…" : json}`);
  } else if (resume) {
    lines.push(`Resume "${resume.filename}" is uploaded but hasn't been parsed yet — ask the user to run a search first if you need details from it.`);
  } else {
    lines.push("No resume uploaded yet. Suggest uploading one when it would help.");
  }

  if (recent.length) {
    lines.push(
      "Latest matched jobs (best first): " +
        recent.map((j) => `${j.title} @ ${j.company || "?"} (${j.score}${j.remote ? ", remote" : ""}${j.salary ? ", " + j.salary : ""}, ${j.site})`).join("; "),
    );
  }
  if (acted.length) {
    lines.push("Jobs the user acted on: " + acted.map((a) => `${a.action}: ${a.title} @ ${a.company || "?"}`).join("; "));
  }
  return lines.join("\n");
}

const attachmentNote = (a: Attachment) => `[Image "${a.filename}" — ${a.kind}]\n${a.analysis ?? "(no description)"}`;

/**
 * Builds the model input for a turn. Images are only sent as pixels on the
 * message they were attached to (`fresh`); everywhere else in history their
 * stored description stands in, which keeps every later turn cheap.
 */
async function buildMessages(
  user: AppUser,
  thread: Thread,
  history: Message[],
  attachmentsById: Map<string, Attachment>,
  fresh: { text: string; attachments: Attachment[]; images: LlmImagePart[] },
): Promise<LlmMessage[]> {
  const system = [PERSONA];
  if (thread.tool && TOOL_PROMPTS[thread.tool]) system.push(`Task for this conversation — ${TOOL_PROMPTS[thread.tool]!.title}: ${TOOL_PROMPTS[thread.tool]!.instructions}`);
  system.push(`## About this user\n${await profileBlock(user)}`);
  if (thread.summary) system.push(`## Earlier in this conversation\n${thread.summary}`);
  system.push(`Today is ${new Date().toISOString().slice(0, 10)}.`);

  const out: LlmMessage[] = [{ role: "system", content: system.join("\n\n") }];
  for (const m of history) {
    if (m.role === "assistant") {
      out.push({ role: "assistant", content: m.content });
      continue;
    }
    const notes = m.attachmentIds.map((id) => attachmentsById.get(id)).filter((a): a is Attachment => !!a).map(attachmentNote);
    out.push({ role: "user", content: notes.length ? `${notes.join("\n\n")}\n\n${m.content}` : m.content });
  }

  const parts: (LlmTextPart | LlmImagePart)[] = [...fresh.images];
  const notes = fresh.attachments.map(attachmentNote);
  const text = notes.length ? `${notes.join("\n\n")}\n\n${fresh.text}` : fresh.text;
  parts.push({ type: "text", text });
  out.push({ role: "user", content: parts.length === 1 ? text : parts });
  return out;
}

async function loadHistory(thread: Thread): Promise<Message[]> {
  const rows = await db
    .select()
    .from(aiMessages)
    .where(and(eq(aiMessages.threadId, thread.id), thread.summaryThrough ? gt(aiMessages.createdAt, thread.summaryThrough) : undefined))
    .orderBy(desc(aiMessages.createdAt))
    .limit(HISTORY_WINDOW);
  return rows.reverse();
}

async function loadAttachments(user: AppUser, ids: string[]): Promise<Map<string, Attachment>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = await db.select().from(aiAttachments).where(and(eq(aiAttachments.userId, user.id), inArray(aiAttachments.id, unique)));
  return new Map(rows.map((r) => [r.id, r]));
}

async function imagePart(a: Attachment): Promise<LlmImagePart> {
  const [buf] = await bucket.file(a.storagePath).download();
  return { type: "image_url", image_url: { url: `data:${a.mimeType};base64,${buf.toString("base64")}` } };
}

/** Free users get `AI_MESSAGES_PER_DAY_FREE` sends a day, pro `_PRO`. Counts user turns, so images and tools cost the same as a message. */
export async function assertQuota(user: AppUser) {
  const limit = user.plan === "pro" ? env.AI_MESSAGES_PER_DAY_PRO : env.AI_MESSAGES_PER_DAY_FREE;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [row] = await db
    .select({ n: dsql<number>`count(*)::int` })
    .from(aiMessages)
    .where(and(eq(aiMessages.userId, user.id), eq(aiMessages.role, "user"), gt(aiMessages.createdAt, since)));
  if ((row?.n ?? 0) >= limit) {
    throw new ApiError("too_many_runs", user.plan === "pro" ? `You've used ${limit} messages today. Try again tomorrow.` : `You've used ${limit} free messages today. Upgrade to Pro for more.`);
  }
}

export async function usageToday(user: AppUser) {
  const limit = user.plan === "pro" ? env.AI_MESSAGES_PER_DAY_PRO : env.AI_MESSAGES_PER_DAY_FREE;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [row] = await db
    .select({ n: dsql<number>`count(*)::int` })
    .from(aiMessages)
    .where(and(eq(aiMessages.userId, user.id), eq(aiMessages.role, "user"), gt(aiMessages.createdAt, since)));
  return { used: row?.n ?? 0, limit };
}

export async function getThread(user: AppUser, id: string): Promise<Thread> {
  const [t] = await db.select().from(aiThreads).where(and(eq(aiThreads.id, id), eq(aiThreads.userId, user.id), isNull(aiThreads.deletedAt)));
  if (!t) throw new ApiError("not_found", "That conversation is gone.");
  return t;
}

/**
 * One turn: store the user's message, ask the model with the thread's
 * context, store the reply. Returns both rows plus the thread (which may be
 * new). Quota is checked before anything is written.
 */
export async function sendMessage(
  user: AppUser,
  input: { threadId?: string; text: string; attachmentIds?: string[]; tool?: string },
): Promise<{ thread: Thread; user: Message; assistant: Message; attachments: Map<string, Attachment> }> {
  const text = input.text.trim();
  const attachmentIds = [...new Set(input.attachmentIds ?? [])].slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
  if (!text && !attachmentIds.length) throw new ApiError("invalid_request", "Say something or attach an image.");
  if (input.tool && !TOOL_PROMPTS[input.tool]) throw new ApiError("invalid_request", "Unknown tool.");
  await assertQuota(user);

  const fresh = await loadAttachments(user, attachmentIds);
  if (fresh.size !== attachmentIds.length) throw new ApiError("not_found", "One of those images isn't yours or no longer exists.");
  const freshList = attachmentIds.map((id) => fresh.get(id)!);

  let thread: Thread;
  if (input.threadId) {
    thread = await getThread(user, input.threadId);
  } else {
    const title = (text || freshList[0]?.filename || "New conversation").replace(/\s+/g, " ");
    const [row] = await db
      .insert(aiThreads)
      .values({ userId: user.id, tool: input.tool ?? null, title: title.length > 60 ? title.slice(0, 60).trimEnd() + "…" : title })
      .returning();
    thread = row!;
  }

  const history = await loadHistory(thread);
  const historyAttachments = await loadAttachments(user, history.flatMap((m) => m.attachmentIds));
  const images = await Promise.all(freshList.map(imagePart));
  const messages = await buildMessages(user, thread, history, historyAttachments, {
    text: text || "(see attached image)",
    attachments: freshList,
    images,
  });

  const reply = await chatCompletion(messages, { maxTokens: thread.tool ? 1800 : 1000 });

  const [userRow, assistantRow] = await db.transaction(async (tx) => {
    const [u] = await tx.insert(aiMessages).values({ threadId: thread.id, userId: user.id, role: "user", content: text || "(image)", attachmentIds }).returning();
    const [a] = await tx
      .insert(aiMessages)
      .values({ threadId: thread.id, userId: user.id, role: "assistant", content: reply.text, model: reply.model, inputTokens: reply.usage.inputTokens, outputTokens: reply.usage.outputTokens })
      .returning();
    await tx.update(aiThreads).set({ updatedAt: new Date() }).where(eq(aiThreads.id, thread.id));
    return [u!, a!];
  });

  logger.info({ userId: user.id, threadId: thread.id, model: reply.model, ...reply.usage }, "ai turn");
  void maybeSummarise(thread).catch((err) => logger.warn({ err, threadId: thread.id }, "summarise failed"));

  return { thread, user: userRow, assistant: assistantRow, attachments: fresh };
}

/**
 * Once a thread outgrows the verbatim window, fold everything older than the
 * window into `summary` so long conversations stay cheap and still remember
 * the beginning. Runs after the reply is sent; a failure just means we try
 * again next turn.
 */
async function maybeSummarise(thread: Thread) {
  // Everything the summary doesn't cover yet, oldest first.
  const uncovered = await db
    .select()
    .from(aiMessages)
    .where(and(eq(aiMessages.threadId, thread.id), thread.summaryThrough ? gt(aiMessages.createdAt, thread.summaryThrough) : undefined))
    .orderBy(aiMessages.createdAt);
  if (uncovered.length < SUMMARISE_AT) return;
  const older = uncovered.slice(0, uncovered.length - HISTORY_WINDOW);

  const transcript = older.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n");
  const { text } = await chatCompletion(
    [
      {
        role: "system",
        content:
          "Summarise this job-search conversation for the assistant's own memory. Keep every concrete fact: roles, companies, numbers, decisions, the user's preferences and anything they asked to remember. Under 250 words, plain prose.",
      },
      { role: "user", content: (thread.summary ? `Existing summary:\n${thread.summary}\n\nNew turns:\n` : "") + transcript },
    ],
    { maxTokens: 500, temperature: 0.2 },
  );
  // The rows stay (the user still sees them); the model sees the summary plus the recent window.
  await db.update(aiThreads).set({ summary: text, summaryThrough: older[older.length - 1]!.createdAt }).where(eq(aiThreads.id, thread.id));
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

type Analysis = { kind: "job_posting" | "resume" | "screenshot" | "other"; description: string };

/**
 * Stores an uploaded image and asks the model to describe it once. The
 * description is what the conversation refers to afterwards, so it is
 * written to be complete: a job post's full text, a resume's content, etc.
 */
export async function createAttachment(user: AppUser, file: { name: string; type: string; bytes: Uint8Array }): Promise<Attachment> {
  if (!(ATTACHMENT_MIME as readonly string[]).includes(file.type)) throw new ApiError("invalid_request", "Only JPEG, PNG, WebP or GIF images are supported.");
  if (file.bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new ApiError("invalid_request", "Images must be under 8 MB.");
  if (!file.bytes.byteLength) throw new ApiError("invalid_request", "That image is empty.");
  await assertQuota(user);

  const ext = file.type === "image/jpeg" ? "jpg" : file.type.slice("image/".length);
  const storagePath = `ai/${user.firebaseUid}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  await bucket.file(storagePath).save(Buffer.from(file.bytes), { contentType: file.type, resumable: false });

  const dataUrl = `data:${file.type};base64,${Buffer.from(file.bytes).toString("base64")}`;
  let analysis: Analysis = { kind: "other", description: "" };
  try {
    const { text } = await chatCompletion(
      [
        {
          role: "system",
          content:
            'Describe this image for a job-search assistant that will not see the picture again. Reply with JSON only: {"kind": "job_posting" | "resume" | "screenshot" | "other", "description": string}. ' +
            "If it is a job posting, resume, offer, email or chat, transcribe all the text faithfully (title, company, salary, requirements, dates, names) in the description. Otherwise describe what is shown and any visible text. Do not add commentary.",
        },
        { role: "user", content: [{ type: "image_url", image_url: { url: dataUrl } }, { type: "text", text: "Describe this image." }] },
      ],
      { maxTokens: 1500, temperature: 0.1, json: true },
    );
    const parsed = parseJsonReply<Partial<Analysis>>(text);
    analysis = {
      kind: parsed?.kind && ["job_posting", "resume", "screenshot", "other"].includes(parsed.kind) ? parsed.kind : "other",
      description: typeof parsed?.description === "string" && parsed.description.trim() ? parsed.description.trim() : text,
    };
  } catch (err) {
    // The image is stored either way; the description can be filled in when it is first used.
    logger.warn({ err, storagePath }, "image analysis failed");
  }

  const [row] = await db
    .insert(aiAttachments)
    .values({ userId: user.id, storagePath, filename: file.name || `image.${ext}`, mimeType: file.type, sizeBytes: file.bytes.byteLength, kind: analysis.kind, analysis: analysis.description || null })
    .returning();
  return row!;
}

export async function listThreads(user: AppUser) {
  return db
    .select({ id: aiThreads.id, title: aiThreads.title, tool: aiThreads.tool, createdAt: aiThreads.createdAt, updatedAt: aiThreads.updatedAt })
    .from(aiThreads)
    .where(and(eq(aiThreads.userId, user.id), isNull(aiThreads.deletedAt)))
    .orderBy(desc(aiThreads.updatedAt))
    .limit(100);
}

export async function listMessages(user: AppUser, threadId: string) {
  await getThread(user, threadId);
  const rows = await db.select().from(aiMessages).where(eq(aiMessages.threadId, threadId)).orderBy(aiMessages.createdAt);
  const attachments = await loadAttachments(user, rows.flatMap((m) => m.attachmentIds));
  return { messages: rows, attachments };
}

export async function deleteThread(user: AppUser, id: string) {
  const [row] = await db
    .update(aiThreads)
    .set({ deletedAt: new Date() })
    .where(and(eq(aiThreads.id, id), eq(aiThreads.userId, user.id), isNull(aiThreads.deletedAt)))
    .returning({ id: aiThreads.id });
  if (!row) throw new ApiError("not_found", "That conversation is already gone.");
}

export async function signedAttachmentUrl(a: Attachment, ttlMs = 60 * 60 * 1000) {
  const [url] = await bucket.file(a.storagePath).getSignedUrl({ action: "read", expires: Date.now() + ttlMs });
  return url;
}

