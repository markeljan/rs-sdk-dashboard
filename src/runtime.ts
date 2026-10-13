// Live side of each account: polls the gateway for state, samples XP, owns the optional managed game client and
// fans its frames out to viewers. Fleet keeps one AccountRuntime per stored account.
import type { Config } from './config';
import type { Account, Store } from './db';
import { fetchState, fetchStatus } from './gateway';
import { ManagedClient } from './managed';

export type Summary = ReturnType<typeof summarize>;

const SKILL_ORDER = ['Attack', 'Hitpoints', 'Mining', 'Strength', 'Agility', 'Smithing', 'Defence', 'Herblore', 'Fishing', 'Ranged', 'Thieving',
    'Cooking', 'Prayer', 'Crafting', 'Firemaking', 'Magic', 'Fletching', 'Woodcutting', 'Runecraft'];

/** The parts of a gateway state frame the dashboard shows. */
export function summarize(state: any) {
    if (!state) return null;
    type Skill = { name: string; level: number; base: number; xp: number };
    const skills: Skill[] = (Array.isArray(state.skills) ? state.skills : [])
        .map((s: any) => ({ name: String(s.name), level: Number(s.level) || 0, base: Number(s.baseLevel ?? s.level) || 0, xp: Number(s.experience) || 0 }))
        .filter((s: any) => s.name && s.name !== 'Overall')
        .sort((a: any, b: any) => (SKILL_ORDER.indexOf(a.name) + 1 || 99) - (SKILL_ORDER.indexOf(b.name) + 1 || 99));
    const items = (list: any) => (Array.isArray(list) ? list : []).filter((i: any) => i && i.id >= 0 && i.name)
        .map((i: any) => ({ slot: Number(i.slot), id: Number(i.id), name: String(i.name), count: Number(i.count) || 1 }));
    const p = state.player;
    return {
        inGame: !!state.inGame,
        tick: Number(state.tick) || 0,
        player: p ? {
            name: String(p.name ?? ''), combatLevel: Number(p.combatLevel) || 0, hp: Number(p.hp) || 0, maxHp: Number(p.maxHp) || 0,
            x: Number(p.worldX) || 0, z: Number(p.worldZ) || 0, plane: Number(p.level) || 0, runEnergy: Number(p.runEnergy) || 0,
            animation: p.animId ?? null,
        } : null,
        prayer: skills.find(s => s.name === 'Prayer') ?? null,
        skills,
        totalLevel: skills.reduce((n, s) => n + s.base, 0),
        totalXp: skills.reduce((n, s) => n + s.xp, 0),
        inventory: items(state.inventory),
        equipment: items(state.equipment),
        messages: (Array.isArray(state.gameMessages) ? state.gameMessages : []).slice(-20)
            .map((m: any) => ({ type: Number(m.type) || 0, text: String(m.text ?? ''), sender: m.sender ?? null, tick: m.tick ?? null })),
        dialog: state.dialog?.isOpen ? { text: state.dialog.text ?? null, options: (state.dialog.options ?? []).map((o: any) => o.text ?? String(o)) } : null,
        bankOpen: !!state.bank?.isOpen,
    };
}

export function xpRate(samples: { at: number; total_xp: number }[], now = Date.now(), windowMs = 3_600_000) {
    const recent = samples.filter(s => now - s.at <= windowMs);
    if (recent.length < 2) return null;
    const a = recent[0]!, b = recent[recent.length - 1]!;
    const span = b.at - a.at;
    if (span < 5 * 60_000) return null;
    return Math.round((b.total_xp - a.total_xp) / span * 3_600_000);
}

/** maxFps: the viewer's own cap (data saver on phones); frames in between are skipped for that viewer only. */
export type Viewer = { send: (data: string | Buffer) => void; buffered: () => number; maxFps: number; lastSentAt: number };

export class AccountRuntime {
    account: Account;
    summary: Summary = null;
    stateAt = 0;
    stateAge: number | null = null;
    botStatus = 'unknown';
    gatewayError = '';
    lastPollAt = 0;
    private polling = false;
    private lastSampleAt = 0;
    readonly viewers = new Set<Viewer>();
    managed: ManagedClient;
    clientNote = '';
    private lastWarnAt = 0;

