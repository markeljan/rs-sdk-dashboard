#!/usr/bin/env bun
// Multi-account live dashboard + remote control.
//
//   bun tools/dashboard/server.ts          ->  http://<this-mac-LAN-IP>:8765   (phone + desktop)
//
// Accounts come from telemetry/accounts.json (see README). Per account:
// - Live view + input: "managed" accounts run a headless puppeteer Chrome client that this server
//   keeps healthy (JPEG/PNG frames over /ws, input via puppeteer). Every other account is "lite":
//   no game client here at all; the page draws it from observer state (/api/lite/scene), no input.
// - Automation pause/resume: SIGSTOP/SIGCONT on that account's bot script processes + PAUSED file.
// - Stats: read-only SDK connection in OBSERVE mode (never takes control of the bot).
// - XP history, play time vs record, plan projection, tasks, latest log lines.
// Passwords are read from each account's bot.env and are never logged or served.
import { BotSDK, deriveGatewayUrl } from '../../sdk/index';
import { buildHighlights } from './highlights';
import { LiveEvents } from './live-events';
import type { BotWorldState } from '../../sdk/types';
import type { ServerWebSocket } from 'bun';
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { basename, dirname, isAbsolute, join, resolve } from 'path';
import { networkInterfaces } from 'os';
import {
    evaluateGatewayOutagePolicy,
    updateGatewayTransportFailure,
    type GatewayOutageState,
} from './gateway-outage-policy';
import { latestAccountActivityLog } from './activity-log';
import { buildQuestsPayload, parseQuestRunLog, readTail } from './quests-api';
import { isAlive, killSaved, launchDetached, readSaved } from './managed-browser';
import { FORK_MARKER_JS, interceptBundle, LocalBundle, type BundleDecision } from './local-bundle';
import { summarizeActivity, type LiveQuest } from './activity-summary';
import { latestBankSnapshot, valueBank } from './bank-value';
import { dashboardProcessAffiliation, dashboardProcessCandidateAccepted,
    dashboardRunnerScript } from './process-affiliation';
import { LiteAssets } from './lite/assets';
import { isRemote, remoteGate } from './remote-auth';
import { buildLiteScene } from './lite/scene';
import { HqFeed } from './lite/hq';
import { MANAGED_SNAPSHOT_JS, managedSnapshot, observerWanted, parseLiteHostStatus, parsePs, parseScriptHostStatus, pickSnapshot, psCandidates, snapshotFresh,
    type AccountSnapshot, type HostedBot, type PsRow } from './snapshot-source';

// ------------------------------------------------------------------ config
const ROOT = resolve(import.meta.dir, '../..');
/** Evaluated in a managed page: camera yaw, the minimap's extra angle/zoom, the local player (1/128 tile) and build base. */
const MANAGED_CAMERA_JS = `(() => {
    const g = window.gameClient; if (!g || !g.ingame || !g.localPlayer) return null;
    return { yaw: g.orbitCameraYaw | 0, mmAngle: g.macroMinimapAngle | 0, mmZoom: g.macroMinimapZoom | 0, lx: g.localPlayer.x | 0, lz: g.localPlayer.z | 0,
        baseX: g.mapBuildBaseX | 0, baseZ: g.mapBuildBaseZ | 0, level: g.minusedlevel | 0 };
})()`;
const PORT = Number(process.env.PORT ?? 8765);
const HOST = process.env.HOST ?? '0.0.0.0';
const DATA_DIR = resolve(process.env.DATA_DIR ?? join(ROOT, 'telemetry'));
const ACCOUNTS_FILE = resolve(process.env.ACCOUNTS_FILE ?? join(DATA_DIR, 'accounts.json'));
const PUBLIC_DIR = join(import.meta.dir, 'public');
const STREAM_FPS_CHOICES = [15, 30, 60] as const;
// Watched stream rate (JPEG path + the managed game client's render rate while someone watches). Settings → Stream FPS
// persists it in dashboard-prefs.json; FPS env is only the default.
const DEFAULT_STREAM_FPS = Math.min(60, Math.max(1, Number(process.env.FPS ?? 30)));
// Render rate of a managed game client nobody is watching. The client still runs ~50 logic ticks/s down to 5 fps
// (GameShell catches up up to ~10 ticks per frame), so bots are unaffected; it cuts each Chrome from ~45% to ~4% CPU.
const IDLE_FPS = Math.min(50, Math.max(5, Number(process.env.IDLE_FPS ?? 5)));
// Stream image quality, 1-100: JPEG quality for managed clients, 100 = lossless PNG.
// Only watched accounts are captured at all, so this costs nothing for the rest.
// Settings → Stream quality persists it in dashboard-prefs.json; QUALITY env (0-1) overrides the High (JPEG 90) default.
const STREAM_QUALITY_CHOICES = [60, 75, 90, 100] as const;
const DEFAULT_STREAM_QUALITY = Math.round(Math.min(1, Math.max(0.2, Number(process.env.QUALITY ?? 0.9))) * 100);
const TOKEN = process.env.DASH_TOKEN ?? '';
const REMOTE_SECRET_FILE = resolve(process.env.REMOTE_SECRET_FILE ?? join(DATA_DIR, 'remote-secret'));
const NO_OBSERVER = process.env.NO_OBSERVER === '1';
// Observers (one observe-mode SDK socket per account, ~70 KB/s each) are on demand: connected while a viewer has the
// account open or an API consumer asked for its live state in the last OBSERVER_IDLE_MS; OBSERVERS=always restores
// the old always-on behaviour. Everything else reads lastSnapshot() (lite-host status / managed page / gateway).
const OBSERVERS_ALWAYS = process.env.OBSERVERS === 'always';
const OBSERVER_IDLE_MS = Math.max(30_000, Number(process.env.OBSERVER_IDLE_MS ?? 180_000));
const NO_HISCORES = process.env.NO_HISCORES === '1';
const NO_AUTOSTART = process.env.NO_AUTOSTART === '1';
const SAMPLE_MS = 60_000;
const FRESH_MS = 5_000;

const SKILLS = ['Attack', 'Defence', 'Strength', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching',
    'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Runecraft'] as const;
// Server XP curve (server/engine/src/engine/entity/Player.ts): xp(L) = floor(sum_{l=1}^{L-1} floor(l + 300*2^(l/10)) / 4)
const XP_FOR_LEVEL: number[] = [0, 0];
for (let L = 2, acc = 0; L <= 99; L++) { acc += Math.floor((L - 1) + 300 * Math.pow(2, (L - 1) / 10)); XP_FOR_LEVEL[L] = Math.floor(acc / 4); }
const MAX_XP = XP_FOR_LEVEL[99]!; // 998,458
const MAX_TOTAL_LEVEL = 99 * SKILLS.length; // 1881
const MAX_TOTAL_XP = MAX_XP * SKILLS.length;
const XP_CAP = 200_000_000; // a skill at the cap gains nothing, so "last trained" is read from the activity line instead
const LAST_SKILL_MAX_AGE_MS = 2 * 3.6e6;
const SKILL_ACTIVITY: Partial<Record<(typeof SKILLS)[number], RegExp>> = {
    Thieving: /thie|pickpocket|stall/i, Fishing: /fish/i, Woodcutting: /woodcut|chop|willows?|yews?/i, Mining: /min(e|er|ing)|ores?/i,
    Cooking: /cook/i, Fletching: /fletch|bows?/i, Firemaking: /firemak|burn/i, Crafting: /craft|tan/i, Smithing: /smith|smelt/i,
    Runecraft: /runecraft|rc|essence/i, Agility: /agility/i, Herblore: /herblore|potion|decant/i, Magic: /alch|magic/i, Prayer: /prayer|bones/i,
}; // 18,970,702
const RECORD_DEFAULT = { holder: 'claudefable5', hours: 55 + 51 / 60 };

