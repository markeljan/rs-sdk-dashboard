import { join, resolve } from 'node:path';
import { Director, PLACES, type Player } from './tv/director';
import { regionFor, SceneSnapshot } from './tv/relay';
import type { ServerWebSocket } from 'bun';

const SITE = resolve(process.env.TV_SITE_DIR ?? 'tv-build');
const FEED = process.env.TV_WORLD_FEED ?? 'wss://rs-sdk-demo.fly.dev/worldfeed';
const director = new Director();
const started = Date.now();
const peers = new Set<ServerWebSocket<Peer>>();
type Peer = { channel?: Channel; messages: number; window: number };
class Channel {
    ws?: WebSocket;
    snapshot = new SceneSnapshot();
    viewers = new Set<ServerWebSocket<Peer>>();
    receivedAt = 0;
    retry?: ReturnType<typeof setTimeout>;
    idle?: ReturnType<typeof setTimeout>;
    stopped = false;
    backoff = 1000;
    constructor(readonly key: string, readonly area: { x: number; z: number; w: number; h: number }, readonly scout = false) { this.connect(); }
    connect() {
        if (this.stopped) return;
        const ws = this.ws = new WebSocket(FEED);
        ws.onopen = () => { this.backoff = 1000; ws.send(JSON.stringify({ t: 'sub', ...this.area })); if (this.key === 'roster') ws.send('{"t":"roster","on":true}'); };
        ws.onmessage = e => {
            try {
                const m = JSON.parse(String(e.data)); this.receivedAt = Date.now(); this.snapshot.apply(m);
                if (m.t === 'roster') director.roster(m.p as Player[]);
                if (m.t === 'tick') director.activity(m.p ?? []);
                for (const peer of this.viewers) this.send(peer, String(e.data));
            } catch (err) { console.error('TV feed frame:', String(err)); }
        };
        ws.onerror = () => {};
        ws.onclose = () => {
            for (const peer of this.viewers) peer.close(1012, 'World feed reconnecting');
            if (!this.stopped) { this.retry = setTimeout(() => this.connect(), this.backoff); this.backoff = Math.min(15000, this.backoff * 2); }
        };
    }
    send(peer: ServerWebSocket<Peer>, data: string) {
        if (peer.getBufferedAmount() > 1024 * 1024) { peer.close(1013, 'Slow connection: reconnect for a fresh scene'); return; }
        peer.send(data);
    }
    add(peer: ServerWebSocket<Peer>) {
        clearTimeout(this.idle); this.viewers.add(peer); peer.data.channel = this;
        for (const m of this.snapshot.frames()) this.send(peer, JSON.stringify(m));
        if (rosterFeed.snapshot.roster) this.send(peer, JSON.stringify(rosterFeed.snapshot.roster));
    }
    remove(peer: ServerWebSocket<Peer>) {
        this.viewers.delete(peer);
        if (!this.scout && !this.viewers.size) this.idle = setTimeout(() => { if (!this.viewers.size) { this.stop(); channels.delete(this.key); } }, 15000);
    }
    stop() { this.stopped = true; clearTimeout(this.retry); clearTimeout(this.idle); this.ws?.close(); }
}
const channels = new Map<string, Channel>();
// Three persistent feeds scout the event locations; one also carries the global roster.
const rosterFeed = new Channel('roster', { x: 3320, z: 3210, w: 128, h: 128 }, true);
const scouts = [new Channel('castle', { x: 2330, z: 3020, w: 160, h: 160 }, true), new Channel('boss', { x: 3430, z: 9460, w: 100, h: 100 }, true)];
const directorTimer = setInterval(() => {
    director.choose();
    const r = rosterFeed.snapshot.roster;
    if (r) for (const peer of peers) if (peer.data.channel && peer.data.channel !== rosterFeed) peer.data.channel.send(peer, JSON.stringify(r));
    for (const c of [rosterFeed, ...scouts, ...channels.values()]) {
        if (c.ws?.readyState === WebSocket.OPEN && c.receivedAt && Date.now() - c.receivedAt > 20000) c.ws.close();
    }
}, 3000);
function state() {
    const now = Date.now();
    return { ok: now - director.rosterAt < 15000, status: now - director.rosterAt < 15000 ? 'live' : 'reconnecting', rosterAt: director.rosterAt, now, started, players: director.players.length, viewers: peers.size, upstreamConnections: channels.size + 3, shot: director.shot, upcoming: director.candidates().slice(0, 8), places: PLACES };
}
const headers = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin' };
const server = Bun.serve<Peer>({
    port: Number(process.env.PORT ?? 4750), hostname: process.env.HOST ?? '127.0.0.1', idleTimeout: 60,
    async fetch(req, srv) {
        const u = new URL(req.url);
        if (u.pathname === '/health' || u.pathname === '/api/tv') return Response.json(state(), { headers: { ...headers, 'cache-control': 'no-store' } });
        if (u.pathname === '/worldfeed') {
            const origin = req.headers.get('origin');
            if (origin && new URL(origin).host !== u.host) return new Response('Forbidden', { status: 403 });
            if (peers.size >= 500) return new Response('Viewer capacity reached', { status: 503 });
            return srv.upgrade(req, { data: { messages: 0, window: Date.now() } }) ? undefined : new Response('WebSocket required', { status: 400 });
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
        const path = resolve(join(SITE, decodeURIComponent(u.pathname)));
        if (!path.startsWith(SITE + '/') && path !== SITE) return new Response('Not found', { status: 404 });
        const file = Bun.file(u.pathname === '/' ? join(SITE, 'index.html') : path);
        if (!(await file.exists())) return new Response('Not found', { status: 404 });
        return new Response(file, { headers: { ...headers, 'cache-control': /\/static\//.test(u.pathname) ? 'public,max-age=31536000,immutable' : /\/caches\//.test(u.pathname) ? 'public,max-age=3600' : 'no-cache' } });
    },
    websocket: {
        maxPayloadLength: 1024, idleTimeout: 120, sendPings: true,
        open(peer) { peers.add(peer); },
        message(peer, raw) {
            if (Date.now() - peer.data.window > 1000) { peer.data.messages = 0; peer.data.window = Date.now(); }
            if (++peer.data.messages > 30) { peer.close(1008, 'Too many camera updates'); return; }
            try {
                const m = JSON.parse(String(raw));
                if (m.t !== 'sub') return;
                const region = regionFor(m); if (!region) return;
                if (peer.data.channel?.key === region.key) return;
                let channel = channels.get(region.key);
                if (!channel) {
                    if (channels.size >= 20) {
                        const unused = [...channels.values()].find(c => c.viewers.size === 0);
                        if (unused) { unused.stop(); channels.delete(unused.key); }
                        else { peer.close(1013, 'Camera capacity reached; try again shortly'); return; }
                    }
                    channel = new Channel(region.key, region); channels.set(region.key, channel);
                }
                peer.data.channel?.remove(peer); channel.add(peer);
            } catch { /* ignore invalid spectator requests */ }
        },
        close(peer) { peers.delete(peer); peer.data.channel?.remove(peer); },
    },
});
console.log(`RS-SDK TV listening on ${server.url}`);
function stop() { clearInterval(directorTimer); for (const c of [rosterFeed, ...scouts, ...channels.values()]) c.stop(); server.stop(true); process.exit(0); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
