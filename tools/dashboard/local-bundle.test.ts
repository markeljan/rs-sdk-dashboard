import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { bundleRevision, LocalBundle } from './local-bundle';

let hostSrc = 'x.loginout.p2(289),y';
const host = Bun.serve({ port: 0, fetch: () => new Response(hostSrc, { headers: { 'Content-Type': 'application/javascript' } }) });
afterAll(() => host.stop(true));
const origin = `http://localhost:${host.port}`;
const dir = mkdtempSync(join(tmpdir(), 'local-bundle-'));
const old = (path: string) => { const t = (Date.now() - 60_000) / 1000; utimesSync(path, t, t); };

test('bundleRevision reads the login revision from a minified bundle', () => {
    expect(bundleRevision('a;this.loginout.p2(289);b')).toBe(289);
    expect(bundleRevision('no revision here')).toBeNull();
});

test('serves the local bundle only when its revision matches the host', async () => {
    const path = join(dir, 'client.js');
    const logs: string[] = [];
    writeFileSync(path, 'local;loginout.p2(289);'); old(path);
    const ok = await new LocalBundle(m => logs.push(String(m)), path, true).decide(origin);
    expect(ok.serve).toBe(true);
    if (ok.serve) expect(Buffer.from(ok.base64, 'base64').toString()).toContain('local;');

    writeFileSync(path, 'stale;loginout.p2(274);'); old(path);
    const stale = await new LocalBundle(m => logs.push(String(m)), path, true).decide(origin);
    expect(stale).toEqual({ serve: false, reason: 'local build is rev 274, host is rev 289' });
    expect(logs.some(l => l.startsWith('WARNING'))).toBe(true);

    const missing = await new LocalBundle(() => {}, join(dir, 'nope.js'), true).decide(origin);
    expect(missing.serve).toBe(false);
    expect((await new LocalBundle(() => {}, path, false).decide(origin)).serve).toBe(false);
});

test('a bundle still being written is not served', async () => {
    const path = join(dir, 'fresh.js');
    writeFileSync(path, 'loginout.p2(289)'); // mtime = now (mid-build)
    expect((await new LocalBundle(() => {}, path, true).decide(origin)).serve).toBe(false);
});
