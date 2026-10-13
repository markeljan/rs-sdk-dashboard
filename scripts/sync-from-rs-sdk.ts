#!/usr/bin/env bun
// Copies the dashboard (tools/dashboard) and exactly the rs-sdk files it imports from an rs-sdk checkout, so this repo
// runs the same dashboard code the rs-sdk fleet runs. Re-run after dashboard changes land in rs-sdk:
//
//   bun scripts/sync-from-rs-sdk.ts ../rs-sdk
//
// Nothing under app/ is touched: that is this project's own layer (accounts, users, hosting, onboarding).
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const src = resolve(process.argv[2] ?? join(import.meta.dir, '..', '..', 'rs-sdk'));
const dst = resolve(import.meta.dir, '..');
if (!existsSync(join(src, 'tools', 'dashboard', 'server.ts'))) { console.error(`not an rs-sdk checkout with tools/dashboard: ${src}`); process.exit(1); }

const built = await Bun.build({
    entrypoints: [join(src, 'tools/dashboard/server.ts'), join(src, 'tools/dashboard/lite/assets-worker.ts')],
    target: 'bun', external: ['puppeteer', 'puppeteer-core'], metafile: true, outdir: join(dst, 'node_modules', '.sync-tmp'),
});
if (!built.success) { console.error(built.logs.join('\n')); process.exit(1); }
rmSync(join(dst, 'node_modules', '.sync-tmp'), { recursive: true, force: true });
const rel = (p: string) => { const a = resolve(p); return a.startsWith(src + "/") ? a.slice(src.length + 1) : p; };
const files = Object.keys(built.metafile!.inputs).map(rel).filter(p => !p.includes('node_modules') && !p.startsWith('/') && !p.startsWith('..'));

// Whole directories the code reads at runtime (static files, wasm, icons), not visible to the bundler.
const dirs = ['tools/dashboard', 'server/vendor/rsmod-pathfinder', 'server/engine/public/img/skill'];
const extra = ['server/webclient/package.json', 'server/webclient/tsconfig.json', 'server/webclient/LICENSE', 'tools/quests/process-identity.ts', 'LICENSE:LICENSE-rs-sdk'];
for (const d of ['tools', 'sdk', 'server']) rmSync(join(dst, d), { recursive: true, force: true });
for (const d of dirs) cpSync(join(src, d), join(dst, d), { recursive: true, filter: s => !/\/tools\/dashboard\/remote(\/|$)|\/node_modules(\/|$)|\.DS_Store$/.test(s) });
for (const entry of [...files, ...extra]) {
    const [f, to = f] = entry.split(':') as [string, string?];
    if (!existsSync(join(src, f))) continue;
    mkdirSync(dirname(join(dst, to)), { recursive: true });
    cpSync(join(src, f), join(dst, to));
}
const rev = Bun.spawnSync(['git', '-C', src, 'rev-parse', 'HEAD']).stdout.toString().trim();
writeFileSync(join(dst, 'SYNCED_FROM'), `rs-sdk ${rev}\n${new Date().toISOString()}\n`);
console.log(`synced ${files.length} imported files + ${dirs.join(', ')} from ${src} @ ${rev.slice(0, 9)}`);
Bun.spawnSync(['bun', 'install', '--production', '--ignore-scripts'], { cwd: join(dst, 'server', 'webclient'), stdout: 'inherit', stderr: 'inherit' });
