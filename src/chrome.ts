// Finds a Chrome for the headless game clients: CHROME_PATH, an installed Chrome/Chromium, or a
// chrome-headless-shell downloaded once into the data dir (no manual install needed).
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const CANDIDATES: Record<string, string[]> = {
    darwin: [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ],
    linux: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'],
    win32: [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
};

let pending: Promise<string> | null = null;

export function findChrome(dataDir: string, override = ''): Promise<string> {
    if (override) return Promise.resolve(override);
    for (const c of CANDIDATES[platform()] ?? []) if (existsSync(c)) return Promise.resolve(c);
    pending ??= download(join(dataDir, 'chrome')).catch(e => { pending = null; throw e; });
    return pending;
}

async function download(cacheDir: string): Promise<string> {
    const b = await import('@puppeteer/browsers');
    const browser = b.Browser.CHROMEHEADLESSSHELL;
    const plat = b.detectBrowserPlatform();
    if (!plat) throw new Error('unsupported platform for automatic Chrome download - set CHROME_PATH');
    const buildId = await b.resolveBuildId(browser, plat, 'stable');
    const installed = (await b.getInstalledBrowsers({ cacheDir })).find(i => i.browser === browser && i.buildId === buildId);
    if (installed) return installed.executablePath;
    console.log(`[chrome] no Chrome found - downloading chrome-headless-shell ${buildId} to ${cacheDir} (one time, ~100 MB)`);
    const res = await b.install({ browser, buildId, cacheDir });
    console.log(`[chrome] installed ${res.executablePath}`);
    return res.executablePath;
}
