#!/usr/bin/env bun
// rs-dashboard CLI
//
//   rs-dashboard                     start the dashboard (same as `start`)
//   rs-dashboard add <name> <password> [--server host] [--client]
//   rs-dashboard import <path>       a bot.env file, an accounts.json, or an rs-sdk checkout (all bots/*/bot.env)
//   rs-dashboard list                accounts in the local dashboard
//   rs-dashboard remove <name>
//   rs-dashboard token [name]        create an API token for agents/scripts
//
// Settings are environment variables (see .env.example). Local data lives in ~/.rs-dashboard (RSD_DATA_DIR).
import { existsSync, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config';
import { loadKey } from './crypto';
import { Store } from './db';
import { parseBotEnv, readAccountsFile, scanRsSdk } from './importers';
import { startServer } from './server';

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
        for (const list of Object.values(networkInterfaces())) for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) urls.push(`http://${i.address}:${server.port}`);
        console.log(`\n  RS-SDK Dashboard (${cfg.mode} mode) - data in ${cfg.dataDir}`);
        for (const u of urls) console.log(`  ${u}`);
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
    case 'token': {
        const { store, user } = localStore();
        console.log(store.createApiToken(user.id, args[0] ?? 'cli'));
        break;
    }
    default:
        console.error(`unknown command ${cmd}. Commands: start, add, import, list, remove, token`);
        process.exit(1);
}
