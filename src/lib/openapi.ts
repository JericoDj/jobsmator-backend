import { describeRoute, resolver } from "hono-openapi";
import { z } from "zod";
import { ApiErrorBody } from "@/contracts";

type Json = Parameters<typeof resolver>[0];

const json = (schema: Json, description: string) => ({ description, content: { "application/json": { schema: resolver(schema) } } });
const err = (description: string) => json(ApiErrorBody, description);

/** Shorthand for describing an authenticated JSON route. */
export function route(opts: {
  tag: string;
  summary: string;
  description?: string;
  ok?: { status?: number; schema: Json; description?: string };
  noContent?: boolean;
  errors?: Partial<Record<400 | 401 | 403 | 404 | 409 | 422 | 429 | 503, string>>;
  auth?: boolean;
}) {
  const responses: Record<string, unknown> = {};
  if (opts.noContent) responses["204"] = { description: "Done" };
  else if (opts.ok) responses[String(opts.ok.status ?? 200)] = json(opts.ok.schema, opts.ok.description ?? "OK");
  if (opts.auth !== false) responses["401"] = err("Missing or expired Firebase ID token");
  for (const [status, description] of Object.entries(opts.errors ?? {})) responses[status] = err(description);
  return describeRoute({
    tags: [opts.tag],
    summary: opts.summary,
    description: opts.description,
    security: opts.auth === false ? [] : [{ bearerAuth: [] }],
    responses: responses as never,
  });
}

export const IdParam = z.object({ id: z.string().uuid() });
