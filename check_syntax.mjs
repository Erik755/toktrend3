import { spawnSync } from 'child_process';
const result = spawnSync('node', ['-c', 'server.mjs'], { cwd: 'C:\\Users\\esanchez\\.gemini\\antigravity\\toktrend3' });
console.log('stdout:', result.stdout.toString());
console.log('stderr:', result.stderr.toString());
