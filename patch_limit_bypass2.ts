import fs from 'fs';
let code = fs.readFileSync('src/routes/runs.ts', 'utf8');
code = code.replace(/if \(count >= limit\) throw new ApiError\("too_many_requests".*\n/g, '// bypassed\n');
fs.writeFileSync('src/routes/runs.ts', code);
