// build-bot-bundle.ts - rebuild this fork's bot client bundle (server/webclient/out/bot/client.js) that the dashboard
// serves to managed clients (see local-bundle.ts), and compare its revision with the game host's.
// Usage: bun tools/dashboard/build-bot-bundle.ts [--check] [--origin https://rs-sdk-demo.fly.dev]
//   --check  only print local/source/host revisions (exit 1 when the local bundle would not be served)
import { existsSync, readFileSync } from 'fs';
import { buildBotBundle, bundleRevision, LOCAL_BUNDLE_PATH, LocalBundle, sourceRevision } from './local-bundle';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const origin = arg('--origin') ?? 'https://rs-sdk-demo.fly.dev';
const localRev = () => existsSync(LOCAL_BUNDLE_PATH) ? bundleRevision(readFileSync(LOCAL_BUNDLE_PATH, 'utf8')) : null;
const hostRev = await new LocalBundle(() => {}).hostRevision(origin);
console.log(`host ${origin}: rev ${hostRev ?? '?'} | fork source: rev ${sourceRevision() ?? '?'} | local bundle: rev ${localRev() ?? 'missing'}`);
if (process.argv.includes('--check')) process.exit(hostRev != null && localRev() === hostRev ? 0 : 1);
if (!await buildBotBundle()) { console.error('build failed'); process.exit(1); }
const rev = localRev();
console.log(`built ${LOCAL_BUNDLE_PATH}: rev ${rev}${hostRev != null && rev !== hostRev ? ` - WARNING host is rev ${hostRev}, the dashboard will NOT serve it` : ''}`);
