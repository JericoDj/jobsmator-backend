import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().default(3001),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  N8N_BASE_URL: z.string().url(),
  N8N_WEBHOOK_SECRET: z.string().min(1),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  /** Default chat + vision model for Ask JobsMator. Any OpenRouter id with image input works. */
  OPENROUTER_MODEL: z.string().default("openai/gpt-5.6-luna"),
  /** Daily Ask JobsMator message caps per plan; a pro user gets the second number. */
  AI_MESSAGES_PER_DAY_FREE: z.coerce.number().default(30),
  AI_MESSAGES_PER_DAY_PRO: z.coerce.number().default(300),

  FIREBASE_SERVICE_ACCOUNT: z.string().min(1).describe("base64-encoded service account JSON"),
  FIREBASE_STORAGE_BUCKET: z.string().min(1),
  WEB_ORIGIN: z.string().default("http://localhost:3000"),
  RUNS_PER_HOUR: z.coerce.number().default(100),
  ENGINE_TIMEOUT_MS: z.coerce.number().default(120_000),

  /** Public base URL of this API, used to build OAuth redirect URLs. */
  API_PUBLIC_URL: z.string().url().default("http://localhost:3001"),

  // Canva Connect API (OAuth 2.0 + PKCE). Leave CLIENT_ID unset to disable.
  CANVA_CLIENT_ID: z.string().min(1).optional(),
  CANVA_CLIENT_SECRET: z.string().min(1).optional(),
  CANVA_SCOPES: z.string().default("profile:read design:meta:read design:content:write asset:write"),
  /** Where the browser lands after the callback: the app's deep link. */
  CANVA_APP_RETURN_URL: z.string().default("jobsmator://integrations/canva"),
});

export const env = EnvSchema.parse(process.env);
export type Env = typeof env;
