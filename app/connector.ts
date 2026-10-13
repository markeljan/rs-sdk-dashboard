#!/usr/bin/env bun
// RS-SDK Dashboard connector: run it next to your bots (in your rs-sdk checkout) so the dashboard can show what they're
// doing. Every 5 s it sends, for each bot on the dashboard:
//   - new lines of the bot's newest log (bots/<name>/*.log) and its tasks.json   -> "Current activity"
//   - which bot scripts are running (bun/node/bash on bots/<name>/...)           -> "Bot: <script>", running/idle
//   - new rows of telemetry/{gold,loot,kbd-drops,alt-drops,clues}-*.jsonl        -> wealth, GP/h, drop alerts, highlights
// and applies Pause from the dashboard: writes bots/<name>/PAUSED and stops (SIGSTOP) that bot's scripts; Resume undoes
// both. Self-contained (no dependencies), so it can be fetched and run on its own:
//
//   curl -fsSL https://dash.soko.tools/connector.ts -o .rsd-connector.ts && RSD_TOKEN=rsd_... bun .rsd-connector.ts
//
// Settings: RSD_URL (default https://dash.soko.tools), RSD_TOKEN (API token, also read from .env or
// telemetry/dashboard-cloud.env), RS_SDK_DIR (default: current dir), RSD_PAUSE_PROCS=0 to only write PAUSED files.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.env.RS_SDK_DIR ?? process.cwd());
for (const f of [join(ROOT, 'telemetry', 'dashboard-cloud.env'), join(ROOT, '.env')]) {
    if (!existsSync(f)) continue;
    for (const l of readFileSync(f, 'utf8').split('\n')) {
        const m = /^\s*(RSD_[A-Z_]+)\s*=\s*(.*?)\s*$/.exec(l);
        if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
    }
}
const URL_ = (process.env.RSD_URL ?? 'https://dash.soko.tools').replace(/\/$/, '');
const TOKEN = process.env.RSD_TOKEN ?? '';
const PAUSE_PROCS = process.env.RSD_PAUSE_PROCS !== '0';
const EVERY_MS = 5000;
const TELEMETRY = /^(gold|loot|kbd-drops|alt-drops|clues?|drops)-[\w.-]{1,80}\.jsonl$/;
if (!TOKEN) { console.error('RSD_TOKEN missing: copy the token from the dashboard (Settings → Connect your agent)'); process.exit(1); }
if (!existsSync(join(ROOT, 'bots'))) { console.error(`no bots/ directory in ${ROOT} - run this in your rs-sdk checkout (or set RS_SDK_DIR)`); process.exit(1); }

// byte offsets survive restarts, so nothing is sent twice
const stateFile = join(homedir(), '.rs-dashboard', `connector-${Buffer.from(URL_ + ROOT).toString('base64url').slice(-24)}.json`);
type State = { logs: Record<string, { file: string; off: number }>; tele: Record<string, number>; tasks: Record<string, number>; pausedByUs: string[] };
let st: State = { logs: {}, tele: {}, tasks: {}, pausedByUs: [] };
try { st = { ...st, ...JSON.parse(readFileSync(stateFile, 'utf8')) }; } catch { /* first run */ }
const save = () => { try { mkdirSync(join(homedir(), '.rs-dashboard'), { recursive: true }); writeFileSync(stateFile, JSON.stringify(st)); } catch { /* read-only home */ } };

/** Whole new lines of `file` after byte `from` (at most `max` bytes, the newest ones); end = offset to continue from. */
function readFrom(file: string, from: number, max: number): { text: string; end: number } {
    const size = statSync(file).size;
    if (size < from) from = 0; // truncated / rotated
    const start = Math.max(from, size - max);
    if (size <= start) return { text: '', end: size };
    const fd = openSync(file, 'r');
    try {
        const buf = Buffer.alloc(size - start);
        readSync(fd, buf, 0, buf.length, start);
        const skip = start > from ? buf.indexOf(10) + 1 : 0; // jumped ahead: begin at a whole line
        const last = buf.lastIndexOf(10);
        if (last < skip) return { text: '', end: start > from ? start + skip : from }; // no complete new line yet
        return { text: buf.subarray(skip, last + 1).toString('utf8'), end: start + last + 1 };
    } finally { closeSync(fd); }
}

