import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().default(3001),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  N8N_BASE_URL: z.string().url(),
  N8N_WEBHOOK_SECRET: z.string().min(1),
  OPENROUTER_API_KEY: z.string().min(1).optional(),

  FIREBASE_SERVICE_ACCOUNT: z.string().min(1).describe("base64-encoded service account JSON"),
  FIREBASE_STORAGE_BUCKET: z.string().min(1),
  WEB_ORIGIN: z.string().default("http://localhost:3000"),
  RUNS_PER_HOUR: z.coerce.number().default(30),
  ENGINE_TIMEOUT_MS: z.coerce.number().default(120_000),
});

export const env = EnvSchema.parse(process.env);
export type Env = typeof env;
