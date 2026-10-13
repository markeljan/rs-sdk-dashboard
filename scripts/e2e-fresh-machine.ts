#!/usr/bin/env bun
// End-to-end check from a fresh machine, the way a new user goes: a clean rs-sdk checkout with one bot, then
//   A. hosted: sign up on the deployed dashboard, paste-the-skill flow (connect.sh with the skill's token), cloud game
//      client streams over the internet, an rs-sdk script drives it, activity shows up, phone-size screenshots
//   B. local: this repo started against the rs-sdk checkout, game client on this machine, script drives it
// Used by .github/workflows/e2e-fresh-machine.yml on a fresh macOS runner (another network than the dev machine).
//
//   DASH=https://dash.soko.tools RS_SDK=../rs-sdk BOT_NAME=... bun scripts/e2e-fresh-machine.ts
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const DASH = (process.env.DASH ?? 'https://dash.soko.tools').replace(/\/$/, '');
const RS_SDK = resolve(process.env.RS_SDK ?? '../rs-sdk');
const BOT = process.env.BOT_NAME!;
const OUT = resolve(process.env.OUT ?? 'e2e-out');
const ROOT = resolve(import.meta.dir, '..');
mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const results: { step: string; ok: boolean; detail: string }[] = [];
function check(step: string, ok: boolean, detail = '') { results.push({ step, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ` - ${detail}` : ''}`); }
const sh = (cmd: string, cwd: string, env: Record<string, string> = {}) => {
    const r = Bun.spawnSync(['bash', '-c', cmd], { cwd, env: { ...process.env, ...env } as any });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
};

async function frames(wsUrl: string, cookie: string, account: string, ms = 6000) {
    return new Promise<{ frames: number; kb: number }>(res => {
        const ws = new WebSocket(`${wsUrl}/ws?account=${encodeURIComponent(account)}`, { headers: cookie ? { cookie } : {} } as any);
        ws.binaryType = 'arraybuffer';
        let n = 0, bytes = 0;
        ws.onmessage = e => { if (typeof e.data !== 'string') { n++; bytes += (e.data as ArrayBuffer).byteLength; } };
        setTimeout(() => { try { ws.close(); } catch {} res({ frames: n, kb: Math.round(bytes / 1024) }); }, ms);
    });
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms: number) {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(3000); }
    console.log(`  (timed out waiting for ${what})`);
    return null;
}

/** A plain rs-sdk script (upstream SDK) for the bot: reports position, walks a few tiles. */
function agentScript() {
    const file = join(RS_SDK, 'bots', BOT, 'e2e-walk.ts');
    writeFileSync(file, `import { runScript } from '../../sdk/runner';
await runScript(async ({ bot, sdk }) => {
  const s = sdk.getState();
  const x = s?.player?.worldX ?? 0, z = s?.player?.worldZ ?? 0;
  console.log('E2E start', x, z, 'inGame', s?.inGame);
  const r = await bot.walkTo(x + 3, z + 1);
  const s2 = sdk.getState();
  console.log('E2E end', s2?.player?.worldX, s2?.player?.worldZ, 'walk', JSON.stringify(r).slice(0, 80));
}, { timeout: 90000 });
`);
    const r = sh(`bun bots/${BOT}/e2e-walk.ts`, RS_SDK);
    const start = /E2E start (\d+) (\d+)/.exec(r.out), end = /E2E end (\d+) (\d+)/.exec(r.out);
    return { ok: !!start && !!end && (start[1] !== end[1] || start[2] !== end[2]), detail: `${start?.slice(1).join(',')} -> ${end?.slice(1).join(',')}`, out: r.out.slice(-600) };
}

async function shoot(url: string, cookie: string, file: string, mobile: boolean, waitMs = 12000) {
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage();
        if (mobile) await page.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
        else await page.setViewport({ width: 1400, height: 900 });
        if (cookie) { const [name, value] = cookie.split('='); await page.setCookie({ name: name!, value: value!, url }); }
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await sleep(waitMs);
        await page.screenshot({ path: join(OUT, file) });
        return await page.evaluate(() => document.title);
    } finally { await browser.close(); }
}

// ------------------------------------------------------------------ A. hosted
async function hosted() {
    const email = `e2e-${Date.now()}@soko.tools`, password = crypto.randomUUID();
    let cookie = '';
    const call = async (path: string, body?: unknown, method?: string) => {
        const r = await fetch(DASH + path, { method: method ?? (body ? 'POST' : 'GET'), redirect: 'manual', headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]!;
        const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch {}
        return { status: r.status, json, text, location: r.headers.get('location') };
    };
    check('hosted: dashboard reachable from this network', (await call('/_rsd/health')).json?.ok === true, DASH);
    check('hosted: sign up', (await call('/_rsd/api/auth/signup', { email, password })).status === 200);
    check('hosted: new user lands on the welcome page', (await call('/')).location?.endsWith('/_rsd/welcome') ?? false);
    try {
        const skill = (await call('/_rsd/api/skill')).text;
        writeFileSync(join(OUT, 'SKILL.md'), skill.replace(/rsd_\d+_[0-9a-f]+_[0-9a-f]+/g, 'rsd_<redacted>'));
        const token = /RSD_TOKEN=(rsd_\S+)/.exec(skill)?.[1] ?? '';
        check('hosted: agent skill has URL + token', skill.includes(`RSD_URL=${DASH}`) && !!token);
        // What the skill tells the agent to run, from the rs-sdk checkout:
        const c = sh(`curl -fsSL ${DASH}/connect.sh | RSD_TOKEN=${token} RUN_CLIENT=1 bash`, RS_SDK);
        check('hosted: connect.sh adds the bot with a cloud game client', c.out.includes(`added ${BOT}`), c.out.trim().split('\n').pop());
        const running = await waitFor('cloud client in game', async () => {
            const s = (await call(`/api/state?account=${encodeURIComponent(BOT)}`)).json;
            return s?.stream?.managed?.state === 'running' && s?.conn?.inGame && s?.conn?.fresh ? s : null;
        }, 120_000);
        check('hosted: cloud game client logged in', !!running, running ? String(running.player) : '');
        const f = await frames(DASH.replace(/^http/, 'ws'), cookie, BOT);
        check('hosted: live stream over the internet', f.frames >= 10, `${f.frames} frames / 6 s, ${f.kb} KB`);
        const a = agentScript();
        check('hosted: rs-sdk script drives the cloud client', a.ok, a.ok ? a.detail : a.out);
        const act = await fetch(`${DASH}/_rsd/api/accounts/${encodeURIComponent(BOT)}/activity`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'E2E: walking a few tiles', goal: 'fresh-machine check', script: 'e2e-walk.ts' }) });
        check('hosted: agent posts activity', act.ok);
        const shown = await waitFor('activity on the dashboard', async () => {
            const s = (await call(`/api/state?account=${encodeURIComponent(BOT)}`)).json;
            return String(s?.activity?.current ?? '').includes('E2E: walking') ? s.activity : null;
        }, 40_000);
        check('hosted: activity shown as current + running', !!shown, shown ? `${shown.current} | ${shown.running}` : '');
        const title = await shoot(`${DASH}/`, cookie, 'hosted-phone.png', true);
        check('hosted: dashboard renders on a phone-size screen', /·|Dashboard|sokobot/.test(title), title);
        await shoot(`${DASH}/_rsd/manage`, cookie, 'hosted-phone-manage.png', true, 3000);
        await shoot(`${DASH}/`, cookie, 'hosted-desktop.png', false);
    } finally {
        const del = await call('/_rsd/api/auth/delete', { password });
        check('hosted: delete the test user (stops its cloud client)', del.status === 200);
    }
}

// ------------------------------------------------------------------ B. local
async function local() {
    sh(`rm -f bots/${BOT}/e2e-walk.ts`, RS_SDK);
    const port = 4747;
    const proc = spawn('bun', ['app/cli.ts', 'start'], { cwd: ROOT, env: { ...process.env, PORT: String(port), RS_SDK_DIR: RS_SDK, RSD_DATA_DIR: join(OUT, 'local-data') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    proc.stdout.on('data', d => { log += d; }); proc.stderr.on('data', d => { log += d; });
    const base = `http://localhost:${port}`;
    try {
        check('local: dashboard starts', !!(await waitFor('local health', async () => (await fetch(`${base}/_rsd/health`)).ok, 60_000)));
        const accts = (await (await fetch(`${base}/_rsd/api/accounts`)).json()).accounts as any[];
        check('local: bot imported from the rs-sdk checkout (RS_SDK_DIR)', accts.some(a => a.name === BOT && a.source === 'rs-sdk'), accts.map(a => `${a.name}/${a.source}`).join(', '));
        await sleep(15_000); // the hosted test user's cloud client has just been stopped
        const p = await fetch(`${base}/_rsd/api/accounts/${encodeURIComponent(BOT)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runClient: true, force: true }) });
        check('local: run the game client on this machine', p.ok, p.ok ? '' : await p.text());
        const running = await waitFor('local client in game', async () => {
            const s = await (await fetch(`${base}/api/state?account=${encodeURIComponent(BOT)}`)).json() as any;
            return s?.stream?.managed?.state === 'running' && s?.conn?.inGame && s?.conn?.fresh ? s : null;
        }, 120_000);
        check('local: game client logged in', !!running);
        const f = await frames(`ws://localhost:${port}`, '', BOT);
        check('local: live stream', f.frames >= 10, `${f.frames} frames / 6 s`);
        const a = agentScript();
        check('local: rs-sdk script drives the local client', a.ok, a.ok ? a.detail : a.out);
        await shoot(`${base}/`, '', 'local-desktop.png', false);
        await shoot(`${base}/`, '', 'local-phone.png', true);
    } finally {
        await fetch(`${base}/_rsd/api/accounts/${encodeURIComponent(BOT)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runClient: false }) }).catch(() => {});
        proc.kill('SIGTERM');
        await sleep(5000);
        writeFileSync(join(OUT, 'local-dashboard.log'), log.replace(/password=[^&\s"']+/gi, 'password=***'));
    }
}

try { await hosted(); } catch (e) { check('hosted: unexpected error', false, String((e as Error).stack ?? e)); }
try { await local(); } catch (e) { check('local: unexpected error', false, String((e as Error).stack ?? e)); }
const md = `# Fresh-machine end-to-end\n\nMachine: ${process.platform} ${process.arch}, ${new Date().toISOString()}\n\n| | step | detail |\n|---|---|---|\n` +
    results.map(r => `| ${r.ok ? '✅' : '❌'} | ${r.step} | ${r.detail.replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 200)} |`).join('\n') + '\n';
writeFileSync(join(OUT, 'report.md'), md);
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, md);
console.log(md);
process.exit(results.every(r => r.ok) ? 0 : 1);