function newestLog(dir: string): string | null {
    let best: { f: string; m: number } | null = null;
    for (const d of [dir, join(dir, 'telemetry')]) {
        let names: string[] = [];
        try { names = readdirSync(d); } catch { continue; }
        for (const f of names) {
            if (!f.endsWith('.log')) continue;
            try { const m = statSync(join(d, f)).mtimeMs; if (!best || m > best.m) best = { f: join(d, f), m }; } catch { /* gone */ }
        }
    }
    return best?.f ?? null;
}

type Proc = { pid: number; stopped: boolean; script: string; args: string[]; hosted?: boolean };
function procsByBot(names: string[]): Map<string, Proc[]> {
    const out = new Map<string, Proc[]>();
    const ps = Bun.spawnSync(['ps', '-axo', 'pid=,stat=,command=']).stdout.toString().split('\n');
    for (const line of ps) {
        const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        if (!m) continue;
        const pid = Number(m[1]), cmd = m[3]!;
        if (pid === process.pid || !/(^|\/)(bun|node|bash|sh|zsh|tsx)(\s|$)/.test(cmd.split(' ')[0]!)) continue;
        const parts = cmd.split(/\s+/);
        const i = parts.findIndex(p => /(^|\/)bots\/[^/]+\/.+\.(ts|js|mjs|sh)$/.test(p));
        if (i < 0) continue;
        const bot = /(?:^|\/)bots\/([^/]+)\//.exec(parts[i]!)![1]!;
        const name = names.find(n => n.toLowerCase() === bot.toLowerCase())
            ?? names.find(n => parts.slice(i + 1).some(a => a.toLowerCase() === n.toLowerCase())); // shared scripts: bots/money/x.ts <name>
        if (!name) continue;
        if (!out.has(name)) out.set(name, []);
        out.get(name)!.push({ pid, stopped: m[2]!.includes('T'), script: parts[i]!.replace(/^.*?(bots\/)/, '$1'), args: parts.slice(i + 1, i + 4) });
    }
    // bots hosted inside one shared process report through status files: rs-sdk's bots/*/script-host.json
    // ({pid, at, bots: [{name, script, state, paused}]}) and host files like tools/money-lab/lab-host.json
    // ({pid, at, slots: [{account, method, state}]}). Fresh files only (written within 2 minutes).
    const hostFiles: string[] = [];
    for (const d of readdirSync(join(ROOT, 'bots'))) hostFiles.push(join(ROOT, 'bots', d, 'script-host.json'));
    try { for (const d of readdirSync(join(ROOT, 'tools'))) { try { for (const f of readdirSync(join(ROOT, 'tools', d))) if (/-host\.json$/.test(f)) hostFiles.push(join(ROOT, 'tools', d, f)); } catch { /* not a dir */ } } } catch { /* no tools */ }
    for (const f of hostFiles) {
        if (!existsSync(f)) continue;
        try {
            const j = JSON.parse(readFileSync(f, 'utf8'));
            if (!(Date.parse(j.at) > Date.now() - 120_000)) continue;
            const rows: any[] = Array.isArray(j.bots) ? j.bots : Array.isArray(j.slots) ? j.slots : [];
            for (const b of rows) {
                const name = names.find(n => n.toLowerCase() === String(b?.name ?? b?.account ?? '').toLowerCase());
                if (!name || /stopp|exit|dead|crash|idle/i.test(String(b.state ?? ''))) continue;
                if (!out.has(name)) out.set(name, []);
                out.get(name)!.push({ pid: Number(j.pid) || 0, stopped: !!b.paused, script: String(b.script || b.method || b.entry || 'host'), args: [], hosted: true });
            }
        } catch { /* mid-write */ }
    }
    return out;
}

