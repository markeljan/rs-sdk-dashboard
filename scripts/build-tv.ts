// Pin the spectator renderer and keep our TV layer reviewable, separate from upstream.
// bun scripts/build-tv.ts [--source /path/to/rs-world]
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dir, '..');
const revision = '7e4c9f711ba2f5a1f8e354c6083b8a471530383b';
const sourceArg = process.argv.indexOf('--source');
const source = sourceArg >= 0 ? resolve(process.argv[sourceArg + 1]!) : join(root, '.tv-cache', 'renderer');
async function run(cmd: string[], env: Record<string, string> = {}) {
    const child = Bun.spawn(cmd, { cwd: source, env: { ...process.env, ...env }, stdout: 'inherit', stderr: 'inherit' });
    if (await child.exited !== 0) throw new Error(`Failed: ${cmd.join(' ')}`);
}
if (!existsSync(source)) {
    mkdirSync(source, { recursive: true });
    await run(['git', 'init']);
    await run(['git', 'remote', 'add', 'origin', 'https://github.com/MaxBittker/rs-world.git']);
    await run(['git', 'fetch', '--depth', '1', 'origin', revision]);
    await run(['git', 'checkout', '--detach', 'FETCH_HEAD']);
}
const actual = (await new Response(Bun.spawn(['git', 'rev-parse', 'HEAD'], { cwd: source, stdout: 'pipe' }).stdout).text()).trim();
if (actual !== revision) throw new Error(`Expected renderer ${revision}, got ${actual}`);
for (const name of ['LivePanel.tsx', 'LivePanel.css', 'RankingsPanel.tsx', 'PlayerDetails.tsx', 'ChatPanel.tsx', 'director.ts', 'hiscores.ts']) cpSync(join(root, ['director.ts', 'hiscores.ts'].includes(name) ? 'app/tv' : 'tv', name), join(source, 'src/live', name));
const controller = join(source, 'src/live/LiveController.ts');
const controllerSource = readFileSync(controller, 'utf8');
if (!controllerSource.includes('configured === "TV_RELAY"')) writeFileSync(controller, controllerSource.replace('return configured;', 'return configured === "TV_RELAY" ? `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/worldfeed` : configured;'));
// Manual camera movement (including touch joysticks) leaves the broadcast.
let liveSource = readFileSync(controller, 'utf8');
if (!liveSource.includes('CustomEvent("tv-mode"')) {
    liveSource = liveSource.replace('this.followName = player.name;', 'document.dispatchEvent(new CustomEvent("tv-mode", { detail: "follow" })); this.followName = player.name;');
    liveSource = liveSource.replace('this.followSlot = -1;\n        this.followName = undefined;', 'document.dispatchEvent(new CustomEvent("tv-mode", { detail: "free" })); this.followSlot = -1;\n        this.followName = undefined;');
    writeFileSync(controller, liveSource);
}
const indexPath = join(source, 'public/index.html');
cpSync(join(root, 'tv/index.html'), indexPath);
cpSync(join(root, 'tv/public'), join(source, 'public'), { recursive: true });
const containerPath = join(source, 'src/mapviewer/MapViewerContainer.tsx');
let containerSource = readFileSync(containerPath, 'utf8');
if (!containerSource.includes('CustomEvent("tv-mode"')) {
    containerSource = containerSource.replace('mapViewer.live?.unfollow();', 'document.dispatchEvent(new CustomEvent("tv-mode", { detail: "free" })); mapViewer.live?.unfollow(); mapViewer.camera.pos[1] = -16;');
    containerSource = containerSource.replace('live.goToPlayer(entry[1], mapViewer.camera);', 'document.dispatchEvent(new CustomEvent("tv-mode", { detail: "follow" })); live.goToPlayer(entry[1], mapViewer.camera);');
    writeFileSync(containerPath, containerSource);
}
containerSource = readFileSync(containerPath, 'utf8');
if (!containerSource.includes('"tv-map"')) {
    containerSource = containerSource.replace('const [menuProps,', 'useEffect(() => { const openMap = () => setWorldMapOpen(true); document.addEventListener("tv-map", openMap); return () => document.removeEventListener("tv-map", openMap); }, []);\n    const [menuProps,');
    writeFileSync(containerPath, containerSource);
}
const viewerPath = join(source, 'src/mapviewer/MapViewer.ts');
const viewerSource = readFileSync(viewerPath, 'utf8');
if (!viewerSource.includes('document.body.dataset.tvMode')) writeFileSync(viewerPath, viewerSource.replace('params["v"] = 1;', 'if (document.body.dataset.tvMode === "auto") delete params["follow"]; params["v"] = 1;'));
const rendererPath = join(source, 'src/mapviewer/webgl/WebGLMapViewerRenderer.ts');
writeFileSync(rendererPath, readFileSync(rendererPath, 'utf8').replace('maxLevel: number = Scene.MAX_LEVELS - 1;', 'maxLevel: number = 0;'));
// Reverse just the arrow-key rotations; pointer, joystick and WASD input keep their existing mapping.
const inputPath = join(source, 'src/mapviewer/MapViewerRenderer.ts');
const inputSource = readFileSync(inputPath, 'utf8');
const arrowsMarker = '// TV: RuneScape arrow-key camera directions.';
if (!inputSource.includes(arrowsMarker)) {
    let count = 0;
    const flipped = inputSource.replace(/if \(inputManager\.isKeyDown\("(ArrowUp|ArrowDown|ArrowRight|ArrowLeft)"\)\) \{\s*camera\.(updatePitch|updateYaw)\(camera\.(pitch|yaw), (-?)(deltaPitch|deltaYaw)\);/g,
        (_match, key, method, axis, sign, delta) => { count++; return `if (inputManager.isKeyDown("${key}")) {\n            camera.${method}(camera.${axis}, ${sign ? '' : '-'}${delta});`; });
    if (count !== 4) throw new Error(`Expected four arrow-key controls, found ${count}`);
    writeFileSync(inputPath, arrowsMarker + '\n' + flipped);
}
const controlsPath = join(source, 'src/mapviewer/MapViewerControls.tsx');
writeFileSync(controlsPath, readFileSync(controlsPath, 'utf8').replace('hidden={hidden || isMobileDevice}', 'hidden={true}'));
await run(['bun', 'install', '--ignore-scripts']);
await run(['bun', 'scripts/sync-rs-sdk-cache.ts', '--server', process.env.TV_GAME_SERVER ?? 'https://rs-sdk-demo.fly.dev']);
await run(['bun', 'run', 'build'], { CI: 'false', GENERATE_SOURCEMAP: 'false', REACT_APP_WORLD_FEED_URL: 'TV_RELAY', PUBLIC_URL: '/' });
const out = join(root, 'tv-build');
cpSync(join(source, 'build'), out, { recursive: true });
cpSync(join(source, 'caches'), join(out, 'caches'), { recursive: true });
cpSync(join(source, 'LICENSE'), join(out, 'RENDERER-LICENSE.txt'));
writeFileSync(join(out, 'version.json'), JSON.stringify({ renderer: revision, builtAt: new Date().toISOString() }));
console.log(`TV build ready: ${out}`);
