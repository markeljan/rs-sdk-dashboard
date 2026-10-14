import { useEffect, useState } from "react";
import type { Skill, Score } from "./hiscores";

type Wealth = { entry: Score | null; status: string; source: string; fetchedAt: number | null };
type Profile = { name: string; skills: Skill[]; fetchedAt: number; stale: boolean; source: string; bank: Wealth; equipment: Wealth };
function PublishedItems({ title, data }: { title: string; data: Wealth }) {
    return <section className="tv-published-items"><h3>{title} {data.entry && <span>{data.entry.value.toLocaleString()} GP</span>}</h3>{data.entry ? <><p className="tv-muted">Published rank #{data.entry.rank} · {data.status === 'stale' ? 'saved snapshot' : 'hiscores snapshot'}</p>{data.entry.items?.map((item,i) => <div className="tv-item-row" key={i}><span>{item.name}</span><small>{item.value.toLocaleString()} GP</small></div>)}{title === 'Bank' && <p className="tv-muted tv-footnote">Up to 6 published top items.</p>}</> : <p className="tv-muted">{data.status === 'unavailable' ? 'Public snapshot temporarily unavailable.' : 'Not in the published top 50. Bank and item details are unavailable for this player.'}</p>}</section>;
}
export function PlayerDetails({ name, combat, position }: { name?: string; combat?: number; position?: string }) {
    const [profile, setProfile] = useState<Profile>();
    const [error, setError] = useState('');
    useEffect(() => {
        const controller = new AbortController(); setProfile(undefined); setError('');
        if (name) void fetch(`/api/player?name=${encodeURIComponent(name)}`, { signal: controller.signal }).then(async r => { const data = await r.json(); if (!r.ok) throw new Error(data.error); if (!controller.signal.aborted) setProfile(data); }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
        return () => controller.abort();
    }, [name]);
    if (!name) return <div className="tv-content"><p className="tv-muted">Choose a player from Players or Rankings to see their public skills and published items while you watch.</p></div>;
    const overall = profile?.skills.find(s => s.category === 0), quests = profile?.skills.find(s => s.category === 100);
    return <div className="tv-content tv-player-details"><h2>{name}</h2><p className="tv-muted">{combat !== undefined ? `Combat ${combat} · ` : ''}{position}</p>{error ? <p className="tv-muted" role="status">{error}</p> : !profile ? <p className="tv-muted">Loading public profile…</p> : <>
        <div className="tv-stat-summary"><span>Total level<b>{overall?.level?.toLocaleString() ?? '—'}</b></span><span>Overall rank<b>{overall?.rank ? `#${overall.rank}` : '—'}</b></span><span>Quest points<b>{quests?.level ?? '—'}</b></span></div>
        <p className="tv-muted tv-score-source">Published skills · {profile.stale ? 'saved snapshot' : `fetched ${new Date(profile.fetchedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`}</p>
        <div className="tv-skill-grid">{profile.skills.filter(s => s.category > 0 && s.category < 100).map(s => <div key={s.category} title={`${s.name} · rank ${s.rank ?? 'unranked'} · ${s.time} to score`}><span>{s.name}</span><b>{s.level ?? '—'}</b></div>)}</div>
        <PublishedItems title="Bank" data={profile.bank}/><PublishedItems title="Equipment" data={profile.equipment}/>
        <p className="tv-muted tv-footnote">These are public hiscore snapshots. Live inventory and a full private bank are unavailable.</p><a className="tv-source-link" href={profile.source} target="_blank" rel="noreferrer">View official profile ↗</a>
    </>}</div>;
}
