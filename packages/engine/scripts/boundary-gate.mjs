// Engine boundary gate — the shared engine must stay platform-pure.
// Fails if any engine source imports React, state, storage, or platform APIs.
// Complements the tsconfig discipline (no DOM/Node libs) by catching bare
// imports that would otherwise only fail at consumer bundle time.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const FORBIDDEN = [
    /^react(\/|$)/, /^react-dom(\/|$)/, /^zustand(\/|$)/,
    /^@capacitor(-community)?\//, /^idb-keyval$/, /^better-sqlite3$/,
    /^express(\/|$)/, /^node:/,
];

function walk(dir, files = []) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, files);
        else if (/\.ts$/.test(entry) && !entry.endsWith('.d.ts')) files.push(full);
    }
    return files;
}

const violations = [];
for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf8');
    const importRe = /(?:import|export)\s[^'"]*['"]([^'"]+)['"]/g;
    let m;
    while ((m = importRe.exec(text)) !== null) {
        const spec = m[1];
        if (spec.startsWith('.')) continue; // relative imports are fine
        if (FORBIDDEN.some(re => re.test(spec))) {
            violations.push(`${file.slice(SRC.length + 1)} imports "${spec}"`);
        }
    }
}

if (violations.length > 0) {
    console.error('ENGINE BOUNDARY GATE FAILED:');
    for (const v of violations) console.error('  ' + v);
    process.exit(1);
}
console.log('Engine boundary gate: OK (no platform imports in src/)');
