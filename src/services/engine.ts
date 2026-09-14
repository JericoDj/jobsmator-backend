import { EngineRequest, EngineResponse } from "@/contracts";
import { env } from "@/lib/env";
import { ApiError } from "@/lib/errors";
import { logger } from "@/lib/logger";

/** The only place in the codebase that knows about n8n. */
export async function runEngine(input: EngineRequest, signal?: AbortSignal): Promise<EngineResponse> {
  const body = EngineRequest.parse(input);
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${env.N8N_BASE_URL}/webhook/jobsmator`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-jobsmator-key": env.N8N_WEBHOOK_SECRET },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(env.ENGINE_TIMEOUT_MS),
    });
  } catch (err) {
    logger.warn({ err, ms: Date.now() - started }, "engine unreachable");
    throw new ApiError("engine_unavailable", "Job sites are slow right now. Try again in a minute.");
  }

  if (res.status === 400) {
    const payload = await res.json().catch(() => ({}));
    throw new ApiError("invalid_request", "Pick at least one job site and one interest to search.", (payload as any).details);
  }
  if (res.status === 422) {
    throw new ApiError("resume_unreadable", "We couldn't read that resume. Try a text-based PDF instead of a scan.");
  }
  if (!res.ok) {
    logger.warn({ status: res.status, ms: Date.now() - started }, "engine error");
    throw new ApiError("engine_unavailable", "Job sites are slow right now. Try again in a minute.", { status: res.status });
  }

  const parsed = EngineResponse.parse(await res.json());
  logger.info({ ms: Date.now() - started, jobs: parsed.jobs.length, stats: parsed.stats }, "engine run finished");
  return parsed;
}
