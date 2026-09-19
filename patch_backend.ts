import fs from 'fs';

let indexTs = fs.readFileSync('src/contracts/index.ts', 'utf8');
indexTs = indexTs.replace('jobs: z.array(EngineJob),', 'recommendation: z.string().optional(),\n  jobs: z.array(EngineJob),');
indexTs = indexTs.replace('recommended: z.number(),', 'recommended: z.number(),\n      feedback: z.string().optional(),');
fs.writeFileSync('src/contracts/index.ts', indexTs);
console.log("Patched index.ts");

let runsTs = fs.readFileSync('src/routes/runs.ts', 'utf8');
runsTs = runsTs.replace('tier: (j.score >= 70 ? "strong" : "good") as "strong" | "good",', 'tier: (j.score >= 70 ? "strong" : j.score >= body.minScore ? "good" : "skip") as "strong" | "good" | "skip",');
runsTs = runsTs.replace('stats: result.stats ?? null,', 'stats: result.stats ? { ...result.stats, feedback: result.recommendation } : null,');
fs.writeFileSync('src/routes/runs.ts', runsTs);
console.log("Patched runs.ts");

let envTs = fs.readFileSync('src/lib/env.ts', 'utf8');
envTs = envTs.replace('RUNS_PER_HOUR: z.coerce.number().default(5),', 'RUNS_PER_HOUR: z.coerce.number().default(30),');
fs.writeFileSync('src/lib/env.ts', envTs);
console.log("Patched env.ts");