// Every string that leaves this process (logs, API errors) goes through redact().
const SECRETS: string[] = [];
const redact = (s: string) => {
    let out = String(s).replace(/password=[^&\s"']*/gi, 'password=***');
    for (const sec of SECRETS) if (sec) out = out.split(sec).join('***');
    return out;
};
const log = (...a: unknown[]) => console.log(redact(`[dashboard ${new Date().toLocaleTimeString()}] ${a.map(String).join(' ')}`));
/** This fork's bot client bundle for managed pages (local-bundle.ts; LOCAL_BOT_BUNDLE=0 disables). */
const localBundle = new LocalBundle(log);
const errMsg = (e: unknown) => redact(e instanceof Error ? e.message : String(e));
const PREFS_FILE = join(DATA_DIR, 'dashboard-prefs.json');
type DashPrefs = { inputDisabled?: boolean; streamFps?: number; streamQuality?: number };
const readPrefs = (): DashPrefs => { try { return JSON.parse(readFileSync(PREFS_FILE, 'utf8')); } catch { return {}; } };
let streamFps = Number(readPrefs().streamFps) || DEFAULT_STREAM_FPS;
let streamQuality = Number(readPrefs().streamQuality) || DEFAULT_STREAM_QUALITY;
/** JPEG quality (0-1) for capturers that only do JPEG. */
/** Sniff the encoded frame type (managed clients send PNG at quality 100). */
const frameType = (f: Uint8Array) => f[0] === 0x89 && f[1] === 0x50 ? 'image/png' : 'image/jpeg';
const readJson = <T>(file: string | null | undefined): T | null => { if (!file) return null; try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return null; } };
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
mkdirSync(DATA_DIR, { recursive: true });

type AccountCfg = {
    name: string;
    botDir: string;
    procMatch: string[];
    /** 'managed' = headless Chrome run by this server; anything else (incl. legacy 'extension' or missing) = lite. */
    client?: 'managed' | 'lite' | string;
    /** Managed accounts only: true makes the Live tab draw the simulated lite view instead of frames. Non-managed accounts are always lite. */
    lite?: boolean;
    autostart?: boolean;
    historyFile?: string; playtimeFile?: string; tasksFile?: string; planFile?: string; supervisorFile?: string; manifestFile?: string; logDir?: string;
    baselineHours?: number;
    goldFile?: string; money?: boolean; // money accounts: wealth samples written by the account's own script (bots/money/lib.ts)
};
const abs = (p: string | undefined | null, base = ROOT) => (p ? (isAbsolute(p) ? p : resolve(base, p)) : null);
// Lite host status (bots/lite-host.ts): status files bots/*/lite-host.json carry a 15 s xp/levels/pos/hp snapshot per
// hosted bot - an observer-less stats source for lite accounts. Re-read at most every 10 s.
const LITE_HOST_STATUS = resolve(process.env.LITE_HOST_STATUS ?? join(ROOT, 'bots', 'workers', 'lite-host.json'));
type LiteHostEntry = { snapshot: AccountSnapshot | null; state: string };
let liteHost: { at: number; bots: Map<string, LiteHostEntry> } = { at: 0, bots: new Map() };
function liteHostStatus() {
    if (Date.now() - liteHost.at < 10_000) return liteHost;
    liteHost.at = Date.now();
    const bots = new Map<string, LiteHostEntry>();
    // Any lite host's status file counts (bots/workers/lite-host.json plus per-group copies like bots/hylrc/lite-host.json).
    const statusFiles = new Set([LITE_HOST_STATUS]);
    try { for (const f of new Bun.Glob('bots/*/lite-host.json').scanSync(ROOT)) statusFiles.add(join(ROOT, f)); } catch { /* no bots dir */ }
    for (const file of statusFiles) {
        try { for (const [name, e] of parseLiteHostStatus(JSON.parse(readFileSync(file, 'utf8')))) bots.set(name, e); } catch { /* no lite host */ }
    }
    liteHost.bots = bots;
    return liteHost;
}
// Bots run inside bots/workers/script-host.ts (Phase 5): no process of their own to SIGSTOP; Pause/Resume go through
// the PAUSED file, which the host honours before every action. Status files: bots/*/script-host.json.
let scriptHosts: { at: number; bots: Map<string, HostedBot> } = { at: 0, bots: new Map() };
function hostedBots() {
    if (Date.now() - scriptHosts.at < 10_000) return scriptHosts.bots;
    scriptHosts.at = Date.now();
    const bots = new Map<string, HostedBot>();
    try {
        for (const f of new Bun.Glob('bots/*/script-host.json').scanSync(ROOT)) {
            const file = join(ROOT, f);
            try {
                const j = JSON.parse(readFileSync(file, 'utf8'));
                if (Date.parse(j?.at) < Date.now() - 120_000) continue; // stale: host gone
                for (const [n, b] of parseScriptHostStatus(j, file)) bots.set(n, b);
            } catch { /* unreadable */ }
        }
    } catch { /* no bots dir */ }
    scriptHosts.bots = bots;
    return bots;
}
// One `ps` snapshot for every account (was: ~74 pgrep + ps + lsof spawns per 30 s cycle). Pause/Resume force a fresh one.
let psCache: { at: number; rows: PsRow[] } | null = null;
function psRows(maxAgeMs = 30_000): PsRow[] {
    if (psCache && Date.now() - psCache.at < maxAgeMs) return psCache.rows;
    const out = Bun.spawnSync(['ps', '-axo', 'pid=,stat=,command=']).stdout.toString();
    psCache = { at: Date.now(), rows: parsePs(out) };
    return psCache.rows;
}
function loadAccounts(): AccountCfg[] {
    const cfg = readJson<{ accounts?: AccountCfg[] }>(ACCOUNTS_FILE);
    if (cfg?.accounts?.length) return cfg.accounts;
    // Fallback: a single lite account from BOT (old single-account behaviour).
    const bot = process.env.BOT ?? 'sokobot';
    log(`no ${ACCOUNTS_FILE} - falling back to single account ${bot}`);
    return [{ name: bot, botDir: join(ROOT, 'bots', bot), procMatch: [`${basename(ROOT)}/bots/${bot}/`], client: 'lite' }];
}

// ------------------------------------------------------------------ process matching (pause/resume)
type Proc = { pid: number; stat: string; stopped: boolean; kind: 'supervisor' | 'script'; cmd: string; script: string; hosted?: boolean };
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The script a runner process is executing: its first non-flag argument that is a script file, e.g.
//   bun /x/rs-sdk/bots/SOKO/forge.ts      bun --env-file=/x/bot.env /x/forge.ts      bash bots/sokobot/supervise.sh a.ts a.log
// Never matched: shell wrappers that merely mention a script (`zsh -c "... bots/x/y.sh ..."`, e.g. an
// agent's Bash tool command - freezing that would hang the agent), editors, tail -f monitors, greps.
const cwdCache = new Map<number, string | null>(); // a process never changes cwd here; entries are dropped with the pid
function cwdOf(pid: number): string | null {
    if (cwdCache.has(pid)) return cwdCache.get(pid)!;
    const r = Bun.spawnSync(['lsof', '-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    const v = r.stdout.toString().split('\n').find(l => l.startsWith('n'))?.slice(1) ?? null;
    if (cwdCache.size > 4000) cwdCache.clear();
    cwdCache.set(pid, v);
    return v;
}
const affiliationCache = new Map<string, { at: number; v: ReturnType<typeof dashboardProcessAffiliation> }>();
function scanProcs(account: string, patterns: string[], maxAgeMs = 30_000): Proc[] {
    // Candidates from the shared ps snapshot on the bot dir name (catches relative invocations), then resolve each
    // script to an absolute path (relative scripts against the process cwd) and match the full pattern.
    const needles = [...new Set(patterns.map(p => p.split('/').filter(Boolean).slice(-1).join('/') + '/'))];
    const res = patterns.map(p => new RegExp('(^|/)' + escRe(p.replace(/^\/+/, ''))));
    const rows = psCandidates(psRows(maxAgeMs), needles, [process.pid, process.ppid]);
    if (!rows.length) return [];
    const live = new Set(rows.map(r => r.pid));
    for (const pid of cwdCache.keys()) if (!live.has(pid) && !psCache!.rows.some(r => r.pid === pid)) cwdCache.delete(pid);
    const out: Proc[] = [];
    for (const row of rows) {
        const pid = row.pid;
        const key = `${pid}:${account}:${row.cmd}`;
        let aff = affiliationCache.get(key);
        if (!aff || Date.now() - aff.at > 5 * 60_000) { aff = { at: Date.now(), v: dashboardProcessAffiliation(pid, account, row.cmd) }; affiliationCache.set(key, aff); }
        if (affiliationCache.size > 4000) affiliationCache.clear();
        const affiliation = aff.v;
        if (affiliation.kind === 'foreign') continue;
        const cmd = affiliation.kind === 'self' ? affiliation.command : row.cmd;
        const script = dashboardRunnerScript(cmd);
        if (!script) continue;
        let full = script;
        if (!isAbsolute(script)) {
            const cwd = affiliation.kind === 'self' ? affiliation.cwd : cwdOf(pid);
            if (!cwd) continue;
            full = resolve(cwd, script);
        }
        if (!dashboardProcessCandidateAccepted(affiliation, res.some(r => r.test(full)))) continue;
        const kind = /(^|\/)supervis\w*\.(?:ts|sh)$/.test(full) || full.endsWith('.sh') ? 'supervisor' : 'script';
        out.push({ pid, stat: row.stat, stopped: row.stat.includes('T'), kind, cmd: cmd.slice(0, 200), script: full });
    }
    return out;
}
function signalAll(procs: Proc[], sig: 'SIGSTOP' | 'SIGCONT') {
    const done: number[] = [];
    for (const p of procs) { if (p.hosted) continue; try { process.kill(p.pid, sig); done.push(p.pid); } catch (e) { log(`${sig} ${p.pid} failed: ${errMsg(e)}`); } }
    return done;
}

// ------------------------------------------------------------------ shared helpers
const levelForXp = (xp: number) => { let L = 1; while (L < 99 && xp >= XP_FOR_LEVEL[L + 1]!) L++; return L; };
function skillXp(s: BotWorldState): Record<string, number> {
    const out: Record<string, number> = {};
    for (const k of s.skills ?? []) if ((SKILLS as readonly string[]).includes(k.name)) out[k.name] = k.experience;
    return out;
}
function tailFile(file: string, maxBytes = 24_000): string[] {
    const fd = openSync(file, 'r');
    try {
        const size = fstatSync(fd).size;
        const len = Math.min(size, maxBytes);
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, size - len);
        const lines = buf.toString('utf8').split('\n');
        if (size > len) lines.shift(); // partial first line
        return lines;
    } finally { closeSync(fd); }
}
const parseHm = (s: string): number | null => {
    const m = s.match(/(?:(\d+)h)?\s*(\d+)m/);
    return m ? Number(m[1] ?? 0) + Number(m[2]) / 60 : null;
};
function readBotEnv(botDir: string): { username: string; password: string; server: string } | null {
    const file = join(botDir, 'bot.env');
    if (!existsSync(file)) return null;
    const env: Record<string, string> = {};
    for (const line of readFileSync(file, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#') || !t.includes('=')) continue;
        env[t.slice(0, t.indexOf('=')).trim()] = t.slice(t.indexOf('=') + 1).trim();
    }
    if (!env.BOT_USERNAME || !env.PASSWORD) return null;
    return { username: env.BOT_USERNAME, password: env.PASSWORD, server: env.SERVER || 'rs-sdk-demo.fly.dev' };
}

// ------------------------------------------------------------------ plan types
type Phase = { name: string; skills?: string[]; estHours: number; status: 'done' | 'current' | 'upcoming' | 'skipped'; progress?: number; targetLevel?: number; startXp?: Record<string, number>; notes?: string };
type Plan = { updated?: string; note?: string; phases: Phase[]; runtime?: { currentPhaseId?: string | null } };
type Manifest = { phases?: { id?: string; targets?: Record<string, number> }[] };
type SupervisorTelemetry = { activeSince?: string | null; timeline?: { id?: string; status?: string }[] };
type Sample = { ts: string; t: number; totalXp: number; totalLevel: number; xp: Record<string, number> };
type PlaytimeFile = {
    baselineHours: number; baselineAt: string; note?: string;
    recordHours?: number; recordHolder?: string;
    tracked?: { since: string; loggedInHours: number; assumedHours: number; lastSeenAt: string | null; lastSeenLoggedIn: boolean };
};

// Global hiscores #1 (the record to beat), shared by all accounts.
let liveRecord: { holder: string; hours: number; level: string; fetchedAt: number } | null = null;

// ------------------------------------------------------------------ websocket bookkeeping
/** fps/quality: this viewer's own stream settings (Auto on its device), else the global prefs; lastFrameAt paces its frames. */
type WsData = { role: 'viewer'; id: number; account?: string; since: number; fps?: number; quality?: number; lastFrameAt?: number };
const viewerFps = (v: ServerWebSocket<WsData>) => v.data.fps ?? streamFps;
const viewerQuality = (v: ServerWebSocket<WsData>) => v.data.quality ?? streamQuality;
const viewers = new Set<ServerWebSocket<WsData>>();
let wsSeq = 0;

// ------------------------------------------------------------------ Account
type GoldRow = { t: number; total: number; coins: number; items: number; phase: string; note: string };
// Combined view of every money account (accounts.json "money": true, or any account with a gold-<name>.jsonl):
// per-account summaries, totals, combined gp/h (sum of per-account rates) and a combined GP series (5-minute grid,
// each account's latest sample carried forward; before its first sample an account counts at its first value, so
// staggered starts don't show up as fake growth).
// /highlights page data (best drops, achievements, earners, methods); cached - the loot logs are tens of thousands of lines
// big drops / maxed accounts as they land, for the dashboard toasts and the /highlights live feed
const liveEvents = new LiveEvents(ROOT).start();
const HIGHLIGHTS_TTL_MS = 60_000;
let highlightsCache: { at: number; v: unknown } | null = null;
function highlightsPayload() {
    if (highlightsCache && Date.now() - highlightsCache.at < HIGHLIGHTS_TTL_MS) return highlightsCache.v;
    let earners: any[] = [];
    try { earners = moneyOverview(0).accounts; } catch { /* gold rows mid-write */ }
    const v = buildHighlights(ROOT, earners);
    highlightsCache = { at: Date.now(), v };
    return v;
}

function moneyOverview(hours: number) {
    const list = [...accounts.values()].filter(a => a.cfg.money || a.goldRows().length);
    const per = list.map(a => ({ name: a.name, ...(a.goldSummary() ?? {}) as any, clues: a.clueSummary() }));
    const sum = (k: string) => per.reduce((x, p) => x + (Number.isFinite(p[k]) ? p[k] : 0), 0);
    const since = hours > 0 ? Date.now() - hours * 3.6e6 : 0;
    const rows = list.map(a => a.goldRows());
    const t0 = Math.max(since, Math.min(...rows.filter(r => r.length).map(r => r[0].t), Date.now()));
    const series: Array<[number, number]> = [];
    const STEP = 5 * 60_000;
    const idx = rows.map(() => 0);
    for (let t = Math.floor(t0 / STEP) * STEP; t <= Date.now() + STEP; t += STEP) {
        const tt = Math.min(t, Date.now());
        let tot = 0;
        rows.forEach((r, i) => { while (idx[i] + 1 < r.length && r[idx[i] + 1].t <= tt) idx[i]++; if (r.length) tot += r[idx[i]].total; });
        series.push([tt, tot]);
        if (tt === Date.now()) break;
    }
    const stalled = per.filter(p => p.stalled).map(p => ({ name: p.name, status: p.status, since: p.lastChangeAt ?? null }));
    return { accounts: per, total: sum('total'), coins: sum('coins'), items: sum('items'), gphRecent: sum('gphRecent'), gphOverall: sum('gphOverall'), stalled, series };
}

class Account {
    readonly name: string;
    readonly cfg: AccountCfg;
    readonly botDir: string;
    readonly client: 'managed' | 'lite';
    readonly env: ReturnType<typeof readBotEnv>;
    readonly playerName: string;
    readonly gatewayUrl: string;
    readonly httpGateway: string;
    readonly webOrigin: string;
    readonly pauseFile: string;
    readonly logDir: string;
    readonly historyFile: string;
    readonly playtimeFile: string;
    readonly tasksFile: string | null;
    readonly planFile: string | null;
    readonly supervisorFile: string | null;
    readonly manifestFile: string | null;
    readonly goldFile: string;
    goldCache: { mtime: number; size: number; rows: GoldRow[] } | null = null;

    sdk: BotSDK | null = null;
    observerError = '';
    observerStarting = false;
    observerLastReset = 0;
    observerTransportFailureAt = 0;
    gatewayPollFailureAt = 0;
    observerTransportFailing = false;
    gatewayPollFailing = false;
    observerRetryTimer: ReturnType<typeof setTimeout> | null = null;
    /** Last time a live-state consumer (/api/state, chat, lite scene, viewer select) asked for this account. */
    observerRequestedAt = 0;
    /** 15 s read of the managed page's skill tables (ManagedClient.pollSnapshot) - the observer-less XP source. */
    managedSnap: AccountSnapshot | null = null;
    gwStatus: { status: string; inGame: boolean; stateAge: number | null; controllers: number; observers: number; at: number } | null = null;
    history: Sample[] = [];
    /** Skill with the most recent XP gain (largest gain in that sample) - from the 1-min history, no extra polling. */
    lastTrained: { skill: string; t: number } | null = null;
    playtime: PlaytimeFile | null = null;
    playtimeDirty = false;
    lastPlaytimeFlush = 0;
    official: { hours: number | null; text: string; level: string; rank: string; fetchedAt: number; error?: string } | null = null;
    procCache: { at: number; procs: Proc[] } | null = null;
    takeover = !readPrefs().inputDisabled; // = input enabled (on by default; 'Disable input' in settings applies to every account and persists); only gates taps/keys, never pauses anything

    // stream
    frame: Uint8Array | null = null;
    frameSeq = 0;
    frameAt = 0;
    frameMeta: { w: number; h: number; page: string; visible: boolean } = { w: 0, h: 0, page: '', visible: true };
    frameTimes: number[] = [];
    mjpegClients = 0;
    inputsSent = 0;
    lastInputAt = 0;
    lastInputResult: any = null;
    managed: ManagedClient | null = null;
    summaryCache: { at: number; v: any } | null = null;

    constructor(cfg: AccountCfg) {
        this.cfg = cfg;
        this.name = cfg.name;
        this.botDir = abs(cfg.botDir)!;
        this.client = cfg.client === 'managed' ? 'managed' : 'lite';
        this.env = readBotEnv(this.botDir);
        if (this.env) SECRETS.push(this.env.password, encodeURIComponent(this.env.password));
        this.playerName = this.env?.username ?? cfg.name;
        const server = this.env?.server ?? 'rs-sdk-demo.fly.dev';
        this.gatewayUrl = deriveGatewayUrl(server);
        this.httpGateway = this.gatewayUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:').replace(/\/gateway$/, '');
        this.webOrigin = `${server.startsWith('localhost') ? 'http' : 'https'}://${server}`;
        this.pauseFile = join(this.botDir, 'PAUSED');
        this.logDir = abs(cfg.logDir) ?? this.botDir;
        this.historyFile = abs(cfg.historyFile) ?? join(DATA_DIR, `xp-history-${cfg.name}.jsonl`);
        this.playtimeFile = abs(cfg.playtimeFile) ?? join(DATA_DIR, `playtime-${cfg.name}.json`);
        this.tasksFile = abs(cfg.tasksFile) ?? join(this.botDir, 'tasks.json');
        this.planFile = abs(cfg.planFile) ?? join(this.botDir, 'plan.json');
        this.supervisorFile = abs(cfg.supervisorFile) ?? join(this.botDir, 'supervisor.json');
        this.manifestFile = abs(cfg.manifestFile) ?? join(this.botDir, 'manifest.json');
        this.goldFile = abs(cfg.goldFile) ?? join(DATA_DIR, `gold-${cfg.name}.jsonl`);
        if (this.client === 'managed') this.managed = new ManagedClient(this);
        this.loadHistory();
        this.initPlaytime();
    }

    /** The only files this server may write: data files under the dashboard repo / DATA_DIR, plus this account's PAUSED flag. */
    private writable(file: string) { return file === this.pauseFile || file.startsWith(ROOT + '/') || file.startsWith(DATA_DIR + '/'); }
    private safeWrite(file: string, data: string, append = false) {
        if (!this.writable(file)) throw new Error(`refusing to write outside ${ROOT}: ${file}`);
        mkdirSync(dirname(file), { recursive: true });
        if (append) appendFileSync(file, data); else writeFileSync(file, data);
    }
    // ---------------------------------------------------------------- bank wealth (account pills)
    bank: { total: number; coins: number; at: number } | null = null;
    private bankKey = ''; private bankValuedAt = 0; private bankBusy = false; private bankSeen = '';
    async refreshBank() {
        if (this.bankBusy) return;
        this.bankBusy = true;
        try {
            const { s } = this.snapshot();
            if (s?.bank?.isOpen && s.bank.items.length) { // record what the observer sees so every account has a snapshot
                const items = s.bank.items.map(i => ({ id: i.id, name: i.name, count: i.count }));
                const sig = JSON.stringify(items);
                if (sig !== this.bankSeen) { this.bankSeen = sig; this.safeWrite(join(DATA_DIR, `bank-${this.name}.json`), JSON.stringify({ at: new Date().toISOString(), items })); }
            }
            const snap = latestBankSnapshot(this.name, this.botDir, DATA_DIR);
            if (!snap) { this.bank = null; return; }
            const key = `${snap.source}@${snap.at}`;
            if (key === this.bankKey && Date.now() - this.bankValuedAt < 20 * 60_000) return;
            const v = await valueBank(snap.items);
            this.bank = { ...v, at: snap.at }; this.bankKey = key; this.bankValuedAt = Date.now(); this.summaryCache = null;
            this.recordWealth(v.total);
        } catch (e) { log(`[${this.name}] bank value failed: ${errMsg(e)}`); } finally { this.bankBusy = false; }
    }
    // Wealth history from bank valuations (every account, not just the money fleet): a gp/h for the account pills.
    private wealthFile() { return join(DATA_DIR, `wealth-${this.name}.jsonl`); }
    private recordWealth(total: number) {
        if (!Number.isFinite(total)) return;
        const last = this.wealthRows().at(-1);
        if (last && last.total === total && Date.now() - last.t < 6 * 3.6e6) return; // unchanged: keep the file small
        try { this.safeWrite(this.wealthFile(), JSON.stringify({ t: Date.now(), total }) + '\n', true); } catch (e) { log(`[${this.name}] wealth write failed: ${errMsg(e)}`); }
    }
    private wealthRows(): { t: number; total: number }[] {
        try { return readFileSync(this.wealthFile(), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
    }
    /** gp/h over the last ~6 h of bank valuations (needs >= 30 min between the samples compared). */
    wealthGph(): number | null {
        const rows = this.wealthRows(); if (rows.length < 2) return null;
        const last = rows.at(-1)!, cut = Date.now() - 6 * 3.6e6;
        const base = rows.find(r => r.t >= cut && last.t - r.t >= 30 * 60_000) ?? (rows[0]!.t < cut ? rows.filter(r => r.t < cut).at(-1)! : null);
        if (!base || last.t - base.t < 30 * 60_000) return null;
        return Math.round((last.total - base.total) / ((last.t - base.t) / 3.6e6));
    }
    questPoints(): number | null {
        const j = readJson<{ questPoints?: number }>(join(this.botDir, 'telemetry', 'quests-live.json'));
        return Number.isFinite(j?.questPoints) ? j!.questPoints! : null;
    }
    /** Client URL with credentials - only ever handed to the managed puppeteer page, never logged or served. */
    clientUrl() { return `${this.webOrigin}/bot?bot=${encodeURIComponent(this.env!.username)}&password=${encodeURIComponent(this.env!.password)}`; }
    matchesBot(bot: string | null | undefined) { return !!bot && (bot.toLowerCase() === this.name.toLowerCase() || bot.toLowerCase() === this.playerName.toLowerCase()); }

    // ---------------------------------------------------------------- observer (read-only)
    async startObserver() {
        if (this.observerStarting || this.sdk) return;
        if (NO_OBSERVER) { this.observerError = 'disabled (NO_OBSERVER=1)'; return; }
        if (!this.env) { this.observerError = `no credentials in ${join(this.botDir, 'bot.env')}`; return; }
        this.observerStarting = true;
        if (this.observerRetryTimer) { clearTimeout(this.observerRetryTimer); this.observerRetryTimer = null; }
        const s = new BotSDK({
            botUsername: this.env.username, password: this.env.password, gatewayUrl: this.gatewayUrl,
            connectionMode: 'observe', // read-only: the gateway rejects every action but chat from observers
            autoLaunchBrowser: false, readyTimeout: 0, connectTimeout: 20_000, autoReconnect: true, reconnectMaxDelay: 30_000, showChat: false,
        });
        this.sdk = s;
        s.onConnectionStateChange(state => {
            if (this.sdk !== s) return;
            if (state === 'reconnecting') {
                this.observerTransportFailing = true;
                this.observerTransportFailureAt = Date.now();
            } else if (state === 'connected') {
                const recovered = updateGatewayTransportFailure(this.observerTransportFailureAt, null, Date.now());
                this.observerTransportFailing = recovered.failing;
                this.observerTransportFailureAt = recovered.lastFailureAt;
            }
        });
        try {
            await s.connect();
            this.observerError = '';
            const recovered = updateGatewayTransportFailure(this.observerTransportFailureAt, null, Date.now());
            this.observerTransportFailing = recovered.failing;
            this.observerTransportFailureAt = recovered.lastFailureAt;
            log(`[${this.name}] observer connected to ${this.gatewayUrl} as ${this.env.username} (observe mode)`);
        } catch (e) {
            this.observerError = errMsg(e);
            const failure = updateGatewayTransportFailure(this.observerTransportFailureAt,
                this.observerError, Date.now());
            this.observerTransportFailing = failure.failing;
            this.observerTransportFailureAt = failure.lastFailureAt;
            log(`[${this.name}] observer connect failed: ${this.observerError} - retrying in 15s`);
            try { await s.disconnect(); } catch {}
            if (this.sdk === s) this.sdk = null;
            this.observerRetryTimer = setTimeout(() => { this.observerRetryTimer = null; if (this.wantObserver()) void this.startObserver(); }, 15_000);
        } finally {
            this.observerStarting = false;
        }
    }
    // A half-open observer socket can stay "connected" with a stale cached state; the public gateway
    // status is independent evidence. Recreate only this read-only observer when they disagree.
    wantObserver() {
        return !NO_OBSERVER && observerWanted({ always: OBSERVERS_ALWAYS, viewers: this.viewersOf().length, lastRequestAt: this.observerRequestedAt, now: Date.now(), idleMs: OBSERVER_IDLE_MS });
    }
    /** A live-state consumer wants this account: (re)start the observer and keep it for OBSERVER_IDLE_MS. */
    ensureObserver(why = 'api') {
        this.observerRequestedAt = Date.now();
        if (!this.sdk && !this.observerStarting && !this.observerRetryTimer) { log(`[${this.name}] observer requested (${why})`); void this.startObserver(); }
    }
    async stopObserver(why: string) {
        if (this.observerRetryTimer) { clearTimeout(this.observerRetryTimer); this.observerRetryTimer = null; }
        const old = this.sdk; this.sdk = null;
        if (!old) return;
        log(`[${this.name}] observer disconnected (${why})`);
        await Promise.race([old.disconnect().catch(() => {}), sleep(5000)]);
    }
    /** 10 s tick: connect wanted observers, drop idle ones, recover half-open ones. */
    async syncObserver() {
        const want = this.wantObserver();
        if (want && !this.sdk && !this.observerStarting) return void this.startObserver();
        if (!want && (this.sdk || this.observerRetryTimer)) return void this.stopObserver('idle');
        if (want) await this.recoverObserver();
    }
    observerStatus(): 'idle' | 'connecting' | 'connected' {
        if (this.sdk?.isConnected()) return 'connected';
        return this.sdk || this.observerStarting || this.observerRetryTimer ? 'connecting' : 'idle';
    }
    async recoverObserver() {
        if (NO_OBSERVER || this.observerStarting || Date.now() - this.observerLastReset < 30_000 || !this.wantObserver()) return;
        const gw = this.gwStatus;
        if (!(gw?.inGame && gw.stateAge != null && gw.stateAge < 10_000)) return;
        const st = this.sdk?.getState() ?? null;
        const age = st && this.sdk ? this.sdk.getStateAge() : Infinity;
        if (this.sdk && this.sdk.isConnected() && age <= 30_000) return;
        this.observerLastReset = Date.now();
        this.observerError = `observer recovery: local state ${Number.isFinite(age) ? Math.round(age / 1000) + 's old' : 'missing'} while gateway is fresh`;
        log(`[${this.name}] ${this.observerError}`);
        const old = this.sdk; this.sdk = null;
        if (old) await Promise.race([old.disconnect().catch(() => {}), sleep(5000)]);
        await this.startObserver();
    }
    /** Recent in-game chat for the beta-fullscreen overlay: every type (game, public, private), own lines included. */
    chatFeed(since: number) {
        this.ensureObserver('chat');
        const msgs = this.sdk?.getChat({ limit: 40, types: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], includeSelf: true }) ?? [];
        const out = msgs.map((m, i) => ({ id: m.observationId ?? m.tick * 100 + i, type: m.type, sender: m.sender, text: redact(m.text), self: m.fromSelf }));
        const st = this.sdk?.getState();
        // dialog: the chat-box interface (NPC/player chat, 'click here to continue', options) is open
        return { messages: out.filter(m => m.id > since).slice(-12), dialog: !!st?.dialog?.isOpen, bank: !!st?.bank?.isOpen };
    }
    snapshot() {
        const s: BotWorldState | null = this.sdk?.getState() ?? null;
        const age = s && this.sdk ? this.sdk.getStateAge() : Infinity;
        return { s, age, fresh: !!s && age < FRESH_MS && !!s.inGame && !!s.player };
    }
    /** Coarse account state from whichever source is up: observer (watched), lite-host status, managed page poll. */
    lastSnapshot(): AccountSnapshot | null {
        const { s, age } = this.snapshot();
        let obs: AccountSnapshot | null = null;
        if (s?.player && s.skills?.length) {
            const levels: Record<string, number> = {};
            for (const k of s.skills) if ((SKILLS as readonly string[]).includes(k.name)) levels[k.name] = k.baseLevel;
            const inv = new Map<string, number>();
            for (const it of s.inventory ?? []) inv.set(it.name, (inv.get(it.name) ?? 0) + it.count);
            obs = { source: 'observer', at: Date.now() - (Number.isFinite(age) ? age : 1e9), inGame: !!s.inGame, xp: skillXp(s), levels,
                hp: [s.player.hp, s.player.maxHp], pos: [s.player.worldX, s.player.worldZ, s.player.level], invUsed: s.inventory?.length ?? null, inv: [...inv] };
        }
        return pickSnapshot([obs, liteHostStatus().bots.get(this.name.toLowerCase())?.snapshot ?? null, this.managedSnap]);
    }
    async pollGateway() {
        try {
            const r = await fetch(`${this.httpGateway}/status/${encodeURIComponent(this.playerName)}`, { signal: AbortSignal.timeout(8000) });
            if (!r.ok) throw new Error(`gateway status HTTP ${r.status}`);
            const j: any = await r.json();
            this.gwStatus = { status: j.status, inGame: !!j.inGame, stateAge: j.stateAge ?? null, controllers: j.controllers?.length ?? 0, observers: j.observers?.length ?? 0, at: Date.now() };
            this.gatewayPollFailing = false;
        } catch {
            this.gatewayPollFailing = true;
            this.gatewayPollFailureAt = Date.now(); /* keep last successful status */
        }
    }

    // ---------------------------------------------------------------- XP history
    loadHistory() {
        if (!existsSync(this.historyFile)) return;
        for (const line of readFileSync(this.historyFile, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            try {
                const j = JSON.parse(line);
                const t = Date.parse(j.ts);
                if (Number.isFinite(t) && j.xp) this.history.push({ ts: j.ts, t, totalXp: j.totalXp, totalLevel: j.totalLevel, xp: j.xp });
            } catch { /* skip corrupt line */ }
        }
        this.history.sort((a, b) => a.t - b.t);
        for (let i = this.history.length - 1; i > 0 && !this.lastTrained; i--) this.noteTraining(this.history[i - 1], this.history[i]);
        log(`[${this.name}] loaded ${this.history.length} xp samples from ${this.historyFile}`);
    }
    takeSample() {
        const snap = this.lastSnapshot();
        if (!snapshotFresh(snap) || !snap?.xp) return;
        const now = Date.now();
        if (this.history.length && now - this.history.at(-1)!.t < SAMPLE_MS - 2000) return;
        const xp = snap.xp;
        if (Object.keys(xp).length < SKILLS.length) return;
        const totalXp = SKILLS.reduce((a, k) => a + (xp[k] ?? 0), 0);
        const totalLevel = SKILLS.reduce((a, k) => a + levelForXp(xp[k] ?? 0), 0);
        const sample: Sample = { ts: new Date(now).toISOString(), t: now, totalXp, totalLevel, xp };
        const prev = this.history.at(-1);
        this.history.push(sample);
        if (prev) this.noteTraining(prev, sample);
        try { this.safeWrite(this.historyFile, JSON.stringify({ ts: sample.ts, totalXp, totalLevel, xp }) + '\n', true); } catch (e) { log(`[${this.name}] history write failed: ${errMsg(e)}`); }
    }
    noteTraining(prev: Sample, cur: Sample) {
        let best = '', gain = 0;
        for (const k of SKILLS) { const d = (cur.xp[k] ?? 0) - (prev.xp[k] ?? 0); if (d > gain && d < 1e6) { gain = d; best = k; } }
        if (best) this.lastTrained = { skill: best, t: cur.t };
    }
    rateOver(minutes: number, cur: Record<string, number>, curTotal: number) {
        const now = Date.now(), from = now - minutes * 60_000, h = this.history;
        let lo = 0, hi = h.length; // first sample at/after `from` (history is time-sorted)
        while (lo < hi) { const mid = (lo + hi) >> 1; if (h[mid].t < from) lo = mid + 1; else hi = mid; }
        const base = h[lo];
        if (!base) return null;
        const hrs = (now - base.t) / 3.6e6;
        if (hrs < 3 / 60) return null; // < 3 minutes of data
        const perSkill: Record<string, number> = {};
        for (const k of SKILLS) perSkill[k] = Math.max(0, ((cur[k] ?? 0) - (base.xp[k] ?? cur[k] ?? 0)) / hrs);
        return { spanMinutes: Math.round(hrs * 60), perSkill, total: Math.max(0, (curTotal - base.totalXp) / hrs) };
    }
    // ---------------------------------------------------------------- gold (money accounts)
    goldRows(): GoldRow[] {
        try {
            const st = statSync(this.goldFile);
            if (this.goldCache && this.goldCache.mtime === st.mtimeMs && this.goldCache.size === st.size) return this.goldCache.rows;
            const rows: GoldRow[] = [];
            for (const line of readFileSync(this.goldFile, 'utf8').split('\n')) {
                if (!line.trim()) continue;
                try { const r = JSON.parse(line); if (Number.isFinite(r.ts) && Number.isFinite(r.total)) rows.push({ t: r.ts, total: r.total, coins: r.coins ?? 0, items: r.itemValue ?? 0, phase: r.phase ?? '', note: r.note ?? '' }); } catch { }
            }
            rows.sort((a, b) => a.t - b.t);
            this.goldCache = { mtime: st.mtimeMs, size: st.size, rows };
            return rows;
        } catch { return []; }
    }
    goldSummary() {
        const rows = this.goldRows();
        if (!rows.length) return this.cfg.money ? { total: null, coins: null, items: null, gphRecent: null, gphOverall: null, since: null, at: null, phase: '', samples: 0 } : null;
        const last = rows.at(-1)!, first = rows[0];
        const rate = (a: GoldRow, b: GoldRow) => (b.t - a.t >= 10 * 60_000 ? Math.round((b.total - a.total) / ((b.t - a.t) / 3.6e6)) : null);
        // recent = the last 60 minutes (from the newest sample at or before now-60m, else the oldest sample)
        const cut = last.t - 60 * 60_000;
        let base = first; for (const r of rows) { if (r.t <= cut) base = r; else break; }
        // stall detection: no change in total wealth (or no sample at all) for STALL_MS => "stalled"
        let lastChangeAt = first.t;
        for (let i = 1; i < rows.length; i++) if (rows[i].total !== rows[i - 1].total) lastChangeAt = rows[i].t;
        const STALL_MS = 30 * 60_000;
        const stalled = Date.now() - lastChangeAt > STALL_MS;
        // A questing account's wealth is flat by design: recent quest-runner activity is progress, not a stall.
        let questingAt = 0;
        for (const f of [join(this.botDir, 'quests-run.log'), join(this.botDir, 'telemetry', 'quests-events.jsonl')])
            try { questingAt = Math.max(questingAt, statSync(f).mtimeMs); } catch { }
        const questing = Date.now() - questingAt < STALL_MS;
        const status = questing && (stalled || Date.now() - last.t > STALL_MS) ? 'questing'
            : Date.now() - last.t > STALL_MS ? 'no samples' : stalled ? 'stalled' : 'earning';
        return { total: last.total, coins: last.coins, items: last.items, gphRecent: rate(base, last), gphOverall: rate(first, last), since: first.t, at: last.t, phase: last.phase, samples: rows.length, lastChangeAt, stalled: status !== 'earning' && status !== 'questing', status };
    }
    // Treasure Trail rows from telemetry/clues-<name>.jsonl (bots/money/clues.ts). Legacy rows carry
    // {items: {name: count}, value} instead of {outcome, rewards, rewardValue}; rows with neither are bogus.
    clueRows(): any[] {
        const f = join(DATA_DIR, `clues-${this.name}.jsonl`);
        if (!existsSync(f)) return [];
        const out: any[] = [];
        for (const line of readFileSync(f, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            let r: any; try { r = JSON.parse(line); } catch { continue; }
            if (r.outcome !== 'abandoned' && !r.outcome && !Object.keys(r.items ?? {}).length) continue;
            out.push(r);
        }
        return out;
    }
    // Summary: done by tier, value, best, avg
    clueSummary() {
        if (!existsSync(join(DATA_DIR, `clues-${this.name}.jsonl`))) return null;
        const done: Record<string, number> = {}; let n = 0, total = 0, abandoned = 0; let best: { name: string; value: number } | null = null;
        for (const r of this.clueRows()) {
            if (r.outcome === 'abandoned') { abandoned++; continue; }
            const v = Number(r.rewardValue ?? r.value ?? 0);
            n++; total += v; done[r.tier ?? 'easy'] = (done[r.tier ?? 'easy'] ?? 0) + 1;
            const b = r.best ?? (r.rewards ? r.rewards.slice().sort((a: any, c: any) => c.value - a.value)[0] : null);
            if (b && (!best || b.value > best.value)) best = { name: b.name, value: b.value };
        }
        return { done: n, byTier: done, totalValue: total, avgValue: n ? Math.round(total / n) : 0, best, abandoned };
    }
    // Full clue view for the dashboard's Clue scrolls card: trail history (newest first) and every reward item
    // aggregated by name, highest total value first (legacy rows have counts but no per-item value).
    clueDetail() {
        const rows = this.clueRows();
        const items = new Map<string, { name: string; count: number; value: number | null; drops: number; bestDrop: number | null; lastAt: string | null }>();
        const add = (name: string, count: number, value: number | null, at: string | null) => {
            const it = items.get(name) ?? { name, count: 0, value: null, drops: 0, bestDrop: null, lastAt: null };
            it.count += count; it.drops++;
            if (value != null) { it.value = (it.value ?? 0) + value; it.bestDrop = Math.max(it.bestDrop ?? 0, value); }
            if (at && (!it.lastAt || at > it.lastAt)) it.lastAt = at;
            items.set(name, it);
        };
        const history = rows.map(r => {
            const rewards: Array<{ name: string; count: number; value: number | null }> = r.rewards
                ? r.rewards.map((x: any) => ({ name: x.name, count: Number(x.count ?? 1), value: Number.isFinite(x.value) ? x.value : null }))
                : Object.entries(r.items ?? {}).map(([name, count]) => ({ name, count: Number(count), value: null }));
            if (r.outcome !== 'abandoned') for (const x of rewards) add(x.name, x.count, x.value, r.t ?? null);
            return {
                t: r.t ?? null, outcome: r.outcome ?? 'completed', tier: r.tier ?? 'easy',
                steps: Array.isArray(r.steps) ? r.steps.filter((s: any) => s.ok).length : Number(r.steps ?? 0),
                stepList: Array.isArray(r.steps) ? r.steps.filter((s: any) => s.ok).map((s: any) => s.desc ?? `${s.type} ${s.clue}`) : [],
                minutes: r.minutes ?? (r.totalMs ? Math.round(r.totalMs / 60_000) : null),
                value: Number(r.rewardValue ?? r.value ?? 0), rewards, drop: r.drop?.npc ?? null, reason: r.reason ?? null,
            };
        }).reverse();
        const best = [...items.values()].sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || b.count - a.count);
        return { summary: this.clueSummary(), history, items: best };
    }
    goldSeries(hours: number) {
        const since = hours > 0 ? Date.now() - hours * 3.6e6 : 0;
        const pts = this.goldRows().filter(r => r.t >= since);
        const step = Math.max(1, Math.ceil(pts.length / 400));
        return pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map(r => [r.t, r.total, r.coins, r.items]);
    }

    historySeries(hours: number) {
        const since = hours > 0 ? Date.now() - hours * 3.6e6 : 0;
        const pts = this.history.filter(h => h.t >= since);
        const step = Math.max(1, Math.ceil(pts.length / 400));
        const out = pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map(h => [h.t, h.totalXp, h.totalLevel]);
        const { s, fresh } = this.snapshot();
        if (fresh && s) { const xp = skillXp(s); out.push([Date.now(), SKILLS.reduce((a, k) => a + (xp[k] ?? 0), 0), SKILLS.reduce((a, k) => a + levelForXp(xp[k] ?? 0), 0)]); }
        return out;
    }

    // ---------------------------------------------------------------- play time
    initPlaytime() {
        if (!existsSync(this.playtimeFile)) {
            try {
                this.safeWrite(this.playtimeFile, JSON.stringify({ baselineHours: this.cfg.baselineHours ?? 0, baselineAt: new Date().toISOString(), note: 'dashboard tracking start' }, null, 2) + '\n');
                log(`[${this.name}] created ${this.playtimeFile}`);
            } catch (e) { log(`[${this.name}] playtime create failed: ${errMsg(e)}`); }
        }
        this.playtime = readJson<PlaytimeFile>(this.playtimeFile);
    }
    playtimeTick() {
        const disk = readJson<PlaytimeFile>(this.playtimeFile);
        if (!disk || !Number.isFinite(disk.baselineHours) || !disk.baselineAt) return; // mid-edit / invalid: leave it alone
        const pt = this.playtime;
        const tracked = (pt?.tracked && pt.tracked.since === disk.baselineAt) ? pt.tracked
            : (disk.tracked && disk.tracked.since === disk.baselineAt) ? disk.tracked
            : { since: disk.baselineAt, loggedInHours: 0, assumedHours: 0, lastSeenAt: null, lastSeenLoggedIn: false };
        const now = Date.now();
        const { fresh } = this.snapshot();
        const gw = this.gwStatus;
        const gatewayLoggedIn = !!gw?.inGame && gw.stateAge != null && gw.stateAge < FRESH_MS && now - gw.at < 30_000;
        const loggedIn = fresh || gatewayLoggedIn || snapshotFresh(this.lastSnapshot());
        if (loggedIn && tracked.lastSeenAt && tracked.lastSeenLoggedIn) {
            const gap = Math.max(0, now - Date.parse(tracked.lastSeenAt));
            if (gap <= 90_000) tracked.loggedInHours += gap / 3.6e6; // only continuously corroborated intervals
        }
        const changed = tracked.lastSeenLoggedIn !== loggedIn || loggedIn;
        tracked.lastSeenAt = new Date(now).toISOString();
        tracked.lastSeenLoggedIn = loggedIn;
        this.playtime = { ...disk, tracked };
        this.playtimeDirty = this.playtimeDirty || changed;
        if (this.playtimeDirty && now - this.lastPlaytimeFlush > 60_000) this.flushPlaytime();
    }
    flushPlaytime() {
        if (!this.playtime) return;
        try { this.safeWrite(this.playtimeFile, JSON.stringify(this.playtime, null, 2) + '\n'); this.playtimeDirty = false; this.lastPlaytimeFlush = Date.now(); }
        catch (e) { log(`[${this.name}] playtime write failed: ${errMsg(e)}`); }
    }
    async pollHiscores() {
        if (NO_HISCORES) return;
        try {
            const r = await fetch(`${this.webOrigin}/hiscores/player/${encodeURIComponent(this.playerName.toLowerCase())}`, { signal: AbortSignal.timeout(10_000) });
            const html = await r.text();
            const m = html.match(/>Overall<\/a>\s*<\/td>\s*<td[^>]*>\s*([^<]*?)\s*<\/td>\s*<td[^>]*>\s*([^<]*?)\s*<\/td>\s*<td[^>]*>\s*([^<]*?)\s*<\/td>/);
            this.official = m ? { rank: m[1]!, level: m[2]!, text: m[3]!, hours: parseHm(m[3]!), fetchedAt: Date.now() }
                : { rank: '-', level: '-', text: '-', hours: null, fetchedAt: Date.now(), error: r.ok ? 'no Overall row' : `HTTP ${r.status}` };
        } catch (e) {
            this.official = { rank: '-', level: '-', text: '-', hours: null, fetchedAt: Date.now(), error: errMsg(e) };
        }
    }

    // ---------------------------------------------------------------- plan / tasks / log / supervisor
    activePhaseRate(xpNow: Record<string, number>, plan: Plan, supervisor: SupervisorTelemetry | null) {
        const phaseId = plan.runtime?.currentPhaseId;
        const activeAt = Date.parse(String(supervisor?.activeSince ?? ''));
        if (!phaseId || !Number.isFinite(activeAt)) return null;
        if (Date.now() - activeAt < 3 * 60_000) return null;
        // Skip 30 s after a phase boundary so a reward or the previous phase's last action doesn't count.
        const base = this.history.find(h => h.t >= activeAt + 30_000);
        if (!base) return null;
        const hours = (Date.now() - base.t) / 3.6e6;
        if (hours < 2 / 60) return null;
        const targets = readJson<Manifest>(this.manifestFile)?.phases?.find(p => p.id === phaseId)?.targets ?? {};
        const rates: Record<string, number> = {};
        for (const skill of Object.keys(targets)) {
            if (!(SKILLS as readonly string[]).includes(skill)) continue;
            rates[skill] = Math.max(0, ((xpNow[skill] ?? 0) - (base.xp[skill] ?? xpNow[skill] ?? 0)) / hours);
        }
        if (!Object.values(rates).some(rate => rate > 0)) return null;
        return { phaseId, spanMinutes: Math.round(hours * 60), rates };
    }
    planRemaining(xpNow: Record<string, number> | null) {
        const plan = readJson<Plan>(this.planFile);
        if (!plan || !Array.isArray(plan.phases)) return { plan: null, hours: null as number | null, phases: [] as any[] };
        const supervisor = readJson<SupervisorTelemetry>(this.supervisorFile);
        const questSteps = (supervisor?.timeline ?? []).filter(step => /^q_/.test(step.id ?? ''));
        const questProgress = questSteps.length ? questSteps.filter(step => step.status === 'done').length / questSteps.length : null;
        let hours = 0;
        const phases = plan.phases.map(p => {
            const target = XP_FOR_LEVEL[Math.min(99, Math.max(2, p.targetLevel ?? 99))]!;
            let status = p.status ?? 'upcoming';
            let progress = Number.isFinite(p.progress) ? Math.min(1, Math.max(0, p.progress!)) : 0;
            let basis = Number.isFinite(p.progress) ? 'explicit' : 'untracked';
            const skills = (p.skills ?? []).filter(k => (SKILLS as readonly string[]).includes(k));
            if (xpNow && skills.length) {
                if (skills.every(k => (xpNow[k] ?? 0) >= target)) { status = 'done'; progress = 1; basis = 'verified-target'; }
                else if (!Number.isFinite(p.progress) && p.startXp) {
                    const fr = skills.map(k => { const s0 = p.startXp![k] ?? 0; return Math.min(1, Math.max(0, ((xpNow[k] ?? 0) - s0) / Math.max(1, target - s0))); });
                    progress = fr.reduce((a, b) => a + b, 0) / fr.length;
                    basis = 'xp-from-phase-start';
                } else if (!Number.isFinite(p.progress)) {
                    const fr = skills.map(k => Math.min(1, Math.max(0, (xpNow[k] ?? 0) / Math.max(1, target))));
                    progress = fr.reduce((a, b) => a + b, 0) / fr.length;
                    basis = 'target-xp';
                }
            } else if (!skills.length && /^Quest\b/i.test(p.name) && !Number.isFinite(p.progress) && questProgress != null) {
                progress = questProgress;
                basis = 'quest-checkpoints';
            }
            const remaining = status === 'done' || status === 'skipped' ? 0 : Math.max(0, (Number(p.estHours) || 0) * (1 - progress));
            hours += remaining;
            return { name: p.name, skills, estHours: Number(p.estHours) || 0, status, progress, basis, remainingHours: remaining, notes: p.notes ?? '' };
        });
        const measured = xpNow ? this.activePhaseRate(xpNow, plan, supervisor) : null;
        return { plan: { updated: plan.updated ?? null, note: plan.note ?? null, measured }, hours, phases };
    }
    activity() {
        const tasks = readJson<{ goal?: string; current?: string; tasks?: { title: string; status: string }[] }>(this.tasksFile);
        let logInfo: { file: string; mtime: number; lines: string[] } | null = null;
        try {
            const latest = latestAccountActivityLog(this.logDir, this.botDir);
            if (latest) {
                const lines = tailFile(latest.path).map(l => redact(l.trimEnd())).filter(Boolean).slice(-10).map(l => l.slice(0, 400));
                logInfo = { file: latest.file, mtime: latest.mtime, lines };
            }
        } catch { /* no logs */ }
        const mtime = (f: string) => { try { return statSync(f).mtimeMs; } catch { return null; } };
        const runLog = join(this.botDir, 'quests-run.log');
        let questRun = null;
        try { if (existsSync(runLog)) questRun = parseQuestRunLog(readTail(runLog)); } catch { /* no loop log */ }
        const live = readJson<{ observedAt?: string; quests?: LiveQuest[]; completed?: number; total?: number; questPoints?: number; totalQuestPoints?: number }>(join(this.botDir, 'telemetry', 'quests-live.json'));
        const summary = summarizeActivity({
            account: this.name, now: Date.now(), tasks, tasksMtime: mtime(this.tasksFile),
            procs: this.procs(5000), lastLogLine: logInfo?.lines.at(-1) ?? null, logMtime: logInfo?.mtime ?? null,
            questRun, liveQuests: live?.quests ?? [],
            questPoints: live?.total && Date.now() - Date.parse(String(live.observedAt)) < 3.6e6 ? { done: live.completed ?? 0, total: live.total, qp: live.questPoints ?? 0, totalQp: live.totalQuestPoints ?? 0 } : null,
        });
        return { ...summary, log: logInfo };
    }
    supervisorStatus() {
        const raw = readJson<Record<string, any>>(this.supervisorFile);
        if (!raw) return null;
        const heartbeatAt = raw.heartbeatAt ?? raw.updatedAt ?? null;
        const heartbeatMs = heartbeatAt ? Date.parse(String(heartbeatAt)) : NaN;
        const errors = Array.isArray(raw.errors) ? raw.errors : raw.errors ? [raw.errors] : raw.lastError ? [raw.lastError] : [];
        return {
            ...raw,
            status: String(raw.status ?? 'unknown'),
            current: String(raw.current ?? raw.currentScript ?? ''),
            heartbeatAt,
            heartbeatAgeMs: Number.isFinite(heartbeatMs) ? Math.max(0, Date.now() - heartbeatMs) : null,
            heartbeatFresh: Number.isFinite(heartbeatMs) && Date.now() - heartbeatMs < 90_000,
            errors: errors.slice(-10).map((e: any) => redact(typeof e === 'string' ? e : JSON.stringify(e))),
            file: this.supervisorFile,
        };
    }

    // ---------------------------------------------------------------- pause / resume
    procs(maxAgeMs = 1000): Proc[] {
        if (this.procCache && Date.now() - this.procCache.at < maxAgeMs) return this.procCache.procs;
        // Status reads share one 30 s ps snapshot; Pause/Resume (maxAgeMs 0) take a fresh one.
        const procs = scanProcs(this.name, this.cfg.procMatch ?? [], maxAgeMs === 0 ? 0 : 30_000);
        const hosted = hostedBots().get(this.name.toLowerCase());
        if (hosted) procs.push({ pid: hosted.hostPid, stat: hosted.paused ? 'T' : 'S', stopped: hosted.paused, kind: 'script', hosted: true,
            cmd: `script-host ${hosted.script} (${hosted.state}${hosted.restarts ? `, ${hosted.restarts} restarts` : ''}${hosted.lastError ? `, last error: ${hosted.lastError}` : ''})`, script: hosted.entry ? join(ROOT, hosted.entry) : hosted.statusFile });
        this.procCache = { at: Date.now(), procs };
        return procs;
    }
    pauseInfo() {
        const paused = existsSync(this.pauseFile);
        let pausedAt: string | null = null;
        if (paused) pausedAt = readJson<{ pausedAt?: string }>(this.pauseFile)?.pausedAt ?? new Date(statSync(this.pauseFile).mtimeMs).toISOString();
        return { paused, pausedAt };
    }
    pause(reason: string) {
        // PAUSED first: a supervisor that isn't frozen (or starts later) waits instead of restarting scripts.
        this.safeWrite(this.pauseFile, JSON.stringify({ pausedAt: this.pauseInfo().pausedAt ?? new Date().toISOString(), by: 'dashboard', reason }) + '\n');
        const procs = this.procs(0);
        const stopped = signalAll([...procs.filter(p => p.kind === 'supervisor'), ...procs.filter(p => p.kind === 'script')], 'SIGSTOP');
        this.procCache = null;
        const hosted = procs.filter(p => p.hosted).length;
        log(`[${this.name}] PAUSE (${reason}): SIGSTOP ${stopped.join(', ') || '(no bot processes)'}${hosted ? `; ${hosted} hosted bot(s) pause via PAUSED` : ''}; wrote ${this.pauseFile}`);
        return stopped;
    }
    resume() {
        try { unlinkSync(this.pauseFile); } catch { /* not paused */ }
        const procs = this.procs(0);
        const resumed = signalAll([...procs.filter(p => p.kind === 'script'), ...procs.filter(p => p.kind === 'supervisor')], 'SIGCONT');
        this.procCache = null;
        log(`[${this.name}] RESUME: SIGCONT ${resumed.join(', ') || '(no bot processes)'}; removed ${this.pauseFile}`);
        return resumed;
    }
    automationStatus() {
        const procs = this.procs();
        const { paused, pausedAt } = this.pauseInfo();
        return { paused, pausedAt, takeover: this.takeover, procs, runningWhilePaused: paused ? procs.filter(p => !p.stopped).length : 0, stoppedCount: procs.filter(p => p.stopped).length, pauseFile: this.pauseFile, match: (this.cfg.procMatch ?? []).join(' | ') };
    }

    // ---------------------------------------------------------------- stream
    viewersOf() { return [...viewers].filter(v => v.data.account === this.name); }
    viewerCount() { return this.viewersOf().length + this.mjpegClients; }
    onFrame(buf: Uint8Array, meta?: Partial<Account['frameMeta']>) {
        this.frame = buf;
        this.frameSeq++;
        this.frameAt = Date.now();
        this.frameTimes.push(this.frameAt);
        if (meta) this.frameMeta = { ...this.frameMeta, ...meta };
        this.sendFrames(new Map([[streamQuality, buf]]), true);
    }
    /** Encoded frames by quality: every viewer that is due (its own fps) and not backed up gets the one at its quality. */
    sendFrames(byQuality: Map<number, Uint8Array>, any = false) {
        const now = Date.now();
        for (const v of this.viewersOf()) {
            const buf = byQuality.get(viewerQuality(v)) ?? (any ? byQuality.values().next().value : undefined);
            if (!buf || v.getBufferedAmount() >= 1_000_000) continue;
            if (v.data.lastFrameAt && now - v.data.lastFrameAt < 1000 / viewerFps(v) - 8) continue;
            v.data.lastFrameAt = now;
            v.send(buf);
        }
    }
    /** Highest frame rate any viewer of this account wants (the capture + game render rate). */
    maxViewerFps() { return Math.max(this.mjpegClients ? streamFps : 0, ...this.viewersOf().map(viewerFps)); }
    streamStatus() {
        const now = Date.now();
        while (this.frameTimes.length && now - this.frameTimes[0]! > 5000) this.frameTimes.shift();
        return {
            client: this.client,
            managed: this.managed?.info() ?? null,
            frameAt: this.frameAt, frameAgeMs: this.frameAt ? now - this.frameAt : null, fps: Math.round(this.frameTimes.length / 5 * 10) / 10,
            w: this.frameMeta.w, h: this.frameMeta.h, page: this.frameMeta.page, tabVisible: this.frameMeta.visible,
            viewers: this.viewerCount(), targetFps: streamFps, quality: streamQuality, idleFps: IDLE_FPS, gameFps: this.managed?.gameFps ?? null, inputsSent: this.inputsSent, lastInputAt: this.lastInputAt, lastInputResult: this.lastInputResult,
        };
    }
    statusMessage() { return JSON.stringify({ type: 'status', account: this.name, automation: this.automationStatus(), stream: this.streamStatus() }); }
    broadcastStatus() {
        const vs = this.viewersOf();
        if (!vs.length) return;
        const msg = this.statusMessage();
        for (const v of vs) v.send(msg);
    }

    // ---------------------------------------------------------------- page state
    /** True when the dashboard simulates the view (no frames): every non-managed account, or a managed one with cfg.lite. */
    get lite(): boolean { return this.client === 'lite' || !!this.cfg.lite; }
    liteSceneCache: { at: number; v: any } | null = null;
    liteScene() {
        this.ensureObserver('lite scene');
        if (this.liteSceneCache && Date.now() - this.liteSceneCache.at < 250) return this.liteSceneCache.v;
        const { s, age } = this.snapshot();
        const v = s?.player ? { ok: true, account: this.name, scene: buildLiteScene(s, { redact, activity: this.summary().activity, stateAgeMs: Number.isFinite(age) ? age : null }) }
            : { ok: false, account: this.name, error: this.observerError || (s ? 'not in game' : `observer ${this.observerStatus()}`) };
        this.liteSceneCache = { at: Date.now(), v };
        return v;
    }
    /** One account as Bot HQ sees it: the summary plus where it stands and what it is training. */
    hqInfo() {
        const sum = this.summary();
        const { s } = this.snapshot();
        const snap = this.lastSnapshot();
        const p = s?.player;
        let xph: number | null = null, training: Array<[string, number, number]> = [];
        const levels: Record<string, number> = snap?.levels ?? {};
        if (snap?.xp) {
            const xp = snap.xp;
            const total = SKILLS.reduce((a, k) => a + (xp[k] ?? 0), 0);
            const r = this.rateOver(60, xp, total) ?? this.rateOver(30, xp, total);
            if (r) {
                xph = Math.round(r.total);
                training = Object.entries(r.perSkill).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => [k, Math.round(v), levels[k] ?? 0]);
            }
        }
        return {
            ...sum, levels: snap?.levels ?? null, xph, training,
            pos: snap?.pos ?? null, hp: snap?.hp ?? null, cb: p?.combatLevel ?? null,
            fight: !!p?.combat?.inCombat, dead: !!p?.isDead, invUsed: snap?.invUsed ?? null, inv: snap?.inv ?? [],
        };
    }
    summary() {
        if (this.summaryCache && Date.now() - this.summaryCache.at < 2500) return this.summaryCache.v;
        const { s, age, fresh } = this.snapshot();
        const snap = this.lastSnapshot();
        const xp = snap?.xp ?? (s ? skillXp(s) : null);
        const totalLevel = xp ? SKILLS.reduce((a, k) => a + levelForXp(xp[k] ?? 0), 0) : this.history.at(-1)?.totalLevel ?? null;
        const gw = this.gwStatus;
        const gwFresh = !!gw?.inGame && gw.stateAge != null && gw.stateAge < 15_000 && Date.now() - gw.at < 60_000;
        const act = this.activity();
        let lastSkill: { skill: string; level: number; xph: number | null; at: number; capped?: boolean } | null = null;
        const lt = this.lastTrained, curXp = xp ?? this.history.at(-1)?.xp;
        if (lt && curXp && Date.now() - lt.t < LAST_SKILL_MAX_AGE_MS) {
            const r = this.rateOver(60, curXp, 0);
            const rate = r && r.spanMinutes >= 10 ? Math.round(r.perSkill[lt.skill] ?? 0) : null;
            lastSkill = { skill: lt.skill, level: levelForXp(curXp[lt.skill] ?? 0), xph: rate || null, at: lt.t };
        } else if (curXp && act.current) { // no XP lately: a capped skill the activity line names (e.g. thieving at 200M)
            const k = SKILLS.find(k => (curXp[k] ?? 0) >= XP_CAP && SKILL_ACTIVITY[k]?.test(act.current));
            if (k) lastSkill = { skill: k, level: 99, xph: null, at: Date.now(), capped: true };
        }
        const v = {
            name: this.name, player: this.playerName, client: this.client, lite: this.lite,
            live: fresh || snapshotFresh(snap) || gwFresh, stateAgeMs: Number.isFinite(age) ? age : snap ? Date.now() - snap.at : null, gatewayInGame: !!this.gwStatus?.inGame,
            observer: this.observerStatus(), source: fresh ? 'observer' : snap?.source ?? (gwFresh ? 'gateway' : null),
            totalLevel, questPoints: this.questPoints(), lastSkill, bank: this.bank, wealthGph: this.wealthGph(),
            activity: act.current.slice(0, 140),
            paused: this.pauseInfo().paused,
            streamLive: !!this.frameAt && Date.now() - this.frameAt < 4000,
            managed: this.managed ? { state: this.managed.state } : null,
            gold: this.goldSummary(),
        };
        this.summaryCache = { at: Date.now(), v };
        return v;
    }
    buildState(why = '/api/state') {
        this.ensureObserver(why); // the skill panel / state view is open: bring the observer up (kept for OBSERVER_IDLE_MS)
        const { s, age, fresh } = this.snapshot();
        const snap = this.lastSnapshot();
        const xp = s ? skillXp(s) : snap?.xp ?? null;
        const curTotal = xp ? SKILLS.reduce((a, k) => a + (xp[k] ?? 0), 0) : 0;
        const r30 = xp ? this.rateOver(30, xp, curTotal) : null;
        const r60 = xp ? this.rateOver(60, xp, curTotal) : null;
        const skills = xp ? SKILLS.map(name => {
            const st = s?.skills.find(k => k.name === name);
            const x = xp[name] ?? 0;
            const level = st?.baseLevel ?? snap?.levels?.[name] ?? levelForXp(x);
            const rate = r60?.perSkill[name] ?? r30?.perSkill[name] ?? 0;
            const remaining = Math.max(0, MAX_XP - x);
            const cur = XP_FOR_LEVEL[Math.min(99, level)] ?? 0, next = level >= 99 ? cur : XP_FOR_LEVEL[level + 1]!;
            return {
                name, level, boosted: st?.level ?? level, xp: x, pct: Math.min(1, x / MAX_XP), remaining,
                levelPct: level >= 99 ? 1 : (x - cur) / Math.max(1, next - cur), xpToNext: level >= 99 ? 0 : next - x,
                rate30: r30?.perSkill[name] ?? null, rate60: r60?.perSkill[name] ?? null,
                etaHours: remaining === 0 ? 0 : rate > 0 ? remaining / rate : null,
            };
        }) : [];
        const totalLevel = skills.reduce((a, k) => a + k.level, 0);
        const cappedXp = skills.reduce((a, k) => a + Math.min(MAX_XP, k.xp), 0);
        const remainingXp = MAX_TOTAL_XP - cappedXp;

        const pt = this.playtime;
        const tr = pt?.tracked;
        const estHours = (pt?.baselineHours ?? 0) + (tr?.loggedInHours ?? 0) + (tr?.assumedHours ?? 0);
        const off = this.official && this.official.hours != null ? this.official : null;
        // Hiscores time only advances on save: never let a stale saved value move the telemetry lower bound backwards.
        const officialUsable = !!off && off.hours! + 2 / 60 >= estHours;
        const current = officialUsable ? { hours: off!.hours!, source: 'official' as const } : { hours: estHours, source: 'estimated' as const };
        const record = pt?.recordHours ? { hours: pt.recordHours, holder: pt.recordHolder ?? '?', source: 'playtime.json' }
            : liveRecord && liveRecord.level === '1,881' && liveRecord.holder.toLowerCase() !== this.playerName.toLowerCase() ? { hours: liveRecord.hours, holder: liveRecord.holder, source: 'hiscores #1' }
            : { ...RECORD_DEFAULT, source: 'default' };
        const plan = this.planRemaining(xp);
        const overallRate = r60?.total ?? r30?.total ?? 0;
        const remaining = plan.hours != null ? { hours: plan.hours, source: 'plan' }
            : overallRate > 0 && xp ? { hours: remainingXp / overallRate, source: 'xp-rate' } : { hours: null as number | null, source: 'unknown' };
        const projected = remaining.hours != null ? current.hours + remaining.hours : null;

        const inv = new Map<string, number>();
        for (const it of s?.inventory ?? []) inv.set(it.name, (inv.get(it.name) ?? 0) + it.count);

        return {
            now: Date.now(), bot: this.name, player: this.playerName,
            account: { name: this.name, client: this.client, lite: this.lite, botDir: this.botDir },
            accounts: [...accounts.values()].map(a => a.summary()),
            conn: {
                observer: this.sdk?.getConnectionState() ?? this.observerStatus(), observerStatus: this.observerStatus(), authenticated: this.sdk?.isAuthenticated() ?? false, error: this.observerError,
                stateAgeMs: Number.isFinite(age) ? age : snap ? Date.now() - snap.at : null, fresh: fresh || snapshotFresh(snap), inGame: !!s?.inGame || !!snap?.inGame, tick: s?.tick ?? null, gateway: this.gwStatus,
                source: fresh ? 'observer' : snap?.source ?? null,
            },
            character: s?.player ? {
                name: s.player.name, combatLevel: s.player.combatLevel, hp: s.player.hp, maxHp: s.player.maxHp,
                prayer: s.prayers?.prayerPoints ?? null, prayerMax: s.prayers?.prayerLevel ?? null,
                x: s.player.worldX, z: s.player.worldZ, plane: s.player.level, runEnergy: s.player.runEnergy,
                animId: s.player.animId, inCombat: !!s.player.combat?.inCombat, isDead: !!s.player.isDead,
            } : snap?.hp || snap?.pos ? { // observer still connecting: coarse values from the snapshot source
                name: this.playerName, combatLevel: null, hp: snap.hp?.[0] ?? null, maxHp: snap.hp?.[1] ?? null, prayer: null, prayerMax: null,
                x: snap.pos?.[0] ?? null, z: snap.pos?.[1] ?? null, plane: snap.pos?.[2] ?? null, runEnergy: null, animId: -1, inCombat: false, isDead: false,
            } : null,
            skills,
            totals: {
                level: totalLevel, maxLevel: MAX_TOTAL_LEVEL, xp: curTotal, cappedXp, maxXp: MAX_TOTAL_XP, pct: cappedXp / MAX_TOTAL_XP, remainingXp,
                rate30: r30?.total ?? null, rate60: r60?.total ?? null, span30: r30?.spanMinutes ?? null, span60: r60?.spanMinutes ?? null,
                maxed: skills.filter(k => k.level >= 99).length,
            },
            inventory: { used: s?.inventory?.length ?? snap?.invUsed ?? 0, slots: 28, items: s ? [...inv].map(([name, count]) => ({ name, count })) : (snap?.inv ?? []).map(([name, count]) => ({ name, count })) },
            equipment: (s?.equipment ?? []).map(e => e.name),
            playtime: {
                official: this.official ? { ...this.official } : null,
                officialUsable,
                estimated: { hours: estHours, baselineHours: pt?.baselineHours ?? null, baselineAt: pt?.baselineAt ?? null, trackedHours: tr?.loggedInHours ?? 0, assumedHours: tr?.assumedHours ?? 0, note: pt?.note ?? '' },
                current, record, remaining, projected, margin: projected != null ? record.hours - projected : null,
                wallEta: remaining.hours != null ? new Date(Date.now() + remaining.hours * 3.6e6).toISOString() : null,
                liveTop: liveRecord,
            },
            plan: plan.plan ? { ...plan.plan, remainingHours: plan.hours, phases: plan.phases } : null,
            activity: this.activity(),
            supervisor: this.supervisorStatus(),
            automation: this.automationStatus(),
            stream: this.streamStatus(),
            telemetryPort,
            history: { samples: this.history.length, first: this.history[0]?.ts ?? null, file: this.historyFile },
            gold: this.goldSummary(),
            clues: this.clueSummary(),
        };
    }
}

// ------------------------------------------------------------------ managed (headless puppeteer) client
class ManagedClient {
    state: 'stopped' | 'starting' | 'running' | 'error' = 'stopped';
    error = '';
    wanted = false;
    startedAt = 0;
    loadedAt = 0;
    restarts = 0;
    reloadTimes: number[] = [];
    staleSince = 0;
    browser: any = null;
    page: any = null;
    private capturing = false;
    private lastCaptureAt = 0;
    /** Render rate last applied to the page's gameClient (null = re-apply, e.g. after a reload). */
    gameFps: number | null = null;
    private applyingFps = false;
    /** Input keeps the client at the watch rate for a while even if no viewer is counted (e.g. right after a restart). */
    private boostUntil = 0;
    private captureTimer: ReturnType<typeof setInterval> | null = null;
    private healthTimer: ReturnType<typeof setInterval> | null = null;
    private relaunchTimer: ReturnType<typeof setTimeout> | null = null;
    private canvasInfo: { box: { x: number; y: number; width: number; height: number }; w: number; h: number; at: number } | null = null;
    private held = new Map<string, ReturnType<typeof setTimeout>>();
    private mouseAt: { x: number; y: number } | null = null;
    private mouseHeld: 'left' | 'right' | null = null;
    private inputChain: Promise<any> = Promise.resolve();
    private loggedReloadSuppression = '';
    private chromePid: number | null = null;
    private detaching = false;
    /** CDP session that serves the local bot bundle to every load of the driven page (local-bundle.ts). */
    private bundleSession: any = null;
    /** Last load of the driven page: local bundle served or not (null = loaded before this dashboard attached). */
    bundleServed: boolean | null = null;
    bundleWhy = '';
    /** Page runs this fork's bundle (fork-only client method present); checked every health tick. */
    forkBundle: boolean | null = null;
    /** The page reached the game since its last load (a local bundle that cannot log in is disabled for an hour). */
    private inGameSinceLoad = false;
    private localBundleOffUntil = 0;

    constructor(readonly acct: Account) {}

    info() {
        return { state: this.state, error: redact(this.error), wanted: this.wanted, startedAt: this.startedAt, loadedAt: this.loadedAt, restarts: this.restarts, pid: this.chromePid, staleForMs: this.staleSince ? Date.now() - this.staleSince : 0,
            bundle: { fork: this.forkBundle, servedLocal: this.bundleServed, why: this.bundleWhy } };
    }
    async start() {
        this.wanted = true;
        if (this.state === 'starting' || this.state === 'running') return;
        if (!this.acct.env) { this.state = 'error'; this.error = 'no credentials in bot.env'; return; }
        this.state = 'starting';
        this.error = '';
        try {
            const puppeteer = (await import('puppeteer')).default;
            const name = this.acct.name, clientPrefix = new URL(this.acct.clientUrl()).origin + '/bot';
            let browser: any = null, page: any = null, reattached = false;
            // A dashboard restart leaves the detached Chrome running: reattach to it and its logged-in page.
            const saved = readSaved(DATA_DIR, name);
            if (saved && isAlive(saved.pid)) {
                try {
                    browser = await puppeteer.connect({ browserWSEndpoint: saved.wsEndpoint, defaultViewport: null });
                    page = (await this.pickGamePage(browser, clientPrefix)).best;
                    if (page) { await Promise.race([page.evaluate(() => 1), sleep(5000).then(() => { throw new Error('page unresponsive'); })]); reattached = true; this.chromePid = saved.pid; }
                } catch (e) { log(`[${name}] reattach to chrome ${saved.pid} failed: ${errMsg(e)}`); }
                if (!reattached) { try { browser?.disconnect(); } catch { /* gone */ } browser = null; page = null; }
            }
            if (!reattached) {
                killSaved(DATA_DIR, name);
                const fresh = await launchDetached({
                    dataDir: DATA_DIR, name, executablePath: puppeteer.executablePath(),
                    // Trim (2026-10-07): the game draws into a 2D canvas, so Chrome's GPU process (~270 MB/client), extensions,
                    // component updates, background networking and disk caches (1.3 GB of profiles) are pure overhead.
                    args: ['--no-sandbox', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
                        '--disable-gpu', '--disable-extensions', '--disable-component-update', '--disable-background-networking', '--disk-cache-size=1', '--media-cache-size=1',
                        '--disable-features=AudioServiceOutOfProcess,MediaRouter', '--window-size=1100,800'],
                });
                this.chromePid = fresh.pid;
                browser = await puppeteer.connect({ browserWSEndpoint: fresh.wsEndpoint, defaultViewport: null });
                page = (await browser.pages())[0] ?? await browser.newPage();
                await page.setViewport({ width: 1000, height: 700 });
            }
            this.browser = browser;
            browser.on('disconnected', () => {
                if (this.browser !== browser || this.detaching) return;
                this.browser = null; this.page = null; this.canvasInfo = null; this.mouseAt = null; this.mouseHeld = null;
                if (this.wanted) { this.state = 'error'; this.error = 'browser exited'; log(`[${this.acct.name}] managed client browser exited - relaunching`); this.scheduleRelaunch(5000); }
                else this.state = 'stopped';
            });
            this.page = page;
            await this.hookBundle(page);
            await page.bringToFront().catch(() => {});
            page.on('error', () => { if (this.page === page) { this.error = 'page crashed'; log(`[${this.acct.name}] managed page crashed - relaunching`); void this.relaunch(); } });
            if (reattached) {
                this.startedAt = Date.now(); this.loadedAt = await this.pageLoadedAt(page); this.staleSince = 0; this.state = 'running';
                log(`[${name}] managed client reattached (chrome pid ${this.chromePid}; page kept, no reload)`);
                this.syncCapture();
                if (!this.healthTimer) this.healthTimer = setInterval(() => void this.health(), 15_000);
                void this.pollSnapshot();
                this.acct.broadcastStatus();
                return;
            }
            await page.goto(this.acct.clientUrl(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
            this.startedAt = Date.now(); this.loadedAt = await this.pageLoadedAt(page);
            this.staleSince = 0;
            this.state = 'running';
            log(`[${this.acct.name}] managed client started (detached chrome pid ${this.chromePid})`);
            this.syncCapture();
            if (!this.healthTimer) this.healthTimer = setInterval(() => void this.health(), 15_000);
        } catch (e) {
            this.error = errMsg(e);
            this.state = 'error';
            log(`[${this.acct.name}] managed client start failed: ${this.error}`);
            await this.closeBrowser();
            if (this.wanted) this.scheduleRelaunch(15_000);
        }
        this.acct.broadcastStatus();
    }
    scheduleRelaunch(delay: number) {
        if (this.relaunchTimer) clearTimeout(this.relaunchTimer);
        this.relaunchTimer = setTimeout(() => {
            this.relaunchTimer = null;
            if (this.wanted && this.state !== 'running' && this.state !== 'starting') { this.restarts++; void this.start(); }
        }, delay);
    }
    async relaunch() {
        this.restarts++;
        await this.closeBrowser();
        this.state = 'stopped';
        if (this.wanted) await this.start();
    }
    async stop() {
        this.wanted = false;
        if (this.relaunchTimer) { clearTimeout(this.relaunchTimer); this.relaunchTimer = null; }
        if (this.captureTimer) { clearInterval(this.captureTimer); this.captureTimer = null; }
        if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
        await this.closeBrowser();
        this.state = 'stopped';
        log(`[${this.acct.name}] managed client stopped`);
        this.acct.broadcastStatus();
    }
    async closeBrowser() {
        const b = this.browser;
        this.browser = null; this.page = null; this.canvasInfo = null; this.mouseAt = null; this.mouseHeld = null;
        this.bundleSession = null; this.forkBundle = null;
        for (const t of this.held.values()) clearTimeout(t);
        this.held.clear();
        if (b) await Promise.race([b.close().catch(() => {}), sleep(5000)]);
        killSaved(DATA_DIR, this.acct.name); // the browser is detached: make sure the process is gone
        this.chromePid = null;
    }
    /** Dashboard shutdown: leave Chrome and the logged-in page running for the next dashboard to reattach. */
    async detach() {
        this.detaching = true;
        if (this.relaunchTimer) { clearTimeout(this.relaunchTimer); this.relaunchTimer = null; }
        if (this.captureTimer) { clearInterval(this.captureTimer); this.captureTimer = null; }
        if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
        for (const [k, t] of this.held) { clearTimeout(t); await this.page?.keyboard.up(k).catch(() => {}); }
        this.held.clear();
        if (this.mouseHeld) await this.page?.mouse.up({ button: this.mouseHeld }).catch(() => {});
        try { this.browser?.disconnect(); } catch { /* already gone */ }
    }
    async reload() {
        if (!this.page) { if (this.wanted || this.state === 'stopped') await this.start(); return; }
        this.reloadTimes.push(Date.now());
        this.canvasInfo = null; this.mouseAt = null; this.mouseHeld = null;
        log(`[${this.acct.name}] managed client: reloading page`);
        try { await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); this.loadedAt = await this.pageLoadedAt(this.page); this.gameFps = null; }
        catch (e) { this.error = errMsg(e); }
    }
    // Keep the client healthy: relaunch a dead browser/page; reload when the account's state has
    // been stale for >60 s (and the gateway agrees no other client is logged in for it).
    async health() {
        if (!this.wanted || this.state === 'starting') return;
        this.gameFps = null; // re-apply the render rate (the page may have reloaded itself or reset it)
        try { await this.dedupePages(); } catch (e) { log(`[${this.acct.name}] dedupe pages failed: ${errMsg(e)}`); }
        if (!this.browser?.connected || !this.page) { log(`[${this.acct.name}] managed client not connected - relaunching`); await this.relaunch(); return; }
        try {
            await Promise.race([this.page.evaluate(() => 1), sleep(8000).then(() => { throw new Error('page unresponsive'); })]);
        } catch (e) { this.error = errMsg(e); log(`[${this.acct.name}] managed page unresponsive - relaunching`); await this.relaunch(); return; }
        void this.applyGameFps();
        void this.pollSnapshot();
        void this.checkForkBundle();
        const now = Date.now();
        const fleetDecision = managedReloadDecision(this.acct.name, now);
        const { fresh } = this.acct.snapshot();
        const gw = this.acct.gwStatus;
        const gwFresh = !!gw?.inGame && gw.stateAge != null && gw.stateAge < 15_000 && now - gw.at < 60_000;
        if (fresh || gwFresh) { this.staleSince = 0; this.loggedReloadSuppression = ''; this.inGameSinceLoad = true; return; }
        if (!this.staleSince) this.staleSince = now;
        if (fleetDecision?.suppressReload) {
            if (this.loggedReloadSuppression !== fleetDecision.phase) {
                const detail = fleetDecision.phase === 'shared-outage'
                    ? `${fleetDecision.affected}/${fleetDecision.eligible} managed clients report recent transport failure`
                    : `gateway recovered; grace until ${new Date(fleetDecision.recoveryGraceUntil!).toISOString()}`;
                log(`[${this.acct.name}] stale page reload suppressed (${fleetDecision.phase}: ${detail})`);
                this.loggedReloadSuppression = fleetDecision.phase;
            }
            return;
        }
        this.loggedReloadSuppression = '';
        if (now - this.staleSince < 60_000 || now - this.loadedAt < 90_000) return;
        this.reloadTimes = this.reloadTimes.filter(t => now - t < 15 * 60_000);
        this.staleSince = 0;
        if (this.bundleServed && !this.inGameSinceLoad) {
            this.localBundleOffUntil = now + 60 * 60_000;
            log(`[${this.acct.name}] WARNING local bot bundle: page never reached the game since it was served - using the host bundle for 1 h`);
        }
        if (this.reloadTimes.length >= 3) { log(`[${this.acct.name}] state stale after 3 reloads - relaunching browser`); this.reloadTimes = []; await this.relaunch(); }
        else { log(`[${this.acct.name}] state stale >60s - reloading client page`); await this.reload(); }
    }
    /** Serve this fork's bot bundle (revision-guarded) to every future load of `page`: start/relaunch goto, stale
     *  reloads, /api/reload, the page reloading itself. A reattached page keeps the bundle it loaded until it reloads. */
    private async hookBundle(page: any) {
        const old = this.bundleSession;
        this.bundleSession = null;
        if (old) await old.detach().catch(() => {});
        const decide = async (): Promise<BundleDecision> => Date.now() < this.localBundleOffUntil
            ? { serve: false, reason: 'disabled for this account after a failed login on it' } : localBundle.decide(this.acct.webOrigin);
        try {
            this.bundleSession = await interceptBundle(page, decide, (served, why) => {
                if (this.page !== page) return;
                this.bundleServed = served; this.bundleWhy = why; this.inGameSinceLoad = false; this.forkBundle = null;
                log(`[${this.acct.name}] page load: ${served ? 'local' : 'HOST'} bot bundle (${why})`);
            });
        } catch (e) { log(`[${this.acct.name}] WARNING local bot bundle interception failed: ${errMsg(e)}`); }
    }
    private async checkForkBundle() {
        const v = await Promise.race([this.page?.evaluate(FORK_MARKER_JS).catch(() => null), sleep(3000).then(() => null)]);
        if (typeof v === 'boolean') this.forkBundle = v;
    }
    /** Pages loading this account's client (a browser can end up with duplicates), and the one to drive: the in-game
     *  page, preferring `current`. Duplicates double the CPU and stream/input went to whichever came first. */
    private async pickGamePage(browser: any, clientPrefix: string, current: any = null) {
        const pages = (await browser.pages()).filter((p: any) => p.url().startsWith(clientPrefix));
        const inGame = async (p: any) => await Promise.race([
            p.evaluate(() => !!(window as any).gameClient?.ingame).catch(() => false), sleep(3000).then(() => false)]);
        let best = null;
        if (current && pages.includes(current) && await inGame(current)) best = current;
        else for (const p of pages) if (await inGame(p)) { best = p; break; }
        best ??= current && pages.includes(current) ? current : pages[0] ?? null;
        return { best, others: pages.filter((p: any) => p !== best) };
    }
    /** loadedAt = the page's own navigation time, so a dashboard restart that reattaches reports the same value
     *  (tools/quests/client-epoch.ts treats a loadedAt change as a client reload). */
    private async pageLoadedAt(page: any): Promise<number> {
        const t = await Promise.race([page?.evaluate(() => performance.timeOrigin).catch(() => 0), sleep(3000).then(() => 0)]);
        return Number(t) > 0 ? Math.round(Number(t)) : Date.now();
    }
    /** Adopt the in-game page if the driven one isn't, and close duplicate client pages. */
    private async dedupePages() {
        if (!this.browser || !this.page) return;
        const prefix = new URL(this.acct.clientUrl()).origin + '/bot';
        const { best, others } = await this.pickGamePage(this.browser, prefix, this.page);
        if (best && best !== this.page) {
            log(`[${this.acct.name}] managed client: switching to the in-game page (driven page was not in game)`);
            const page = best;
            this.page = page; this.canvasInfo = null; this.mouseAt = null; this.mouseHeld = null; this.gameFps = null;
            this.loadedAt = await this.pageLoadedAt(page);
            await this.hookBundle(page);
            page.on('error', () => { if (this.page === page) { this.error = 'page crashed'; log(`[${this.acct.name}] managed page crashed - relaunching`); void this.relaunch(); } });
        }
        for (const p of others) { log(`[${this.acct.name}] managed client: closing duplicate client page`); await p.close().catch(() => {}); }
        for (const p of await this.browser.pages()) if (p !== this.page && p.url() === 'about:blank') await p.close().catch(() => {});
        await this.ensureFront();
    }
    /** The game page must be the visible tab: Chrome acks input to a hidden tab only after a 5 s timeout (clicks were
     *  lost or landed seconds late) and throttles its rendering. */
    async ensureFront() {
        const page = this.page;
        if (!page) return;
        const vis = await Promise.race([page.evaluate(() => document.visibilityState).catch(() => 'unknown'), sleep(3000).then(() => 'unknown')]);
        if (vis === 'visible') return;
        log(`[${this.acct.name}] managed client: game page was ${vis} - bringing it to the front`);
        await page.bringToFront().catch(() => {});
    }
    /** Capture runs only while someone watches: start the 60 Hz tick on the first viewer, stop it on the last. */
    syncCapture() {
        const want = !!this.page && this.acct.viewerCount() > 0;
        if (want && !this.captureTimer) this.captureTimer = setInterval(() => void this.captureTick(), 1000 / 60);
        else if (!want && this.captureTimer) { clearInterval(this.captureTimer); this.captureTimer = null; }
        void this.applyGameFps();
    }
    // The page's camera + minimap transform (the 2004 client wobbles the minimap angle/zoom on purpose), so the dashboard
    // can place fleet icons on the streamed minimap exactly where the game draws its dots. Polled ~5 Hz while watched.
    private cameraCache: { at: number; v: any; busy?: Promise<any> } = { at: 0, v: null };
    async camera() {
        const page = this.page;
        if (!page) return null;
        const c = this.cameraCache;
        if (Date.now() - c.at < 120) return c.v;
        if (!c.busy) c.busy = Promise.race([page.evaluate(MANAGED_CAMERA_JS), sleep(1000).then(() => null)]).catch(() => null)
            .then((v) => { c.v = v; c.at = Date.now(); c.busy = undefined; return v; });
        return c.busy;
    }
    /** The compass click the 2004 client lacks: face the camera north (view only - nothing is sent to the game). */
    async faceNorth() {
        const page = this.page;
        if (!page) return false;
        try { await page.evaluate('(() => { const g = window.gameClient; if (g) { g.orbitCameraYaw = 0; g.orbitCameraYawVelocity = 0; } })()'); this.cameraCache.at = 0; return true; } catch { return false; }
    }
    private pollingSnapshot = false;
    /** Observer-less XP/level/position source for managed accounts: the page's own client tables, every health tick. */
    async pollSnapshot() {
        const page = this.page;
        if (!page || this.pollingSnapshot) return;
        this.pollingSnapshot = true;
        try {
            const raw = await Promise.race([page.evaluate(MANAGED_SNAPSHOT_JS), sleep(3000).then(() => null)]);
            const snap = managedSnapshot(raw);
            if (snap && this.page === page) this.acct.managedSnap = snap;
        } catch { /* page busy / navigating */ }
        finally { this.pollingSnapshot = false; }
    }
    /** Watched → the chosen stream rate (60 = the client's uncapped ~70 fps); unwatched → IDLE_FPS. */
    async applyGameFps() {
        const page = this.page;
        const want = this.acct.viewerCount() > 0 || Date.now() < this.boostUntil ? Math.min(50, Math.max(IDLE_FPS, this.acct.maxViewerFps() || streamFps)) : IDLE_FPS;
        if (!page || this.applyingFps || this.gameFps === want) return;
        this.applyingFps = true;
        try {
            const ok = await Promise.race([
                page.evaluate((f: number) => { const g = (window as any).gameClient; if (!g || typeof g.tfps !== 'number') return false; g.tfps = f; return true; }, want),
                sleep(3000).then(() => false),
            ]);
            if (ok && this.page === page) this.gameFps = want;
        } catch { /* page busy / navigating */ }
        finally { this.applyingFps = false; }
    }
    async captureTick() {
        const page = this.page;
        if (!page || this.capturing || this.acct.viewerCount() === 0) return;
        const now = Date.now();
        if (now - this.lastCaptureAt < 1000 / Math.max(1, this.acct.maxViewerFps()) - 4) return;
        this.lastCaptureAt = now;
        this.capturing = true; // no-overlap guard
        try {
            // one encode per quality some viewer wants (viewers on Auto pick their own); /stream and /frame.jpg use the global one
            const qs = [...new Set([...this.acct.viewersOf().map(viewerQuality), ...(this.acct.mjpegClients ? [streamQuality] : [])])];
            const r = await Promise.race([
                page.evaluate((qs: number[]) => {
                    const c = (document.getElementById('canvas') || document.querySelector('canvas')) as HTMLCanvasElement | null;
                    return c && c.width ? { d: qs.map(q => q >= 100 ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', q / 100)), w: c.width, h: c.height } : null;
                }, qs.length ? qs : [streamQuality]),
                sleep(3000).then(() => null),
            ]);
            if (r) {
                const byQ = new Map<number, Uint8Array>();
                (qs.length ? qs : [streamQuality]).forEach((q, i) => byQ.set(q, Buffer.from(r.d[i]!.slice(r.d[i]!.indexOf(',') + 1), 'base64')));
                const acct = this.acct;
                acct.frame = byQ.get(streamQuality) ?? byQ.values().next().value!;
                acct.frameSeq++; acct.frameAt = Date.now(); acct.frameTimes.push(acct.frameAt);
                acct.frameMeta = { ...acct.frameMeta, w: r.w, h: r.h, page: 'managed headless client', visible: true };
                acct.sendFrames(byQ);
            }
        } catch { /* page busy / navigating */ }
        finally { this.capturing = false; }
    }
    private async canvas() {
        if (this.canvasInfo && Date.now() - this.canvasInfo.at < 3000) return this.canvasInfo;
        const h = (await this.page.$('#canvas')) ?? (await this.page.$('canvas'));
        if (!h) throw new Error('no game canvas');
        const box = await h.boundingBox();
        const dims = await this.page.evaluate((el: HTMLCanvasElement) => ({ w: el.width, h: el.height }), h);
        if (!box) throw new Error('canvas not visible');
        this.canvasInfo = { box, w: dims.w, h: dims.h, at: Date.now() };
        return this.canvasInfo;
    }
    private keyName(k: string) {
        const map: Record<string, string> = { left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', esc: 'Escape', escape: 'Escape', enter: 'Enter', space: 'Space', ' ': 'Space', backspace: 'Backspace', tab: 'Tab', delete: 'Delete', ctrl: 'Control', control: 'Control', shift: 'Shift', alt: 'Alt' };
        return map[k.toLowerCase()] ?? map[k] ?? k;
    }
    // Puppeteer tracks pressed buttons itself and rolls a failed/timed-out mouse.up back to "pressed", after which
    // every mouse.down throws "'left' is already pressed." and the client ignores all clicks. Self-heal instead.
    private async pressButton(page: NonNullable<typeof this.page>, button: 'left' | 'right') {
        try { await page.mouse.down({ button }); }
        catch (e) {
            if (!/already pressed/.test(errMsg(e))) throw e;
            await this.releaseButton(page, button);
            await page.mouse.down({ button });
        }
    }
    private async releaseButton(page: NonNullable<typeof this.page>, button: 'left' | 'right') {
        for (let i = 0; i < 2; i++) {
            try { await page.mouse.up({ button }); return; }
            catch (e) { if (/not pressed/.test(errMsg(e))) return; }
        }
        await page.mouse.reset().catch(() => {}); this.mouseAt = null;
    }
    input(ev: any): Promise<any> {
        // Serialise input so a quick double tap can't interleave mouse down/up pairs.
        const run = async () => {
            const page = this.page;
            if (!page) return { ok: false, error: 'managed client not running (press Start client)' };
            // Idle clients render at IDLE_FPS: bring this one up to the watch rate before acting, or a click lands
            // before the game has redrawn the hover menu under the new cursor position.
            this.boostUntil = Date.now() + 120_000;
            const prevFps = this.gameFps ?? IDLE_FPS;
            await this.applyGameFps();
            const frameMs = 1000 / Math.max(1, Math.min(prevFps, this.gameFps ?? prevFps));
            switch (ev.kind) {
                case 'click': case 'move': case 'down': case 'up': {
                    const c = await this.canvas();
                    const px = Math.min(c.w - 1, Math.floor(ev.x * c.w)), py = Math.min(c.h - 1, Math.floor(ev.y * c.h));
                    const x = c.box.x + (px + 0.5) * c.box.width / c.w, y = c.box.y + (py + 0.5) * c.box.height / c.h;
                    const moved = !this.mouseAt || Math.abs(this.mouseAt.x - x) > 0.5 || Math.abs(this.mouseAt.y - y) > 0.5;
                    if (moved) { await page.mouse.move(x, y); this.mouseAt = { x, y }; }
                    if (ev.kind === 'move') return { ok: true, gx: px, gy: py };
                    // The game picks a left-click's action from the hover menu built on the last drawn frame, so a
                    // press straight after a jump hits whatever was under the OLD cursor. Let it redraw first.
                    if (moved && ev.kind !== 'up') await sleep(Math.max(90, Math.ceil(2 * frameMs) + 10));
                    const button = ev.button === 'right' ? 'right' : 'left';
                    if (ev.kind === 'down') {
                        if (this.mouseHeld) await this.releaseButton(page, this.mouseHeld);
                        await this.pressButton(page, button); this.mouseHeld = button;
                        return { ok: true, gx: px, gy: py, button };
                    }
                    if (ev.kind === 'up') {
                        await this.releaseButton(page, this.mouseHeld ?? button); this.mouseHeld = null;
                        return { ok: true, gx: px, gy: py, button };
                    }
                    if (this.mouseHeld) { await this.releaseButton(page, this.mouseHeld); this.mouseHeld = null; }
                    await this.pressButton(page, button);
                    await sleep(60);
                    await this.releaseButton(page, button);
                    return { ok: true, gx: px, gy: py, button };
                }
                case 'key': {
                    const key = this.keyName(ev.key);
                    await page.evaluate(() => (document.getElementById('canvas') as HTMLElement | null)?.focus());
                    if (ev.action === 'down') {
                        clearTimeout(this.held.get(key));
                        if (!this.held.has(key)) await page.keyboard.down(key);
                        // auto-release unless the dashboard keeps refreshing the hold
                        this.held.set(key, setTimeout(() => { this.held.delete(key); void page.keyboard.up(key).catch(() => {}); }, Math.min(10_000, Math.max(300, ev.holdMs || 1500))));
                    } else if (ev.action === 'up') {
                        clearTimeout(this.held.get(key)); this.held.delete(key);
                        await page.keyboard.up(key);
                    } else await page.keyboard.press(key);
                    return { ok: true, key };
                }
                case 'text': {
                    await page.evaluate(() => (document.getElementById('canvas') as HTMLElement | null)?.focus());
                    await page.keyboard.type(String(ev.text ?? '').slice(0, 120), { delay: 10 });
                    if (ev.enter) await page.keyboard.press('Enter');
                    return { ok: true, chars: String(ev.text ?? '').length };
                }
                case 'releaseAll':
                    for (const [k, t] of this.held) { clearTimeout(t); await page.keyboard.up(k).catch(() => {}); }
                    this.held.clear();
                    await page.mouse.reset().catch(() => {}); this.mouseHeld = null; this.mouseAt = null;
                    return { ok: true };
            }
            return { ok: false, error: 'unknown input kind' };
        };
        const p = this.inputChain.then(run, run).catch((e: unknown) => ({ ok: false, error: errMsg(e) }));
        this.inputChain = p;
        return p;
    }
}

let gatewayOutageState: GatewayOutageState = {};
function managedReloadDecision(account: string, now: number) {
    const evaluation = evaluateGatewayOutagePolicy(gatewayOutageState, [...accounts.values()].map(a => ({
        account: a.name,
        gatewayUrl: a.gatewayUrl,
        managed: a.client === 'managed',
        wanted: !!a.managed?.wanted,
        observerTransportFailing: a.observerTransportFailing,
        gatewayPollFailing: a.gatewayPollFailing,
        observerTransportFailureAt: a.observerTransportFailureAt,
        gatewayPollFailureAt: a.gatewayPollFailureAt,
    })), now);
    gatewayOutageState = evaluation.state;
    return evaluation.decisions[account];
}

// ------------------------------------------------------------------ accounts
const accounts = new Map<string, Account>();
// Bot HQ (/api/hq): every account at once - positions for the fleet map, rates, and an event feed. Cached briefly
// since every HQ viewer polls it.
const hqFeed = new HqFeed();
let hqCache: { at: number; v: unknown } | null = null;
function hqPayload() {
    if (hqCache && Date.now() - hqCache.at < 1500) return hqCache.v;
    const list = [...accounts.values()].map(a => a.hqInfo());
    for (const a of list) hqFeed.observe({ name: a.name, live: a.live, paused: a.paused, dead: a.dead, activity: a.activity, levels: a.levels });
    const v = { now: Date.now(), accounts: list.map(({ levels, ...rest }) => rest), events: hqFeed.events.slice(-80) };
    hqCache = { at: Date.now(), v };
    return v;
}
// Game art for the simulated lite-client view, rendered from the game server of the first lite account (or any account).
const liteAssets = new LiteAssets({
    root: ROOT, log,
    origin: () => { const a = [...accounts.values()].find(x => x.lite) ?? firstAccount(); return a?.webOrigin ?? null; },
});
for (const cfg of loadAccounts()) {
    if (accounts.has(cfg.name)) { log(`duplicate account ${cfg.name} ignored`); continue; }
    accounts.set(cfg.name, new Account(cfg));
}
const firstAccount = () => [...accounts.values()][0]!;
const accountOf = (name: string | null | undefined) => (name ? accounts.get(name) ?? [...accounts.values()].find(a => a.matchesBot(name)) ?? null : null);

// ------------------------------------------------------------------ input
const ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'left', 'right', 'up', 'down']);
function validateInput(ev: any): string | null {
    if (!ev || typeof ev !== 'object') return 'bad input';
    const num01 = (v: any) => typeof v === 'number' && v >= 0 && v <= 1;
    switch (ev.kind) {
        case 'click': return num01(ev.x) && num01(ev.y) && (ev.button === 'left' || ev.button === 'right') ? null : 'bad click';
        case 'move': return num01(ev.x) && num01(ev.y) ? null : 'bad move';
        case 'down': case 'up': return num01(ev.x) && num01(ev.y) && (ev.button === 'left' || ev.button === 'right') ? null : `bad ${ev.kind}`;
        case 'key': return typeof ev.key === 'string' && ev.key.length <= 16 && ['down', 'up', 'press'].includes(ev.action) ? null : 'bad key';
        case 'text': return typeof ev.text === 'string' && ev.text.length <= 120 ? null : 'bad text';
        case 'releaseAll': return null;
        default: return 'unknown input kind';
    }
}
// Camera arrows + key releases are always allowed; clicks/typing need input enabled (the 'takeover' flag).
const needsInput = (ev: any) => !((ev.kind === 'key' && ARROWS.has(ev.key)) || ev.kind === 'releaseAll');
function finishAck(acct: Account, ws: ServerWebSocket<WsData> | null, m: any) {
    acct.lastInputResult = { ok: !!m?.ok, error: m?.error ? redact(m.error) : null, gx: m?.gx, gy: m?.gy, key: m?.key, button: m?.button, at: Date.now() };
    if (ws && viewers.has(ws)) ws.send(JSON.stringify({ type: 'ack', ...acct.lastInputResult }));
}
function forwardInput(acct: Account, ev: any, from: ServerWebSocket<WsData> | null): { ok: boolean; error?: string; promise?: Promise<any> } {
    if (acct.client !== 'managed') return { ok: false, error: 'lite account: no game client' };
    const bad = validateInput(ev);
    if (bad) return { ok: false, error: bad };
    if (needsInput(ev) && !acct.takeover) return { ok: false, error: 'Enable input first' };
    acct.inputsSent++;
    acct.lastInputAt = Date.now();
    if (!acct.managed?.page) return { ok: false, error: 'Managed client not running - press Start client' };
    const promise = acct.managed.input(ev).then(m => { finishAck(acct, from, m); return m; });
    return { ok: true, promise };
}

// ------------------------------------------------------------------ telemetry cost dashboard detection + global record
let telemetryPort: number | null = null;
const telemetryPorts = new Map<number, number[]>(); // listening ports per telemetry server pid (lsof once per pid)
async function detectTelemetry() {
    const ports = new Set<number>();
    if (process.env.TELEMETRY_PORT) ports.add(Number(process.env.TELEMETRY_PORT));
    for (const r of psRows()) {
        if (!r.cmd.includes('telemetry/server.ts') || r.pid === process.pid) continue;
        let known = telemetryPorts.get(r.pid);
        if (!known) {
            const ls = Bun.spawnSync(['lsof', '-nP', '-a', '-p', String(r.pid), '-iTCP', '-sTCP:LISTEN', '-Fn']);
            known = [...ls.stdout.toString().matchAll(/^n.*:(\d+)$/gm)].map(m => Number(m[1]));
            telemetryPorts.set(r.pid, known);
        }
        for (const p of known) ports.add(p);
    }
    ports.add(4777);
    for (const p of ports) {
        if (!p || p === PORT) continue;
        try {
            const r = await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(1500) });
            if (r.ok && (await r.text()).includes('Agent cost telemetry')) { telemetryPort = p; return; }
        } catch { /* not here */ }
    }
    telemetryPort = null;
}
async function pollRecord() {
    if (NO_HISCORES) return;
    try {
        const html = await (await fetch(`${firstAccount().webOrigin}/hiscores?category=0`, { signal: AbortSignal.timeout(10_000) })).text();
        const name = html.match(/\/hiscores\/player\/[^"]+"\s+class="c">([^<]+)<\/a>/)?.[1];
        const level = html.slice(html.indexOf('<b>Level</b>')).match(/<br>\s*([\d,]+)<br>/)?.[1];
        const time = html.slice(html.indexOf('<b>Level</b>')).match(/<br>\s*((?:\d+h\s*)?\d+m)<br>/)?.[1];
        const hours = time ? parseHm(time) : null;
        if (name && level && hours != null) liveRecord = { holder: name, hours, level, fetchedAt: Date.now() };
    } catch { /* keep last */ }
}

// ------------------------------------------------------------------ HTTP
const questsCache = new Map<string, { at: number; v: unknown }>();
const file = (name: string, type: string) => new Response(Bun.file(join(PUBLIC_DIR, name)), { headers: { 'content-type': type, 'cache-control': 'no-store' } });
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
function authorized(req: Request, url: URL) {
    if (!TOKEN) return true;
    if (url.searchParams.get('token') === TOKEN) return true;
    return (req.headers.get('cookie') ?? '').split(/;\s*/).includes(`dash_token=${TOKEN}`);
}
const viewerAccount = (ws: ServerWebSocket<WsData>) => accounts.get(ws.data.account ?? '') ?? firstAccount();
/** Viewer count changed somewhere: managed clients start/stop capturing and re-apply their render rate. */
function onViewersChanged() { for (const a of accounts.values()) a.managed?.syncCapture(); }
function selectAccount(ws: ServerWebSocket<WsData>, name: string) {
    const next = accountOf(name) ?? firstAccount();
    ws.data.account = next.name;
    next.ensureObserver('viewer select');
    ws.send(next.statusMessage());
    if (next.frame) ws.send(next.frame);
    onViewersChanged();
}

let server: ReturnType<typeof Bun.serve<WsData, {}>>;
try {
    server = Bun.serve<WsData, {}>({
        port: PORT,
        hostname: HOST,
        idleTimeout: 60,
        async fetch(req, srv) {
            const url = new URL(req.url);
            const path = url.pathname;
            const ip = srv.requestIP(req)?.address;
            // Cloudflare tunnel (remote access): cloudflared connects from loopback, so tell it apart by its headers and
            // require a signed session on every path. Local/LAN is unchanged.
            const remote = isRemote(req);
            if (remote) {
                const gate = remoteGate(req, url, REMOTE_SECRET_FILE);
                if (gate) return gate;
            }

            // PWA shell (no account data): served before auth so the install prompt and home-screen icon work
            const sk = /^\/skill\/([a-z]+)\.png$/.exec(path); // 16px stat icons shipped with the engine's web pages
            if (sk && SKILLS.some(k => k.toLowerCase() === sk[1])) return new Response(Bun.file(join(ROOT, 'server', 'engine', 'public', 'img', 'skill', sk[1] + '.png')), { headers: { 'content-type': 'image/gif', 'cache-control': 'public, max-age=604800' } });
            if (path === '/manifest.webmanifest') return file('manifest.webmanifest', 'application/manifest+json');
            if (path === '/sw.js') return file('sw.js', 'text/javascript; charset=utf-8');
            if (/^\/icons\/icon(-\d+\.png|\.svg)$/.test(path)) return file(path.slice(1), path.endsWith('.svg') ? 'image/svg+xml' : 'image/png');
            if (!remote && !authorized(req, url)) return new Response('Unauthorized - open the dashboard with ?token=<DASH_TOKEN>', { status: 401 });

            const acct = accountOf(url.searchParams.get('account')) ?? firstAccount();
            if (path === '/ws') return srv.upgrade(req, { data: { role: 'viewer', id: ++wsSeq, since: Date.now(), account: acct.name } }) ? undefined : new Response('upgrade failed', { status: 400 });
            if (path === '/' || path === '/index.html') {
                const res = file('index.html', 'text/html; charset=utf-8');
                if (TOKEN && url.searchParams.get('token') === TOKEN) res.headers.append('set-cookie', `dash_token=${TOKEN}; Path=/; Max-Age=31536000; SameSite=Lax`);
                return res;
            }
            if (path === '/api/accounts') return json([...accounts.values()].map(a => a.summary()));
            if (path === '/api/hq') return json(hqPayload());
            if (path === '/highlights') return file('highlights.html', 'text/html; charset=utf-8');
            if (path === '/api/highlights') return json(highlightsPayload());
            if (path === '/api/events') { const q = url.searchParams.get('since'); return json(liveEvents.list(q == null ? undefined : Number(q))); }
            if (path === '/toasts.js') return file('toasts.js', 'text/javascript; charset=utf-8');
            if (path === '/api/state') return json(acct.buildState(`/api/state from ${ip ?? '?'}`));
            if (path === '/api/chat') return json(acct.chatFeed(Number(url.searchParams.get('since') ?? 0)));
            if (path === '/api/lite/scene') return json(acct.liteScene());
            if (path === '/api/camera/north' && req.method === 'POST') return json({ ok: !!(await acct.managed?.faceNorth()) });
            if (path === '/api/camera') { const cam = await acct.managed?.camera(); return json(cam ? { ok: true, ...cam } : { ok: false }); }
            if (path === '/lite.js') return file('lite.js', 'text/javascript; charset=utf-8');
            if (path.startsWith('/lite/')) { const r = await liteAssets.handle(path, url); if (r) return r; }
            if (path === '/api/history') return json(acct.historySeries(Number(url.searchParams.get('hours') ?? 6)));
            if (path === '/api/gold') return json(acct.goldSeries(Number(url.searchParams.get('hours') ?? 0)));
            if (path === '/api/clues') return json(acct.clueDetail());
            if (path === '/api/quests') {
                const hit = questsCache.get(acct.name);
                if (hit && Date.now() - hit.at < 10_000) return json(hit.v);
                const v = buildQuestsPayload({ account: acct.name, botDir: acct.botDir, sokoDir: join(ROOT, 'bots', 'SOKO') });
                questsCache.set(acct.name, { at: Date.now(), v });
                return json(v);
            }
            if (path === '/api/money') return json(moneyOverview(Number(url.searchParams.get('hours') ?? 0)));
            if (path === '/health') return json({ ok: true, accounts: [...accounts.values()].map(a => ({ name: a.name, frameAgeMs: a.frameAt ? Date.now() - a.frameAt : null, ...a.pauseInfo(), takeover: a.takeover, managed: a.managed?.info() ?? null })) });
            if (path === '/api/pause' && req.method === 'POST') { const pids = acct.pause('dashboard button'); acct.summaryCache = null; acct.broadcastStatus(); return json({ ok: true, stopped: pids, automation: acct.automationStatus() }); }
            if (path === '/api/resume' && req.method === 'POST') { const pids = acct.resume(); acct.summaryCache = null; acct.broadcastStatus(); return json({ ok: true, resumed: pids, automation: acct.automationStatus() }); }
            if (path === '/api/prefs' && req.method === 'POST') {
                const b: any = await req.json().catch(() => ({}));
                if (b.streamQuality !== undefined) {
                    const q = Number(b.streamQuality);
                    if (!STREAM_QUALITY_CHOICES.includes(q as any)) return json({ ok: false, error: `streamQuality must be one of ${STREAM_QUALITY_CHOICES.join(', ')}` }, 400);
                    streamQuality = q;
                    try { writeFileSync(PREFS_FILE, JSON.stringify({ ...readPrefs(), streamQuality: q }, null, 1) + '\n'); } catch (e) { log(`prefs write failed: ${errMsg(e)}`); }
                    for (const a of accounts.values()) a.broadcastStatus();
                    log(`stream quality set to ${q}`);
                    return json({ ok: true, streamQuality: q });
                }
                const f = Number(b.streamFps);
                if (!STREAM_FPS_CHOICES.includes(f as any)) return json({ ok: false, error: `streamFps must be one of ${STREAM_FPS_CHOICES.join(', ')}` }, 400);
                streamFps = f;
                try { writeFileSync(PREFS_FILE, JSON.stringify({ ...readPrefs(), streamFps: f }, null, 1) + '\n'); } catch (e) { log(`prefs write failed: ${errMsg(e)}`); }
                for (const a of accounts.values()) { if (a.managed) a.managed.gameFps = null; a.broadcastStatus(); }
                log(`stream fps set to ${f}`);
                return json({ ok: true, streamFps: f });
            }
            if (path === '/api/takeover' && req.method === 'POST') {
                const b: any = await req.json().catch(() => ({}));
                const on = !!b.on;
                // 'takeover' = input enabled. It only gates whether taps/keys reach the game; it never pauses anything.
                // all:true (the settings toggle) applies to every account and is remembered across restarts.
                const targets = b.all ? [...accounts.values()] : [acct];
                if (b.all) { try { writeFileSync(PREFS_FILE, JSON.stringify({ ...readPrefs(), inputDisabled: !on }, null, 1) + '\n'); } catch (e) { log(`prefs write failed: ${errMsg(e)}`); } }
                for (const a of targets) {
                    if (!on && a.takeover && a.client === 'managed') forwardInput(a, { kind: 'releaseAll' }, null);
                    a.takeover = on;
                    a.broadcastStatus();
                }
                log(`[${b.all ? 'all accounts' : acct.name}] input ${on ? 'enabled' : 'disabled'}`);
                return json({ ok: true, takeover: on, automation: acct.automationStatus() });
            }
            if (path === '/api/reload' && req.method === 'POST') {
                if (acct.client === 'managed') { void acct.managed!.reload(); log(`[${acct.name}] RELOAD managed client requested`); return json({ ok: true }); }
                return json({ ok: false, error: 'lite account: no game client' }, 409);
            }
            if (path === '/api/client/start' && req.method === 'POST') {
                if (!acct.managed) return json({ ok: false, error: `${acct.name} is a lite account (no game client), not a managed client` }, 409);
                void acct.managed.start();
                return json({ ok: true, managed: acct.managed.info() });
            }
            if (path === '/api/client/stop' && req.method === 'POST') {
                if (!acct.managed) return json({ ok: false, error: 'not a managed account' }, 409);
                await acct.managed.stop();
                return json({ ok: true, managed: acct.managed.info() });
            }
            if (path === '/api/input' && req.method === 'POST') {
                const b: any = await req.json().catch(() => null);
                const r = forwardInput(acct, b?.ev ?? b, null);
                if (!r.ok) return json(r, 409);
                const ack = await Promise.race([r.promise, Bun.sleep(4000).then(() => ({ ok: false, error: 'timeout' }))]);
                return json({ ok: !!ack?.ok, ack });
            }
            if (path === '/frame.jpg') return acct.frame ? new Response(acct.frame, { headers: { 'content-type': frameType(acct.frame), 'cache-control': 'no-store' } }) : new Response('no frame yet', { status: 503 });
            if (path === '/stream') {
                const boundary = 'frame';
                const enc = new TextEncoder();
                let open = true;
                acct.mjpegClients++;
                onViewersChanged();
                const done = () => { if (open) { open = false; acct.mjpegClients--; onViewersChanged(); } };
                req.signal.addEventListener('abort', done);
                const stream = new ReadableStream({
                    async start(controller) {
                        let sent = -1;
                        while (open) {
                            const f = acct.frame;
                            if (f && acct.frameSeq !== sent) {
                                sent = acct.frameSeq;
                                try {
                                    controller.enqueue(enc.encode(`--${boundary}\r\nContent-Type: ${frameType(f)}\r\nContent-Length: ${f.length}\r\n\r\n`));
                                    controller.enqueue(f);
                                    controller.enqueue(enc.encode('\r\n'));
                                } catch { break; }
                            }
                            await Bun.sleep(Math.round(500 / streamFps));
                        }
                        done();
                        try { controller.close(); } catch {}
                    },
                    cancel() { done(); },
                });
                return new Response(stream, { headers: { 'content-type': `multipart/x-mixed-replace; boundary=${boundary}`, 'cache-control': 'no-store' } });
            }
            return new Response('not found', { status: 404 });
        },
        websocket: {
            maxPayloadLength: 8 * 1024 * 1024,
            idleTimeout: 120,
            open(ws) {
                viewers.add(ws);
                const a = viewerAccount(ws);
                a.ensureObserver('viewer open');
                ws.send(a.statusMessage());
                if (a.frame) ws.send(a.frame);
                onViewersChanged();
            },
            message(ws, message) {
                if (typeof message !== 'string') return;
                let m: any;
                try { m = JSON.parse(message); } catch { return; }
                const a = viewerAccount(ws);
                if (m.type === 'select') selectAccount(ws, String(m.account ?? ''));
                else if (m.type === 'stream') {
                    // this viewer's own stream settings (Auto on its device); null = back to the global prefs
                    const f = Number(m.fps), q = Number(m.quality);
                    ws.data.fps = m.fps == null || !Number.isFinite(f) ? undefined : Math.min(60, Math.max(1, Math.round(f)));
                    ws.data.quality = m.quality == null || !Number.isFinite(q) ? undefined : Math.min(100, Math.max(20, Math.round(q)));
                    onViewersChanged();
                }
                else if (m.type === 'input') {
                    const r = forwardInput(a, m.ev, ws);
                    if (!r.ok) ws.send(JSON.stringify({ type: 'ack', ok: false, error: r.error }));
                }
            },
            close(ws) {
                viewers.delete(ws);
                onViewersChanged();
            },
        },
    });
} catch (e: any) {
    if (e?.code === 'EADDRINUSE' || /in use|EADDRINUSE/i.test(errMsg(e))) {
        console.error(`\n[dashboard] ERROR: port ${PORT} is already in use.`);
        console.error(`  Something else is listening (tools/stream.ts or another dashboard?). Check with:`);
        console.error(`    lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
        console.error(`  Stop it, or run on another port: PORT=8766 bun tools/dashboard/server.ts`);
        console.error('');
        process.exit(1);
    }
    throw e;
}

// ------------------------------------------------------------------ timers
function bootAccount(a: Account) {
    if (OBSERVERS_ALWAYS) void a.startObserver(); // otherwise on demand (Account.ensureObserver / syncObserver)
    void a.pollGateway();
    void a.pollHiscores();
    a.playtimeTick();
    if (a.managed && a.cfg.autostart && !NO_AUTOSTART) void a.managed.start();
}
for (const a of accounts.values()) bootAccount(a);
// Hot-reload: every 15 s re-read accounts.json and boot any NEW accounts. Existing accounts are never touched
// (edit/remove of an existing entry still needs a restart).
setInterval(() => {
    try {
        const cfg = readJson<{ accounts?: AccountCfg[] }>(ACCOUNTS_FILE);
        for (const c of cfg?.accounts ?? []) {
            if (!c?.name || accounts.has(c.name)) continue;
            try {
                const a = new Account(c);
                accounts.set(c.name, a);
                log(`[${c.name}] hot-loaded from ${ACCOUNTS_FILE} (${a.client}${c.autostart ? ', autostart' : ''})`);
                bootAccount(a);
            } catch (e) { log(`[${c.name}] hot-load failed: ${errMsg(e)}`); }
        }
        // Follow the file's order (the UI lists accounts in Map order); unlisted accounts keep their place at the end.
        const order = (cfg?.accounts ?? []).map(c => c?.name).filter((n): n is string => !!n && accounts.has(n));
        const current = [...accounts.keys()];
        const wanted = [...order, ...current.filter(n => !order.includes(n))];
        if (wanted.some((n, i) => n !== current[i])) {
            const entries = wanted.map(n => [n, accounts.get(n)!] as const);
            accounts.clear();
            for (const [n, a] of entries) accounts.set(n, a);
        }
    } catch (e) { log(`accounts hot-reload failed: ${errMsg(e)}`); }
}, 15_000);
setInterval(() => { for (const a of accounts.values()) void a.pollGateway(); }, 20_000);
setInterval(() => { for (const a of accounts.values()) void a.syncObserver(); }, 10_000);
setInterval(() => { for (const a of accounts.values()) void a.pollHiscores(); }, 5 * 60_000);
setInterval(() => { for (const a of accounts.values()) a.takeSample(); }, 5_000);
setInterval(() => { for (const a of accounts.values()) void a.refreshBank(); }, 15_000);
for (const a of accounts.values()) void a.refreshBank();
setInterval(() => { for (const a of accounts.values()) a.playtimeTick(); }, 15_000);
setInterval(() => { for (const a of accounts.values()) a.broadcastStatus(); }, 5_000);
void pollRecord();
setInterval(pollRecord, 10 * 60_000);
void detectTelemetry();
setInterval(detectTelemetry, 30_000);
let shuttingDown = false;
const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const a of accounts.values()) a.flushPlaytime();
    // detach, don't stop: the managed Chromes (and every bot's client session) survive the restart
    await Promise.race([Promise.all([...accounts.values()].map(a => a.managed?.detach())), sleep(8000)]);
    process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const ips = Object.values(networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i!.address);
const q = TOKEN ? `/?token=${TOKEN}` : '/';
console.log(`\n[dashboard] multi-account dashboard running on port ${PORT}: ${[...accounts.values()].map(a => `${a.name} (${a.client})`).join(', ')}`);
console.log(`  desktop:  http://localhost:${PORT}${q}`);
for (const ip of ips) console.log(`  phone:    http://${ip}:${PORT}${q}   (same Wi-Fi)`);
for (const a of accounts.values()) console.log(`  [${a.name}] botDir ${a.botDir} · pause file ${a.pauseFile} · process match ${(a.cfg.procMatch ?? []).join(' | ')} · stats: observe-mode SDK -> ${a.gatewayUrl}`);
console.log('');
