// Bank wealth for the account pills: the newest known bank contents of an account, valued in gp.
//
// Sources (newest wins): the dashboard's own snapshot (telemetry/bank-<name>.json, written whenever the observed
// state shows the bank open), and whatever the account's scripts left in its bot dir: bank-snapshot.json
// ({at, items:[{id,name,count}]}, bots/money/lib.ts), bank.json ({at, bank:[{name,count}]}), bank-cache.json
// ({name: count}, keyed by lower-case name; timestamped by mtime).
// Valuation matches bots/money/lib.ts: coins count 1 each; other items max(GE bid or last trade, floor(0.6 * base))
// from the public market API, cached 20 min; unknown items count 0.
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

export type BankItem = { id?: number; name: string; count: number };
export type BankSnap = { at: number; items: BankItem[]; source: string };

const ORIGIN = process.env.MARKET_ORIGIN ?? 'https://rs-sdk-demo.fly.dev';

function readSnap(file: string, parse: (j: any) => BankItem[] | null): BankSnap | null {
    if (!existsSync(file)) return null;
    try {
        const j = JSON.parse(readFileSync(file, 'utf8'));
        const items = parse(j);
        if (!items?.length) return null;
        const at = Date.parse(j.at ?? '') || statSync(file).mtimeMs;
        return { at, items, source: file };
    } catch { return null; }
}

const listOf = (l: any): BankItem[] | null => (Array.isArray(l) ? l.filter(i => i?.name && Number.isFinite(i.count)).map(i => ({ id: i.id, name: i.name, count: i.count })) : null);

export function latestBankSnapshot(name: string, botDir: string, dataDir: string): BankSnap | null {
    const snaps = [
        readSnap(join(dataDir, `bank-${name}.json`), j => listOf(j.items)),
        readSnap(join(botDir, 'bank-snapshot.json'), j => listOf(j.items)),
        readSnap(join(botDir, 'bank.json'), j => listOf(j.bank ?? j.items)),
        readSnap(join(botDir, 'bank-cache.json'), j => (j && typeof j === 'object' && !Array.isArray(j)
            ? Object.entries(j).filter(([, c]) => Number.isFinite(c)).map(([n, c]) => ({ name: n, count: c as number })) : null)),
    ].filter((s): s is BankSnap => !!s);
    return snaps.sort((a, b) => b.at - a.at)[0] ?? null;
}

// ---------------------------------------------------------------- market prices
type Quote = { id: number; name: string; basePrice: number; bid: number | null; lastPrice: number | null };
const cache = new Map<string, { v: number; at: number }>();
const TTL = 20 * 60_000;
const getJson = async (url: string) => { const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); if (r.status === 404) return null; if (!r.ok) throw new Error(`${r.status}`); return r.json(); };
const unit = (q: Quote | null) => (q ? Math.max(q.bid ?? q.lastPrice ?? 0, Math.floor((q.basePrice ?? 0) * 0.6)) : 0);

async function unitValue(it: BankItem): Promise<number> {
    if (it.id === 995 || /^coins$/i.test(it.name)) return 1;
    const key = it.id != null ? `id:${it.id}` : `n:${it.name.toLowerCase()}`;
    const c = cache.get(key);
    if (c && Date.now() - c.at < TTL) return c.v;
    try {
        let q: Quote | null = it.id != null ? await getJson(`${ORIGIN}/api/market/items/${it.id}?days=30`) : null;
        if (!q) {
            const r = await getJson(`${ORIGIN}/api/market/items?q=${encodeURIComponent(it.name.slice(0, 80))}&limit=25&days=30`);
            const exact = (r?.items ?? []).filter((i: Quote) => i.name.toLowerCase() === it.name.toLowerCase());
            q = exact.sort((a: Quote, b: Quote) => unit(a) - unit(b))[0] ?? null; // noted/duplicate names: the lowest value
        }
        const v = unit(q);
        cache.set(key, { v, at: Date.now() });
        return v;
    } catch { return c?.v ?? 0; } // network error: keep the stale value
}

export async function valueBank(items: BankItem[]): Promise<{ total: number; coins: number }> {
    let total = 0, coins = 0;
    for (const it of items) {
        const v = await unitValue(it);
        total += v * it.count;
        if (it.id === 995 || /^coins$/i.test(it.name)) coins += it.count;
    }
    return { total, coins };
}
