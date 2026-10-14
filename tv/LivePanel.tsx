import { useEffect, useMemo, useRef, useState } from "react";
import { RankingsPanel } from "./RankingsPanel";
import { PlayerDetails } from "./PlayerDetails";
import { ChatPanel } from "./ChatPanel";
import { MapViewer } from "../mapviewer/MapViewer";
import { PLACES, placeAt, Shot } from "./director";
import "./LivePanel.css";

type Broadcast = { status: string; rosterAt: number; now: number; players: number; viewers: number; shot: Shot | null; upcoming: Shot[] };
type Mode = "auto" | "follow" | "free";
export function LivePanel({ mapViewer }: { mapViewer: MapViewer }): JSX.Element {
    const [mode, setMode] = useState<Mode>(() => new URLSearchParams(window.location.search).has("follow") ? "follow" : "auto");
    const [broadcast, setBroadcast] = useState<Broadcast>();
    const [search, setSearch] = useState("");
    const [tab, setTab] = useState("onair");
    const [open, setOpen] = useState(window.innerWidth > 700);
    const [cinema, setCinema] = useState(() => new URLSearchParams(window.location.search).get("clean") === "1");
    const [, render] = useState(0);
    const [limit, setLimit] = useState(60);
    const [lastTickAt, setLastTickAt] = useState(0);
    const tick = useRef(-1);
    const shotKey = useRef("");
    useEffect(() => {
        document.title = "RS-SDK TV · Live from Gielinor";
        let cancelled = false;
        const update = async () => {
            try {
                const r = await fetch("/api/tv", { signal: AbortSignal.timeout(5000) });
                if (!r.ok) throw new Error("feed unavailable");
                const state: Broadcast = await r.json(); if (!cancelled) setBroadcast(state);
            } catch { if (!cancelled) setBroadcast(b => b ? { ...b, status: "reconnecting" } : undefined); }
        };
        void update(); const timer = setInterval(update, 2000);
        const refresh = setInterval(() => {
            const live = mapViewer.live;
            const renderer = mapViewer.renderer as typeof mapViewer.renderer & { maxLevel: number; setMaxLevel(level: number): void };
            const level = live?.getFollowed()?.level;
            if (level !== undefined && renderer.maxLevel !== level) renderer.setMaxLevel(level);
            if (live && live.world.tick !== tick.current) { tick.current = live.world.tick; setLastTickAt(Date.now()); }
            render(v => v + 1);
        }, 500);
        return () => { cancelled = true; clearInterval(timer); clearInterval(refresh); };
    }, [mapViewer]);
    useEffect(() => {
        const s = broadcast?.shot; const live = mapViewer.live;
        if (mode !== "auto" || !s || !live || broadcast?.status !== "live") return;
        const key = s.id + ":" + s.since;
        if (key !== shotKey.current) {
            if (s.follow) { if (!live.world.rosterPlayers.some(p => p[1] === s.follow)) return; live.goToPlayer(s.follow, mapViewer.camera); }
            shotKey.current = key;
        }
    }, [broadcast, mode, mapViewer]);
    useEffect(() => {
        const canvas = mapViewer.renderer.canvas;
        const manual = (e: KeyboardEvent) => { if (document.activeElement === canvas && /^[wasdrecf]$/i.test(e.key)) setMode("free"); };
        const pointer = (e: PointerEvent) => { if (e.buttons === 2) setMode("free"); };
        const changeMode = (e: Event) => setMode((e as CustomEvent<Mode>).detail);
        document.addEventListener("tv-mode", changeMode); document.addEventListener("keydown", manual); canvas.addEventListener("pointermove", pointer);
        return () => { document.removeEventListener("tv-mode", changeMode); document.removeEventListener("keydown", manual); canvas.removeEventListener("pointermove", pointer); };
    }, [mapViewer]);
    useEffect(() => { document.body.dataset.tvMode = mode; }, [mode]);
    const live = mapViewer.live;
    const roster = live?.world.rosterPlayers;
    const players = useMemo(() => (roster ?? []).filter(p => p[1].toLowerCase().includes(search.toLowerCase())).sort((a,b) => a[1].localeCompare(b[1])), [roster, search]);
    const follow = (name: string) => { setMode("follow"); live?.goToPlayer(name, mapViewer.camera); setTab("account"); };
    const auto = () => { shotKey.current = ""; setMode("auto"); };
    const jump = (x: number, z: number) => {
        setMode("free"); live?.unfollow();
        const c = mapViewer.camera; c.pos[0] = x; c.pos[1] = -16; c.pos[2] = z - 14; c.pitch = -240; c.setYaw(0); c.updatedPosition = true;
    };
    const stale = !lastTickAt || Date.now() - lastTickAt > 10000 || live?.status !== "open";
    const onair = mode === "auto" ? broadcast?.shot?.name ?? "Finding the next story" : mode === "follow" ? live?.followName ?? "Choose a player" : placeAt(Math.round(mapViewer.camera.getPosX()), Math.round(mapViewer.camera.getPosZ()));
    useEffect(() => { document.body.classList.toggle("tv-cinema", cinema); return () => document.body.classList.remove("tv-cinema"); }, [cinema]);
    return <>
        <header className="tv-top"><a className="tv-brand" href="/">RS-SDK <b>TV</b></a><span className={"tv-signal " + (stale ? "waiting" : "")}>● {stale ? "CONNECTING" : "LIVE"}</span><span className="tv-online">{live?.world.rosterPlayers.length ?? 0} players online</span><button onClick={() => document.dispatchEvent(new Event("tv-map"))}>Map</button><button aria-label="Toggle cinema mode" onClick={() => setCinema(!cinema)}>{cinema ? "Show controls" : "Cinema"}</button><button aria-label="Toggle fullscreen" onClick={() => document.fullscreenElement ? void document.exitFullscreen() : void document.documentElement.requestFullscreen()}>⛶</button></header>
        <div className="tv-caption"><span className="tv-eyebrow">{mode === "auto" ? "AUTO DIRECTOR" : mode === "follow" ? "FOLLOWING" : "FREE CAMERA"}</span><h1>{onair}</h1><p>{stale ? "Reconnecting to the world. The scene will resume automatically." : mode === "auto" ? broadcast?.shot?.reason : mode === "follow" ? "Drag to orbit · Scroll to zoom" : "WASD to fly · Arrow keys to look · E / C for height"}</p></div>
        {!cinema && <aside className={"tv-panel " + (open ? "" : "tv-collapsed")}>
            <button className="tv-panel-heading" onClick={() => setOpen(!open)}>Explore the world <span>{open ? "−" : "+"}</span></button>
            {open && <>
                <div className="tv-modes"><button className={mode === "auto" ? "selected" : ""} onClick={auto}>◉ Auto TV</button><button className={mode === "follow" ? "selected" : ""} onClick={() => { setMode("follow"); setTab(live?.followName ? "account" : "players"); }}>Follow</button><button className={mode === "free" ? "selected" : ""} onClick={() => { setMode("free"); live?.unfollow(); }}>Free cam</button></div>
                <nav className="tv-tabs">{[["onair","On air"],["players","Players"],["rankings","Rankings"],["places","Places"],["account","Player"],["chat","Chat"]].map(([id,label]) => <button key={id} className={tab === id ? "selected" : ""} onClick={() => setTab(id)}>{label}</button>)}</nav>
                {tab === "onair" && <div className="tv-content"><p className="tv-muted">One camera, the whole server. The director changes scenes every 35 seconds, favoring combat, bosses, busy places and public chat.</p><div className="tv-section-label">AROUND THE WORLD</div>{broadcast?.upcoming.map(s => <button className="tv-story" key={s.id} onClick={() => s.follow ? follow(s.follow) : jump(s.x,s.z)}><strong>{s.name}</strong><small>{s.reason}</small></button>)}<p className="tv-muted tv-footnote">Live public world data. Camera controls affect only your view.</p></div>}
                {tab === "players" && <><input className="tv-search" aria-label="Find a player" placeholder={`Search ${players.length.toLocaleString()} online players…`} value={search} onChange={e => { setSearch(e.target.value); setLimit(60); }} onKeyDown={e => { if (e.key === "Enter" && players[0]) follow(players[0][1]); }}/><div className="tv-content tv-players" onScroll={e => { const t = e.currentTarget; if (t.scrollTop + t.clientHeight > t.scrollHeight - 100) setLimit(n => n + 60); }}>{players.slice(0,limit).map(p => <button className={"tv-player " + (p[1] === live?.followName ? "selected" : "")} key={p[0]} onClick={() => follow(p[1])}><span>{p[1]}<small>{placeAt(p[2],p[3])}</small></span><em>Lv {p[5]}</em></button>)}{!players.length && <p className="tv-muted">No matching online players.</p>}</div></>}
                {tab === "rankings" && <RankingsPanel follow={follow}/>}
                {tab === "account" && <PlayerDetails name={live?.followName} combat={roster?.find(p => p[1] === live?.followName)?.[5]} position={(() => { const p = roster?.find(p => p[1] === live?.followName); return p ? placeAt(p[2],p[3]) : undefined; })()}/>}
                {tab === "chat" && <ChatPanel/>}
                {tab === "places" && <div className="tv-content"><p className="tv-muted">Jump instantly. Open the map in the top left to explore anywhere; double-click a tile or select a player marker.</p>{PLACES.map(p => <button className="tv-story" key={p.name} onClick={() => jump(p.x,p.z)}><strong>{p.name}</strong><small>{p.x}, {p.z}</small></button>)}</div>}
            </>}
        </aside>}
        {!cinema && <footer className="tv-footer"><span>GIELINOR, AS IT HAPPENS.</span><a href="https://dash.soko.tools">Dashboard ↗</a><span className="tv-credits">Renderer: <a href="https://github.com/MaxBittker/rs-world">rs-world</a> / <a href="https://github.com/dennisdev/rs-map-viewer">dennisdev</a></span></footer>}
    </>;
}