    constructor(account: Account, private store: Store, private cfg: Config, private log: (m: string) => void, private onUpdate: (rt: AccountRuntime) => void) {
        this.account = account;
        this.managed = new ManagedClient(`acct-${account.id}`, () => this.account,
            { dataDir: cfg.dataDir, chromePath: cfg.chromePath, fps: cfg.streamFps, idleFps: cfg.idleFps, quality: cfg.streamQuality, log },
            (jpeg, w, h) => this.broadcastFrame(jpeg, w, h),
            () => this.onUpdate(this));
    }

    get id() { return this.account.id; }
    online() { return !!this.summary?.inGame && this.botStatus !== 'dead' && this.stateAge != null && Date.now() - this.stateAt < 60_000 && this.stateAge < 30_000; }

    pollDue(now: number) {
        const every = this.viewers.size > 0 ? 2500 : this.cfg.idlePollSec * 1000;
        return !this.polling && now - this.lastPollAt >= every;
    }

    async poll() {
        if (this.polling) return;
        this.polling = true; this.lastPollAt = Date.now();
        try {
            const a = this.account;
            if (!a.password) { this.gatewayError = 'password missing - edit the account'; return; }
            const r = await fetchState(a.server, a.name, a.password);
            this.botStatus = r.botStatus;
            this.gatewayError = r.error ?? '';
            if (r.state) {
                this.summary = summarize(r.state); this.stateAt = Date.now(); this.stateAge = r.stateAge;
                const now = Date.now();
                if (this.summary?.inGame && this.summary.totalXp > 0 && now - this.lastSampleAt >= 60_000) {
                    this.lastSampleAt = now;
                    this.store.addSample(a.id, this.summary.totalXp, this.summary.totalLevel, now);
                }
            } else if (this.summary) {
                this.summary = { ...this.summary, inGame: false };
            }
        } finally {
            this.polling = false;
            this.onUpdate(this);
        }
    }

    /** Start the managed client unless another game client is already logged in as this account. */
    async ensureClient(allowed: boolean, why = '') {
        const m = this.managed;
        if (!this.account.runClient || !allowed) {
            if (m.wanted) await m.stop();
            this.clientNote = this.account.runClient && !allowed ? why : '';
            return;
        }
        if (m.wanted) return;
        const st = await fetchStatus(this.account.server, this.account.name);
        if (st?.inGame && st.status === 'active') {
            this.clientNote = 'another game client is logged in as this account - close it, or the dashboard keeps waiting';
            if (Date.now() - this.lastWarnAt > 300_000) { this.lastWarnAt = Date.now(); this.log(`[${this.account.name}] not starting client: already logged in elsewhere`); }
            this.onUpdate(this);
            return;
        }
        this.clientNote = '';
        void m.start(); // can take a minute (page load); don't hold up the sync
    }

    addViewer(v: Viewer) { this.viewers.add(v); this.managed.setViewers(this.viewers.size); }
    removeViewer(v: Viewer) { this.viewers.delete(v); this.managed.setViewers(this.viewers.size); }

    private broadcastFrame(jpeg: Buffer, w: number, h: number) {
        // binary frame: 4-byte account id + 2+2 bytes size + JPEG
        const head = Buffer.alloc(8);
        head.writeUInt32BE(this.id, 0); head.writeUInt16BE(w, 4); head.writeUInt16BE(h, 6);
        const msg = Buffer.concat([head, jpeg]);
        const now = Date.now();
        for (const v of this.viewers) {
            if (v.buffered() > 1_500_000 || now - v.lastSentAt < 1000 / v.maxFps - 15) continue; // slow or capped viewers skip frames
            v.lastSentAt = now;
            v.send(msg);
        }
    }

