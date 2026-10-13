#!/usr/bin/env bun
// rs-dashboard CLI
//
//   rs-dashboard                     start the dashboard (same as `start`)
//   rs-dashboard add <name> <password> [--server host] [--client]
//   rs-dashboard import <path>       a bot.env file, an accounts.json, or an rs-sdk checkout (all bots/*/bot.env)
//   rs-dashboard list                accounts in the local dashboard
//   rs-dashboard remove <name>
//   rs-dashboard skill               print the agent skill (dashboard URL + a fresh API token built in)
//
// Settings are environment variables (see .env.example). Local data lives in ~/.rs-dashboard (RSD_DATA_DIR).
// The dashboard you see is tools/dashboard (synced from rs-sdk); app/ runs one copy per user behind a front server.
import { existsSync, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config';
import { loadKey, makeToken } from './crypto';
import { Store } from './db';
import { parseBotEnv, readAccountsFile, scanRsSdk } from './importers';
import { startServer } from './server';
import { skillMarkdown } from './skill';

const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith('-') ? args.shift()! : 'start';
const flag = (n: string) => { const i = args.indexOf(`--${n}`); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, v && !v.startsWith('--') ? 2 : 1); return v && !v.startsWith('--') ? v : 'true'; };
const cfg = loadConfig();

function localStore() {
    if (cfg.mode !== 'local') { console.error('This command manages the local dashboard (RSD_MODE=local).'); process.exit(1); }
    const store = new Store(cfg.dataDir, loadKey(cfg.dataDir, cfg.secret));
    return { store, user: store.ensureLocalUser() };
}

switch (cmd) {
    case 'start': {
        const { server } = startServer(cfg);
        const urls = [`http://localhost:${server.port}`];
        if (!existsSync(join(import.meta.dir, '..', 'tools', 'dashboard', 'server.ts'))) console.error('tools/dashboard is missing - run: bun scripts/sync-from-rs-sdk.ts <rs-sdk checkout>');
        // LAN addresses for phones on the same Wi-Fi; skip virtual adapters (VMs, Docker, VPN tunnels)
        for (const [ifname, list] of Object.entries(networkInterfaces())) {
            if (/^(bridge|vmnet|utun|docker|veth|br-|vboxnet|llw|awdl)/.test(ifname)) continue;
            for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) urls.push(`http://${i.address}:${server.port}`);
        }
        console.log(`\n  RS-SDK Dashboard (${cfg.mode} mode) - data in ${cfg.dataDir}`);
        console.log(`  Agent setup: open ${cfg.publicUrl || urls[0]}/_rsd/manage and copy the agent skill${cfg.mode === 'local' ? ' (or: bun app/cli.ts skill)' : ''}`);
        console.log(`  This computer:  ${urls[0]}`);
        for (const u of urls.slice(1)) console.log(`  Phone (same Wi-Fi): ${u}`);
        if (cfg.mode === 'local' && !cfg.localPassword) console.log('  No RSD_PASSWORD set: anyone on your network who can reach this port can use it.');
        console.log('');
        break;
    }
    case 'add': {
        const server = flag('server') ?? cfg.defaultServer, client = !!flag('client');
        const [name, password] = args;
        if (!name || !password) { console.error('usage: rs-dashboard add <name> <password> [--server host] [--client]'); process.exit(1); }
        const { store, user } = localStore();
        store.upsertAccount(user.id, { name, password, server, runClient: client, source: 'ui' });
        console.log(`added ${name} @ ${server}${client ? ' (game client runs on the dashboard)' : ''}`);
        break;
    }
    case 'import': {
        const path = args[0];
        if (!path || !existsSync(path)) { console.error('usage: rs-dashboard import <bot.env | accounts.json | rs-sdk dir>'); process.exit(1); }
        const { store, user } = localStore();
        const found = statSync(path).isDirectory()
            ? scanRsSdk(path, cfg.defaultServer).map(a => ({ ...a, source: 'rs-sdk' as const }))
            : path.endsWith('.json') ? readAccountsFile(path, cfg.defaultServer).map(a => ({ ...a, source: 'file' as const }))
            : [parseBotEnv(await Bun.file(path).text(), cfg.defaultServer)].filter(a => !!a).map(a => ({ ...a!, source: 'ui' as const }));
        for (const a of found) store.upsertAccount(user.id, { name: a.name, password: a.password, server: a.server, runClient: a.runClient, source: a.source, botDir: a.botDir ?? null });
        console.log(found.length ? `imported ${found.length}: ${found.map(a => a.name).join(', ')}` : 'no accounts found');
        if (statSync(path).isDirectory() && !existsSync(join(path, 'bots'))) console.log('(expected an rs-sdk checkout with a bots/ directory)');
        break;
    }
    case 'list': {
        const { store, user } = localStore();
        for (const a of store.listAccounts(user.id)) console.log(`${a.name.padEnd(13)} ${a.server.padEnd(24)} ${a.runClient ? 'client' : 'observe'}  (${a.source})`);
        break;
    }
    case 'remove': {
        const { store, user } = localStore();
        const a = args[0] ? store.findAccount(user.id, args[0]) : null;
        if (!a) { console.error('no such account'); process.exit(1); }
        store.deleteAccount(a.id);
        console.log(`removed ${a.name}`);
        break;
    }
    case 'skill': {
        const { user } = localStore();
        const origin = cfg.publicUrl || `http://localhost:${cfg.port}`;
        console.log(skillMarkdown(origin, makeToken(loadKey(cfg.dataDir, cfg.secret), user.id), 'local'));
        break;
    }
    default:
        console.error(`unknown command ${cmd}. Commands: start, add, import, list, remove, skill`);
        process.exit(1);
}
