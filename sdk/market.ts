/** Public, read-only Grand Exchange market data. Trading stays in the game. */
export const MARKET_SORTS = ['relevance', 'name', 'name-desc', 'recent', 'rises', 'falls', 'marketCap', 'price', 'volume', 'value', 'buyValue', 'sellRecent'] as const;
export type MarketSort = (typeof MARKET_SORTS)[number];
export type MarketDays = 1 | 7 | 30 | 90;
export interface MarketItemOptions {
    days?: MarketDays;
}
export interface MarketItemsOptions extends MarketItemOptions {
    limit?: number;
    offset?: number;
    sort?: MarketSort;
}
export interface MarketHistoryOptions {
    from?: number;
    to?: number;
    interval?: 3600000 | 86400000;
}
export interface MarketQuote {
    id: number;
    name: string;
    basePrice: number;
    item: number;
    bid: number | null;
    ask: number | null;
    buyQuantity: number;
    /** Coins committed to unfilled bids, independent of the selected period. */
    buyValue: number;
    sellQuantity: number;
    /** Coins asked for unfilled sell offers, independent of the selected period. */
    sellValue: number;
    /** Newest open sell offer creation time (Unix ms), or null without open asks. */
    lastSellAt: number | null;
    /** Completed item quantity in the selected period (7 days by default). */
    volume: number;
    /** Gross coins exchanged in the selected period (7 days by default). */
    gross: number;
    tax: number;
    trades: number;
    lastPrice: number | null;
    lastTradeAt: number | null;
    vwap: number | null;
    referencePrice: number | null;
    change: number | null;
    changePercent: number | null;
    /** Listed sell quantity × last price, not circulating supply. */
    marketCap: number | null;
}
export interface MarketItems {
    items: MarketQuote[];
    total: number;
    offset: number;
    limit: number;
    days: MarketDays;
    sort: MarketSort;
    updatedAt: number;
    summary: {
        volume: number;
        gross: number;
        activeItems: number;
        totalItems: number;
    };
    featured: MarketQuote | null;
}
export interface MarketHistory {
    item: number;
    from: number;
    to: number;
    interval: number;
    history: {
        time: number;
        volume: number;
        gross: number;
        tax: number;
        low: number;
        high: number;
        vwap: number;
        trades: number;
    }[];
}
export interface GEAvailability {
    enabled: boolean;
    message?: string;
}
/** The server explicitly disabled GE (distinct from a transient HTTP failure). */
export class GEUnavailableError extends Error {
    readonly reason = 'ge_unavailable';
    constructor(message = 'Grand Exchange is not available on this server.') {
        super(message);
        this.name = 'GEUnavailableError';
    }
}
/** Use the game's HTTP origin, e.g. http://localhost:8888, not the gateway port. */
export class MarketClient {
    private readonly base: URL;
    constructor(origin: string) {
        this.base = new URL(origin);
        if (!['http:', 'https:'].includes(this.base.protocol)) throw new Error('Market origin must use HTTP or HTTPS.');
        this.base = new URL('/api/market/', this.base.origin);
    }
    private async get<T>(suffix: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
        const url = new URL(suffix, this.base);
        for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
        const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        let data;
        try {
            data = await response.json();
        } catch {
            throw new Error(`Market API ${response.status}: expected JSON from the game HTTP origin.`);
        }
        if (!response.ok && data?.reason === 'ge_unavailable') throw new GEUnavailableError(data.error);
        if (!response.ok) throw new Error(`Market API ${response.status}: ${data?.error ?? response.statusText}`);
        return data as T;
    }
    /** Discover server GE availability without connecting a bot or opening the exchange. */
    async status(): Promise<GEAvailability> {
        const data = await this.get<GEAvailability>('status');
        if (typeof data?.enabled !== 'boolean') throw new Error('Market API: invalid GE availability response.');
        return data;
    }
    /** Search tradeable canonical items, including current quotes and selected-period totals. */
    items(query = '', options: MarketItemsOptions = {}): Promise<MarketItems> {
        return this.get('items', { q: query, ...options });
    }
    /** Current best offers, most recent trade and selected-period volume for an item. */
    item(id: number, options: MarketItemOptions = {}): Promise<MarketQuote> {
        this.validateId(id);
        return this.get('items/' + id, { ...options });
    }
    /** UTC hour/day buckets; timestamps and interval are in milliseconds. Empty periods are omitted. */
    history(id: number, options: MarketHistoryOptions = {}): Promise<MarketHistory> {
        this.validateId(id);
        return this.get('items/' + id + '/history', { ...options });
    }
    private validateId(id: number) {
        if (!Number.isInteger(id) || id < 1) throw new Error('Item ID must be a positive integer.');
    }
}
