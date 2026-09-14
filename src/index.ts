import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { errorHandler } from "@/lib/errors";
import { requestId, requireAuth, type AppEnv } from "@/middleware";
import { health } from "@/routes/health";
import { me } from "@/routes/me";
import { resumeRoutes } from "@/routes/resumes";
import { runRoutes, sweepStaleRuns } from "@/routes/runs";
import { jobRoutes, runJobRoutes } from "@/routes/jobs";

const app = new Hono<AppEnv>();

app.use("*", requestId);
app.use("*", honoLogger((msg) => logger.debug(msg)));
app.use("/v1/*", cors({ origin: env.WEB_ORIGIN.split(","), allowHeaders: ["authorization", "content-type"], exposeHeaders: ["x-request-id"] }));
app.onError(errorHandler);
app.notFound((c) => c.json({ error: "not_found", message: "No such endpoint." }, 404));

app.route("/health", health);

const v1 = new Hono<AppEnv>().use("*", requireAuth);
v1.route("/me", me);
v1.route("/resumes", resumeRoutes);
v1.route("/runs", runRoutes);
v1.route("/runs", runJobRoutes);
v1.route("/jobs", jobRoutes);
app.route("/v1", v1);

await sweepStaleRuns().catch((err) => logger.warn({ err }, "stale-run sweep failed"));
logger.info({ port: env.PORT, env: env.NODE_ENV }, "jobsmator-api listening");

export default { port: env.PORT, fetch: app.fetch };
export type App = typeof app;
