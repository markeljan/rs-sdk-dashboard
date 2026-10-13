// A clock that keeps running while the tab is in the background.
//
// Chrome clamps a hidden page's setTimeout to one wake per second, and after
// about five minutes of intensive throttling to one per minute. GameShell's
// main loop is a sleep() loop, so a backgrounded client stops draining the
// packet buffer and falls minutes behind: a bot left running in an unfocused
// tab goes stale and its scripts report "Stuck" while nothing moves.
//
// Timers inside a dedicated worker are exempt from that throttling, so the
// worker owns the clock and posts back once each delay elapses. Measured in
// Chrome 146 with the tab hidden: 1.0 page wake/s against 66.4 worker wakes/s,
// where the foreground rate was 66.0.
//
// Falls back to setTimeout wherever a worker can't be created — no Worker or
// Blob constructor, a Content-Security-Policy that forbids blob: workers, or
// the worker failing at runtime.

const WORKER_SOURCE = 'self.onmessage=e=>{setTimeout(()=>self.postMessage(e.data.id),e.data.ms)};';

/** undefined = not tried yet, null = unavailable, Worker = in use. */
let worker: Worker | null | undefined;
let blobUrl: string | null = null;
let nextId: number = 1;

const pending: Map<number, () => void> = new Map();

/** Stop using the worker and let every waiter through, so nothing hangs. */
function abandonWorker(): void {
    worker = null;
    const waiters: (() => void)[] = [...pending.values()];
    pending.clear();
    for (const resolve of waiters) {
        resolve();
    }
}

function getWorker(): Worker | null {
    if (worker !== undefined) {
        return worker;
    }

    worker = null;
    try {
        if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
            return worker;
        }

        blobUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
        const created: Worker = new Worker(blobUrl);

        created.onmessage = (event: MessageEvent): void => {
            // The first reply proves the worker script loaded, so the blob URL
            // has served its purpose and can be released.
            if (blobUrl) {
                URL.revokeObjectURL(blobUrl);
                blobUrl = null;
            }

            const id: number = event.data as number;
            const resolve: (() => void) | undefined = pending.get(id);
            if (resolve) {
                pending.delete(id);
                resolve();
            }
        };

        created.onerror = (): void => {
            created.terminate();
            if (blobUrl) {
                URL.revokeObjectURL(blobUrl);
                blobUrl = null;
            }
            abandonWorker();
        };

        worker = created;
    } catch {
        worker = null;
    }

    return worker;
}

/**
 * Resolve after `ms` milliseconds, at the requested rate even when the tab is
 * in the background. Drop-in replacement for a setTimeout-backed sleep.
 */
export async function delay(ms: number): Promise<void> {
    const timer: Worker | null = getWorker();
    if (!timer) {
        return new Promise<void>((resolve): void => {
            setTimeout(resolve, ms);
        });
    }

    return new Promise<void>((resolve): void => {
        const id: number = nextId++;
        pending.set(id, resolve);
        try {
            timer.postMessage({ id, ms });
        } catch {
            // The worker died between the check and the post.
            pending.delete(id);
            abandonWorker();
            setTimeout(resolve, ms);
        }
    });
}

/** True while the worker clock is driving delays. Exposed for diagnostics. */
export function isWorkerTimerActive(): boolean {
    return getWorker() !== null;
}
