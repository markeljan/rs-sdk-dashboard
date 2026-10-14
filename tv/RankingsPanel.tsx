import { useEffect, useState } from "react";
import { CATEGORIES } from "./hiscores";

type Row = { name: string; rank: number; value: number; time?: string; online: boolean | null; followName: string | null };
type Board = { entries: Row[]; fetchedAt: number; stale: boolean; source: string; coverage: number; onlineFresh: boolean };
export function RankingsPanel({ follow }: { follow(name: string): void }) {
    const [category, setCategory] = useState('overall');
    const [online, setOnline] = useState(true);
    const [board, setBoard] = useState<Board>();
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        let cancelled = false; const controller = new AbortController();
        setBoard(undefined); setLoading(true); setError('');
        const load = async () => {
            try {
                const r = await fetch(`/api/rankings?category=${category}&online=${online ? 1 : 0}`, { signal: controller.signal });
                const data = await r.json(); if (!r.ok) throw new Error(data.error ?? 'Rankings unavailable');
                if (!cancelled) { setBoard(data); setError(''); }
            } catch (e) { if (!cancelled) setError((e as Error).message); }
            finally { if (!cancelled) setLoading(false); }
        };
        void load(); const timer = setInterval(load, 10000);
        return () => { cancelled = true; controller.abort(); clearInterval(timer); };
    }, [category, online]);
    const selected = CATEGORIES.find(c => c.id === category)!;
    return <>
        <div className="tv-ranking-filters"><select aria-label="Rank accounts by" value={category} onChange={e => setCategory(e.target.value)}>{CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><label><input type="checkbox" checked={online} onChange={e => setOnline(e.target.checked)} /> Online only</label></div>
        <div className="tv-content tv-ranking-list">
            {loading && <p className="tv-muted">Loading public hiscores…</p>}
            {error && <p className="tv-muted" role="status">{error}. Retrying shortly.</p>}
            {board && <>
                <p className="tv-muted tv-score-source">{category === 'combat' ? 'Ranked among online players' : `Top ${board.coverage} published entries · main profile`}<br/>{board.stale ? 'Saved snapshot · refresh delayed' : `Fetched ${new Date(board.fetchedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`}{!board.onlineFresh && <><br/>Online status is reconnecting.</>}</p>
                {board.entries.map(row => <div className="tv-rank-row" key={row.name}><span className="tv-rank-number">#{row.rank}</span><div><strong>{row.name}</strong><small>{row.value.toLocaleString()} {selected.unit}{row.time ? ` · ${row.time} to score` : ''}</small></div><button className="tv-watch" disabled={!row.followName} onClick={() => row.followName && follow(row.followName)}>{row.online ? 'Watch' : row.online === null ? 'Unknown' : 'Offline'}</button></div>)}
                {!board.entries.length && <p className="tv-muted">No online players in this published top {board.coverage}. Turn off Online only to see the full list, or try another ranking.</p>}
                {category !== 'combat' && <a className="tv-source-link" href={board.source} target="_blank" rel="noreferrer">View official hiscores ↗</a>}
            </>}
        </div>
    </>;
}
