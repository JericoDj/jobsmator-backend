import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";
import { openAPIRouteHandler } from "hono-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { errorHandler } from "@/lib/errors";
import { requestId, requireAuth, type AppEnv } from "@/middleware";
import { health } from "@/routes/health";
import { authRoutes } from "@/routes/auth";
import { me } from "@/routes/me";
import { resumeRoutes } from "@/routes/resumes";
import { runRoutes } from "@/routes/runs";
import { jobRoutes, runJobRoutes } from "@/routes/jobs";
import { startMaintenance } from "@/jobs/maintenance";

export const app = new Hono<AppEnv>();

app.use("*", requestId);
app.use("*", honoLogger((msg) => logger.debug(msg)));
app.use("/v1/*", cors({ origin: env.WEB_ORIGIN.split(","), allowHeaders: ["authorization", "content-type"], exposeHeaders: ["x-request-id"] }));
app.onError(errorHandler);
app.notFound((c) => c.json({ error: "not_found", message: "No such endpoint." }, 404));

app.route("/health", health);
app.route("/v1/auth", authRoutes);

const v1 = new Hono<AppEnv>().use("*", requireAuth);
v1.route("/me", me);
v1.route("/resumes", resumeRoutes);
v1.route("/runs", runRoutes);
v1.route("/runs", runJobRoutes);
v1.route("/jobs", jobRoutes);
app.route("/v1", v1);

// ---- API docs: OpenAPI 3.1 at /openapi.json, Scalar UI at /docs
app.get(
  "/openapi.json",
  openAPIRouteHandler(app, {
    documentation: {
      info: {
        title: "JobsMator API",
        version: "0.1.0",
        description:
          "Backend for JobsMator. Clients upload a resume to Firebase Storage, register it, start a **run**, poll it, then read the ranked **jobs**. " +
          "All `/v1` routes need `Authorization: Bearer <Firebase ID token>`. Errors are `{ error, message, details? }` with a stable `error` code.",
      },
      servers: [{ url: "http://localhost:3001", description: "Local" }],
      tags: [
        { name: "System", description: "Health and docs" },
        { name: "Auth", description: "User registration and authentication" },
        { name: "Me", description: "Account and saved defaults" },
        { name: "Resumes", description: "Uploaded resume files" },
        { name: "Runs", description: "Asynchronous search runs against the n8n engine" },
        { name: "Jobs", description: "Ranked results and user actions on them" },
      ],
      components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "Firebase ID token" } } },
    },
  }),
);
app.get("/docs", Scalar({ url: "/openapi.json", pageTitle: "JobsMator API", theme: "kepler" }));

if (import.meta.main) {
  startMaintenance();
  logger.info({ port: env.PORT, env: env.NODE_ENV, docs: `http://localhost:${env.PORT}/docs` }, "jobsmator-api listening");
}

export default { port: env.PORT, fetch: app.fetch };
export type App = typeof app;
