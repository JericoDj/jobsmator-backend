import { db } from "./src/db/client";
import { sql } from "drizzle-orm";
async function test() {
  const result = await db.execute(sql`SELECT 1 as num`);
  console.log("Type:", Array.isArray(result) ? "Array" : typeof result);
  console.log("Keys:", Object.keys(result));
  console.log("Result:", result);
  process.exit(0);
}
test();
