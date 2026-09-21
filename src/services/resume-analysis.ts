import { eq } from "drizzle-orm";
import mammoth from "mammoth";
import { db } from "@/db/client";
import { resumes } from "@/db/schema";
import { ResumeAnalysis } from "@/contracts";
import { logger } from "@/lib/logger";
import { bucket } from "@/services/auth";
import { chatCompletion, parseJsonReply, type LlmMessage, type LlmTextPart, type LlmFilePart } from "@/services/llm";

/** Résumé text longer than this is truncated before it goes to the model. */
const MAX_TEXT_CHARS = 12_000;

const SYSTEM_PROMPT = `You are a résumé analyst for JobsMator, a job-search app. Read the résumé and reply with ONLY a JSON object matching this exact schema — no prose, no markdown fences:
{
  "summary": string,        // 2 sentences on who this person is
  "headline": string,       // e.g. "Mid-level Flutter developer, 3 yrs"
  "seniority": "entry" | "junior" | "mid" | "senior" | "lead",
  "strengths": string[],    // up to 5, concrete
  "fixes": string[],        // up to 5, concrete and actionable improvements
  "skills": string[],       // up to 25, normalised, lowercase-ish (e.g. "flutter", "firebase")
  "roles": string[],        // up to 8 job titles this résumé fits (e.g. "Flutter Developer")
  "tags": string[],         // up to 20, union of roles + top skills + industries, lowercase, deduped — used to match this résumé against job listings
  "industries": string[]    // up to 5
}`;

type ResumeRow = typeof resumes.$inferSelect;

const DRIVE_VIEW_RE = /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/;

/** Mirrors the Google Drive view→download conversion in `runs.ts` for external resume links. */
function normalizeUrl(url: string): string {
  const match = url.match(DRIVE_VIEW_RE);
  return match ? `https://drive.google.com/uc?export=download&id=${match[1]}` : url;
}

async function fetchResumeBytes(resume: ResumeRow): Promise<{ bytes: Buffer; contentType: string | null }> {
  if (resume.storagePath) {
    const [buf] = await bucket.file(resume.storagePath).download();
    return { bytes: buf, contentType: null };
  }
  if (resume.url) {
    const res = await fetch(normalizeUrl(resume.url), { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Could not download the résumé (${res.status}).`);
    return { bytes: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") };
  }
  throw new Error("Resume has neither a storage path nor a URL.");
}

type ResumeKind = "pdf" | "docx" | "text";

function kindOf(filename: string, contentType: string | null): ResumeKind {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf" || contentType === "application/pdf") return "pdf";
  if (ext === "docx" || contentType?.includes("wordprocessingml")) return "docx";
  return "text";
}

/**
 * Trims, lowercases and dedupes a list of loose strings from a model reply
 * into at most `max` short tags — used for `skills` and `tags`.
 */
export function normalizeTags(input: unknown, max: number): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const tag = raw.trim().toLowerCase();
    if (!tag || tag.length > 40 || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}

function trimmedStrings(input: unknown, max: number): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((v): v is string => typeof v === "string")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, max);
}

/**
 * Shapes a raw (possibly over-long or malformed) model reply into the
 * `ResumeAnalysis` schema's array/length limits before validating it — the
 * model's own instructions cap these, but we don't trust it blindly.
 */
export function normalizeAnalysis(raw: unknown): unknown {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    summary: typeof r.summary === "string" ? r.summary.trim() : "",
    headline: typeof r.headline === "string" ? r.headline.trim() : "",
    seniority: r.seniority,
    strengths: trimmedStrings(r.strengths, 5),
    fixes: trimmedStrings(r.fixes, 5),
    skills: normalizeTags(r.skills, 25),
    roles: trimmedStrings(r.roles, 8),
    tags: normalizeTags(r.tags, 20),
    industries: trimmedStrings(r.industries, 5),
  };
}

async function extractText(kind: "docx" | "text", bytes: Buffer): Promise<string> {
  if (kind === "docx") {
    const { value } = await mammoth.extractRawText({ buffer: bytes });
    return value;
  }
  return bytes.toString("utf8");
}

async function askModel(resume: ResumeRow, kind: ResumeKind, bytes: Buffer): Promise<string> {
  if (kind === "pdf") {
    const filePart: LlmFilePart = {
      type: "file",
      file: { filename: resume.filename || "resume.pdf", file_data: `data:application/pdf;base64,${bytes.toString("base64")}` },
    };
    const textPart: LlmTextPart = { type: "text", text: "Analyze this résumé and reply with the JSON object described in the system prompt." };
    const messages: LlmMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: [filePart, textPart] },
    ];
    const { text } = await chatCompletion(messages, {
      json: true,
      temperature: 0.2,
      maxTokens: 1500,
      plugins: [{ id: "file-parser", pdf: { engine: "pdf-text" } }],
    });
    return text;
  }

  const text = await extractText(kind, bytes);
  const trimmed = text.slice(0, MAX_TEXT_CHARS);
  if (!trimmed.trim()) throw new Error("Couldn't read any text from that résumé.");
  const messages: LlmMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Résumé text:\n\n${trimmed}` },
  ];
  const { text: reply } = await chatCompletion(messages, { json: true, temperature: 0.2, maxTokens: 1500 });
  return reply;
}

/**
 * Extracts the résumé's text (or sends the PDF directly to the model), asks
 * for a structured analysis, and writes `analysis`/`analyzedAt` — or
 * `analysisError` on failure. Never throws; background-safe.
 */
export async function analyzeResume(resumeId: string): Promise<void> {
  const [resume] = await db.select().from(resumes).where(eq(resumes.id, resumeId));
  if (!resume || resume.deletedAt) return;

  try {
    const { bytes, contentType } = await fetchResumeBytes(resume);
    const kind = kindOf(resume.filename, contentType);
    const reply = await askModel(resume, kind, bytes);

    const raw = parseJsonReply<Record<string, unknown>>(reply);
    if (!raw) throw new Error("The assistant didn't return valid JSON.");
    const parsed = ResumeAnalysis.safeParse(normalizeAnalysis(raw));
    if (!parsed.success) throw new Error("The analysis didn't match the expected shape.");

    await db.update(resumes).set({ analysis: parsed.data, analyzedAt: new Date(), analysisError: null }).where(eq(resumes.id, resumeId));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Analysis failed.";
    logger.warn({ err, resumeId }, "resume analysis failed");
    await db.update(resumes).set({ analysisError: message.slice(0, 500) }).where(eq(resumes.id, resumeId));
  }
}
