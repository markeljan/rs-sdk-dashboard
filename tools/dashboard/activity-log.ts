import { lstatSync, readdirSync, realpathSync, statSync } from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';

export type AccountActivityLog = {
    path: string;
    file: string;
    mtime: number;
};

function inside(parent: string, child: string): boolean {
    const rel = relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function realAccountDirectory(candidate: string, botDirReal: string): string | null {
    try {
        const lexical = resolve(candidate);
        const entry = lstatSync(lexical);
        if (!entry.isDirectory() || entry.isSymbolicLink()) return null;
        const real = realpathSync(lexical);
        if (!inside(botDirReal, real)) return null;
        return real;
    } catch {
        return null;
    }
}

/** Finds the newest direct account log in the configured root or its telemetry child.
 * Symlinks and paths outside the exact account directory are never followed. */
export function latestAccountActivityLog(logDir: string, botDir: string): AccountActivityLog | null {
    let botDirReal: string;
    try {
        const lexicalBotDir = resolve(botDir);
        const botEntry = lstatSync(lexicalBotDir);
        if (!botEntry.isDirectory() || botEntry.isSymbolicLink()) return null;
        botDirReal = realpathSync(lexicalBotDir);
    } catch {
        return null;
    }

    const lexicalLogDir = resolve(logDir);
    const rootLogDir = realAccountDirectory(lexicalLogDir, botDirReal);
    if (!rootLogDir) return null;
    const dirs = [rootLogDir, join(rootLogDir, 'telemetry')];
    const seen = new Set<string>();
    let newest: AccountActivityLog | null = null;
    for (const candidate of dirs) {
        const dir = realAccountDirectory(candidate, botDirReal);
        if (!dir || seen.has(dir)) continue;
        seen.add(dir);
        try {
            for (const name of readdirSync(dir)) {
                if (!name.endsWith('.log')) continue;
                const path = join(dir, name);
                const entry = lstatSync(path);
                if (!entry.isFile() || entry.isSymbolicLink()) continue;
                const real = realpathSync(path);
                if (!inside(botDirReal, real)) continue;
                const mtime = statSync(real).mtimeMs;
                const file = relative(rootLogDir, real);
                if (!newest || mtime > newest.mtime || (mtime === newest.mtime && file < newest.file)) {
                    newest = { path: real, file, mtime };
                }
            }
        } catch {
            // A disappearing log or directory is equivalent to no candidate in that directory.
        }
    }
    return newest;
}