    view() {
        const a = this.account;
        const samples = this.store.samples(a.id, Date.now() - 6 * 3_600_000);
        return {
            id: a.id, name: a.name, server: a.server, source: a.source, runClient: a.runClient, hasPassword: !!a.password,
            botDir: a.bot_dir ? true : false,
            online: this.online(), botStatus: this.botStatus, gatewayError: this.gatewayError, stateAge: this.stateAge, stateAt: this.stateAt,
            client: { ...this.managed.info(), note: this.clientNote },
            activity: a.activity, activityAt: a.activity_at,
            xpPerHour: xpRate(samples),
            history: samples.filter((_, i, arr) => i % Math.max(1, Math.floor(arr.length / 120)) === 0).map(s => [s.at, s.total_xp]),
            summary: this.summary,
        };
    }

    card() {
        const s = this.summary;
        return {
            id: this.id, name: this.account.name, server: this.account.server, online: this.online(), botStatus: this.botStatus,
            gatewayError: this.gatewayError, runClient: this.account.runClient, client: this.managed.state, clientInGame: this.managed.inGame,
            combat: s?.player?.combatLevel ?? null, totalLevel: s?.totalLevel ?? null, hp: s?.player ? [s.player.hp, s.player.maxHp] : null,
            pos: s?.player ? [s.player.x, s.player.z, s.player.plane] : null, activity: this.account.activity,
            xpPerHour: xpRate(this.store.samples(this.id, Date.now() - 3_600_000)),
        };
    }
}

export class Fleet {
    readonly runtimes = new Map<number, AccountRuntime>();
    private timer: ReturnType<typeof setInterval> | null = null;
    private chain: Promise<void> = Promise.resolve();
    listeners = new Set<(rt: AccountRuntime) => void>();

    constructor(private store: Store, private cfg: Config, private log: (m: string) => void) {}

    start() {
        void this.sync();
        this.timer = setInterval(() => this.tick(), 1000);
        setInterval(() => void this.sync(), 15_000);
        setInterval(() => this.store.pruneSamples(Date.now() - 14 * 86_400_000), 3_600_000);
    }

    private tick() {
        const now = Date.now();
        let inFlight = 0;
        for (const rt of this.runtimes.values()) {
            if (inFlight >= 8) break; // spread polls of large fleets over several ticks
            if (rt.pollDue(now)) { inFlight++; void rt.poll(); }
        }
    }

    get(id: number) { return this.runtimes.get(id) ?? null; }
    forUser(userId: number) { return [...this.runtimes.values()].filter(r => r.account.user_id === userId); }

    /** Reconcile runtimes with the database and apply client caps (serialised). */
    sync(): Promise<void> {
        this.chain = this.chain.then(() => this.doSync());
        return this.chain;
    }

    private async doSync() {
        try {
            const accounts = this.store.listAccounts();
            const ids = new Set(accounts.map(a => a.id));
            for (const [id, rt] of this.runtimes) {
                if (!ids.has(id)) { this.runtimes.delete(id); await rt.managed.destroy(); }
            }
            for (const a of accounts) {
                let rt = this.runtimes.get(a.id);
                if (!rt) {
                    rt = new AccountRuntime(a, this.store, this.cfg, this.log, r => { for (const l of this.listeners) l(r); });
                    this.runtimes.set(a.id, rt);
                } else rt.account = a;
            }
            let total = 0;
            const perUser = new Map<number, number>();
            for (const rt of this.runtimes.values()) {
                if (!rt.account.runClient) { await rt.ensureClient(false); continue; }
                const u = perUser.get(rt.account.user_id) ?? 0;
                const allowed = total < this.cfg.maxClientsTotal && u < this.cfg.maxClientsPerUser;
                if (allowed) { total++; perUser.set(rt.account.user_id, u + 1); }
                await rt.ensureClient(allowed, total >= this.cfg.maxClientsTotal ? 'the dashboard is at its game-client capacity' : `limit of ${this.cfg.maxClientsPerUser} game clients per user`);
            }
        } catch (e) {
            this.log(`sync failed: ${(e as Error).message}`);
        }
    }

    async refresh(id: number) { await this.sync(); await this.get(id)?.poll(); }

    async shutdown() {
        if (this.timer) clearInterval(this.timer);
        await Promise.all([...this.runtimes.values()].map(r => r.managed.stop()));
    }
}
