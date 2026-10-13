// "Current activity" for the dashboard, built from what is actually running instead of trusting a
// hand-written tasks.json that goes stale. Priority:
//   1. a running quest loop (questloop.sh args + quests-run.log + quests-live.json) -> live quest queue
//   2. tasks.json `current`, only while it is fresh (written recently, or newer than the activity log)
//   3. the running script's name + the latest log line
//   4. "idle" when no bot script is running
import { basename } from 'node:path';
import type { QuestRunState } from './quests-api';

export type ActivityTask = { title: string; status: string };
export type ActivityProc = { kind: string; stopped: boolean; cmd: string; script: string };
export type ActivityTasksFile = { goal?: string; current?: string; tasks?: ActivityTask[]; updatedAt?: string; updated?: string };
export type LiveQuest = { key: string; name: string; status: string };

/** tasks.json `current` older than this (and older than the newest log line) is treated as stale. */
export const TASKS_FRESH_MS = 30 * 60_000;

export function tasksWrittenAt(tasks: ActivityTasksFile | null, mtimeMs: number | null): number | null {
    const stamps = [mtimeMs, Date.parse(String(tasks?.updatedAt ?? tasks?.updated ?? ''))].filter((t): t is number => Number.isFinite(t));
    return stamps.length ? Math.max(...stamps) : null;
}

/** Arguments after the script path, e.g. `bun tools/quests/run.ts sokobot crest` -> ['sokobot', 'crest']. */
export function scriptArgs(proc: ActivityProc): string[] {
    const tokens = proc.cmd.trim().split(/\s+/);
    const name = basename(proc.script);
    const at = tokens.findIndex(t => basename(t) === name);
    return at < 0 ? [] : tokens.slice(at + 1);
}

/** Short human label for the account's running automation: the leaf script, not the supervisor wrapper. */
export function runningLabel(procs: ActivityProc[], account: string): string | null {
    const live = procs.filter(p => !p.stopped);
    const pick = live.find(p => p.kind === 'script') ?? live[0];
    if (!pick) return null;
    const args = scriptArgs(pick).filter(a => a !== account && !a.startsWith('-')).slice(0, 2);
    return [basename(pick.script).replace(/\.(ts|sh|js|mjs)$/, ''), ...args].join(' ');
}

export function questLoopQueue(procs: ActivityProc[]): string[] | null {
    const loop = procs.find(p => /(^|\/)questloop\.sh$/.test(p.script));
    return loop ? scriptArgs(loop).filter(a => !a.startsWith('script:')) : null;
}

export function questLoopTasks(queue: string[], run: QuestRunState, live: LiveQuest[]): { tasks: ActivityTask[]; current: string } {
    const byKey = new Map(live.map(q => [q.key, q]));
    const lastResult = new Map<string, boolean>();
    for (const r of [...run.results].reverse()) lastResult.set(r.key, r.ok); // results are newest-first
    const curKey = run.current?.key ?? null;
    const keys = [...new Set(curKey && !queue.includes(curKey) ? [curKey, ...queue] : queue)];
    const tasks = keys.map(key => {
        const q = byKey.get(key);
        const status = key === curKey ? 'current'
            : q?.status === 'complete' || lastResult.get(key) === true ? 'done'
            : lastResult.get(key) === false ? 'blocked' : 'upcoming';
        return { title: q?.name ?? key, status };
    });
    const done = tasks.filter(t => t.status === 'done').length;
    const curName = curKey ? (byKey.get(curKey)?.name ?? curKey) : null;
    const current = curName ? `Quest loop: ${curName} (${done}/${tasks.length} of queue done)` : `Quest loop: between quests (${done}/${tasks.length} of queue done)`;
    return { tasks, current };
}

/** `[8:24 PM] [thief] bank (low food)` -> { tag: 'thief', text: 'bank (low food)' }; timestamps are dropped. */
export function splitLogLine(line: string | null): { tag: string | null; text: string | null } {
    let rest = (line ?? '').trim();
    let tag: string | null = null;
    for (let m = rest.match(/^\[([^\]]*)\]\s*/); m; m = rest.match(/^\[([^\]]*)\]\s*/)) {
        if (!/^[\d:.\sTZ/-]+(AM|PM)?$/i.test(m[1]!)) tag = m[1]!;
        rest = rest.slice(m[0].length);
    }
    return { tag, text: rest || null };
}

export function summarizeActivity(opts: {
    account: string;
    now: number;
    tasks: ActivityTasksFile | null;
    tasksMtime: number | null;
    procs: ActivityProc[];
    lastLogLine: string | null;
    logMtime: number | null;
    questRun?: QuestRunState | null;
    liveQuests?: LiveQuest[];
    questPoints?: { done: number; total: number; qp: number; totalQp: number } | null;
}) {
    const { tasks, procs } = opts;
    const running = runningLabel(procs, opts.account);
    const writtenAt = tasksWrittenAt(tasks, opts.tasksMtime);
    const tasksFresh = writtenAt != null && (opts.now - writtenAt < TASKS_FRESH_MS || (opts.logMtime != null && writtenAt >= opts.logMtime - 5 * 60_000));
    const { tag, text: lastLine } = splitLogLine(opts.lastLogLine);

    const queue = questLoopQueue(procs);
    if (queue && opts.questRun) {
        const q = questLoopTasks(queue, opts.questRun, opts.liveQuests ?? []);
        const qp = opts.questPoints ? ` · ${opts.questPoints.done}/${opts.questPoints.total} quests, ${opts.questPoints.qp}/${opts.questPoints.totalQp} QP` : '';
        return { goal: tasks?.goal ?? 'Quests', current: q.current + qp, tasks: q.tasks, running, source: 'quest-loop' as const, tasksUpdatedAt: opts.now, stale: false };
    }
    const base = { goal: tasks?.goal ?? '', tasks: tasks?.tasks ?? [], running, tasksUpdatedAt: writtenAt, stale: !!tasks && !tasksFresh };
    if (!running) return { ...base, current: `Idle - no bot script running${lastLine ? ` (last: ${lastLine})` : ''}`, source: 'idle' as const };
    if (tasks?.current && tasksFresh) return { ...base, current: tasks.current, source: 'tasks' as const };
    const label = tag && !running.split(' ').includes(tag) ? `${running} · ${tag}` : running;
    return { ...base, current: lastLine ? `${label}: ${lastLine}` : label, source: 'process' as const };
}
