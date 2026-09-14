import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sql } from "./client";
import { logger } from "@/lib/logger";

await migrate(db, { migrationsFolder: "./src/db/migrations" });
logger.info("migrations applied");
await sql.end();
