import { AsyncLocalStorage } from 'node:async_hooks';

/** A scope belongs to one execution, never to the lifetime of a bot connection. */
export interface ExecutionContext {
    signal: AbortSignal;
    log?: (level: 'log' | 'warn' | 'error', args: unknown[]) => void;
}

export const executionContext = new AsyncLocalStorage<ExecutionContext>();

function abortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'Execution cancelled'));
}

export function throwIfExecutionAborted(): void {
    const signal = executionContext.getStore()?.signal;
    if (signal?.aborted) throw abortError(signal);
}

/** Cancel a pending observation/dispatch and release its listeners and timers. */
export function executionWait<T>(
    setup: (resolve: (value: T) => void, reject: (error: unknown) => void) => () => void,
    signal: AbortSignal | undefined = executionContext.getStore()?.signal,
): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        let cleanup: (() => void) | undefined;
        const finish = (complete: () => void) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', abort);
            cleanup?.();
            complete();
        };
        const abort = () => finish(() => reject(abortError(signal!)));
        signal?.addEventListener('abort', abort, { once: true });
        try {
            cleanup = setup(value => finish(() => resolve(value)), error => finish(() => reject(error)));
            if (settled) cleanup();
            else if (signal?.aborted) abort();
        } catch (error) {
            finish(() => reject(error));
        }
    });
}

/** Settle with `promise`, or reject as soon as `signal` aborts. */
export function abortable<T>(promise: Promise<T>, signal = executionContext.getStore()?.signal): Promise<T> {
    promise.catch(() => {}); // nobody awaits a rejection that lands after cancellation
    return executionWait<T>((resolve, reject) => { promise.then(resolve, reject); return () => {}; }, signal);
}

/** Bound a helper's whole route, including nested door attempts and waits. Its own deadline returns onTimeout(); a parent cancellation still throws. */
export async function withExecutionDeadline<T>(timeout: number, work: () => Promise<T>, onTimeout: () => T): Promise<T> {
    throwIfExecutionAborted();
    const parent = executionContext.getStore();
    const controller = new AbortController();
    const timedOut = new Error('Deadline exceeded');
    const abort = () => controller.abort(parent?.signal.reason);
    parent?.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(timedOut), timeout);
    try {
        return await executionContext.run({ ...parent, signal: controller.signal }, () => abortable(work()));
    } catch (error) {
        if (error === timedOut) return onTimeout();
        throw error;
    } finally {
        clearTimeout(timer);
        parent?.signal.removeEventListener('abort', abort);
        if (!controller.signal.aborted) controller.abort(new Error('Action finished'));
    }
}
