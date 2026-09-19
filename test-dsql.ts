import { sql } from "drizzle-orm";
import { jobs } from "./src/db/schema";
import { PgDialect } from "drizzle-orm/pg-core";

const s = sql`select * from ${jobs}`;
const dialect = new PgDialect();
console.log(dialect.sqlToQuery(s).sql);