let names: string[] = [], namesAt = 0, lastErr = '';
async function tick() {
    if (Date.now() - namesAt > 60_000) {
        const r = await fetch(`${URL_}/_rsd/api/accounts`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(15_000) });
        if (r.status === 401) { console.error('dashboard rejected the token (revoked?) - get a new one from Settings → Connect your agent'); process.exit(1); }
        const local = new Set(readdirSync(join(ROOT, 'bots')).map(n => n.toLowerCase()));
        names = ((await r.json()) as any).accounts.map((a: any) => String(a.name)).filter((n: string) => local.has(n.toLowerCase()));
        namesAt = Date.now();
    }
    const procs = procsByBot(names);
    const accounts: any[] = [];
    // read positions are committed only after the dashboard accepted the batch, so nothing is lost while it's down
    const next: State = { ...st, logs: { ...st.logs }, tele: { ...st.tele }, tasks: { ...st.tasks } };
    for (const name of names) {
        const dir = join(ROOT, 'bots', name);
        const row: any = { name, procs: procs.get(name) ?? [] };
        const log = newestLog(dir);
        if (log) {
            const prev = st.logs[name];
            const from = prev?.file === log ? prev.off : Math.max(0, statSync(log).size - 16 * 1024); // a new log: its recent tail
            const { text, end } = readFrom(log, from, 128 * 1024);
            next.logs[name] = { file: log, off: end };
            if (text) row.log = { file: log.split('/').pop(), text };
        }
        const tf = join(dir, 'tasks.json');
        if (existsSync(tf)) {
            const m = statSync(tf).mtimeMs;
            if (st.tasks[name] !== m) { try { row.tasks = JSON.parse(readFileSync(tf, 'utf8')); next.tasks[name] = m; } catch { /* mid-write */ } }
        }
        accounts.push(row);
    }
    const telemetry: any[] = [];
    const tdir = join(ROOT, 'telemetry');
    if (existsSync(tdir)) for (const f of readdirSync(tdir)) {
        if (!TELEMETRY.test(f)) continue;
        const file = join(tdir, f);
        const from = st.tele[f] ?? Math.max(0, statSync(file).size - 256 * 1024);
        const { text, end } = readFrom(file, from, 512 * 1024);
        if (!text) { next.tele[f] = end; continue; }
        if (telemetry.length >= 150) continue; // the rest go in the next batch
        next.tele[f] = end;
        telemetry.push({ file: f, text });
    }
    const r = await fetch(`${URL_}/_rsd/api/connect/sync`, {
        method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ host: hostname(), accounts, telemetry }), signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`sync HTTP ${r.status}`);
    const res = await r.json() as { paused: string[] };
    st = { ...next, pausedByUs: st.pausedByUs };
    applyPause(new Set(res.paused ?? []), procs);
    save();
}

/** Pause from the dashboard: PAUSED file (supervisors wait) + SIGSTOP the bot's scripts. Only undoes pauses it made. */
function applyPause(paused: Set<string>, procs: Map<string, Proc[]>) {
    for (const name of names) {
        const file = join(ROOT, 'bots', name, 'PAUSED');
        const mine = st.pausedByUs.includes(name);
        if (paused.has(name) && !existsSync(file)) {
            writeFileSync(file, JSON.stringify({ pausedAt: new Date().toISOString(), by: 'rs-dashboard' }) + '\n');
            st.pausedByUs.push(name);
            if (PAUSE_PROCS) for (const p of procs.get(name) ?? []) if (!p.hosted) try { process.kill(p.pid, 'SIGSTOP'); } catch { /* gone */ }
            console.log(`${new Date().toLocaleTimeString()} paused ${name} (dashboard)`);
        } else if (!paused.has(name) && mine) {
            try { unlinkSync(file); } catch { /* gone */ }
            st.pausedByUs = st.pausedByUs.filter(n => n !== name);
            if (PAUSE_PROCS) for (const p of procs.get(name) ?? []) if (!p.hosted) try { process.kill(p.pid, 'SIGCONT'); } catch { /* gone */ }
            console.log(`${new Date().toLocaleTimeString()} resumed ${name} (dashboard)`);
        }
    }
}

console.log(`rs-dashboard connector: ${ROOT}/bots -> ${URL_} every ${EVERY_MS / 1000}s`);
for (;;) {
    try { await tick(); if (lastErr) { console.log('connected again'); lastErr = ''; } }
    catch (e) { const m = (e as Error).message; if (m !== lastErr) console.error(`${new Date().toLocaleTimeString()} ${m} (retrying)`); lastErr = m; }
    await Bun.sleep(EVERY_MS);
}
