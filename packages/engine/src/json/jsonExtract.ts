/**
 * Shared JSON extraction for LLM responses — merge of the two shells' versions
 * (Monorepo WO-04):
 *   - desktop contributed: array-root support, candidate-based truncation
 *     recovery, repairJson (trailing commas, comments, single quotes).
 *   - mobile contributed: stripUnclosedThinkTag (reasoning models that never
 *     close their <think> block).
 *   - new here: extractJson only repairs text that does NOT already parse, so
 *     valid JSON passes through byte-identical (the old unconditional repair
 *     could corrupt "//" sequences inside string values, e.g. URLs).
 *
 * Returns { value, parseOk }:
 *   - parseOk: true  → parsed successfully (possibly via truncation recovery)
 *   - parseOk: false → unrecoverable; value is the caller-supplied fallback
 */

function stripUnclosedThinkTag(text: string): string {
    const thinkIdx = text.search(/<think\b/i);
    if (thinkIdx === -1) return text;
    const jsonStart = text.indexOf('{', thinkIdx);
    const arrStart = text.indexOf('[', thinkIdx);
    let nextJson = -1;
    if (jsonStart !== -1 && arrStart !== -1) nextJson = Math.min(jsonStart, arrStart);
    else if (jsonStart !== -1) nextJson = jsonStart;
    else if (arrStart !== -1) nextJson = arrStart;
    if (nextJson === -1) return '';
    return text.slice(0, thinkIdx) + text.slice(nextJson);
}

export function extractJsonRobust<T>(raw: string, fallback: T): { value: T; parseOk: boolean } {
    let clean = raw.replace(/<think[\s\S]*?<\/think\s*>/gi, '');
    clean = stripUnclosedThinkTag(clean);
    const mdMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (mdMatch) clean = mdMatch[1];

    const openBrace = clean.indexOf('{');
    const openBracket = clean.indexOf('[');

    let start: number;
    if (openBrace === -1 && openBracket === -1) {
        return { value: fallback, parseOk: false };
    } else if (openBrace === -1) {
        start = openBracket;
    } else if (openBracket === -1) {
        start = openBrace;
    } else {
        const isArray = openBracket < openBrace;
        start = isArray ? openBracket : openBrace;
    }

    const text = clean.slice(start);

    try {
        return { value: JSON.parse(text) as T, parseOk: true };
    } catch {
        // Truncated response — attempt recovery.
        let depth = 0;
        let inString = false;
        let escape = false;
        const candidates: { pos: number; depth: number }[] = [];
        let rootClosedAt = -1;

        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (escape) { escape = false; continue; }
            if (ch === '\\' && inString) { escape = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (ch === '{' || ch === '[') depth++;
            if (ch === '}' || ch === ']') {
                depth--;
                if (depth === 0) {
                    rootClosedAt = i;
                    break;
                }
                candidates.push({ pos: i, depth });
            }
            if (ch === ',' && depth === 1) {
                candidates.push({ pos: i - 1, depth });
            }
        }

        // Try 1: root-closed prefix is self-contained valid JSON
        if (rootClosedAt > 0) {
            try {
                return { value: JSON.parse(text.slice(0, rootClosedAt + 1)) as T, parseOk: true };
            } catch { /* fall through */ }
        }

        // Try 2: each candidate — truncate + close remaining open brackets
        for (let ci = candidates.length - 1; ci >= 0; ci--) {
            const { pos } = candidates[ci];
            // Re-scan the prefix to build the exact close sequence for every
            // bracket still open at this candidate position.
            const openBrackets: string[] = [];
            let inStr = false;
            let esc = false;
            for (let j = 0; j <= pos; j++) {
                const c = text[j];
                if (esc) { esc = false; continue; }
                if (c === '\\' && inStr) { esc = true; continue; }
                if (c === '"') { inStr = !inStr; continue; }
                if (inStr) continue;
                if (c === '{' || c === '[') openBrackets.push(c);
                if (c === '}' || c === ']') openBrackets.pop();
            }
            const closeStr = openBrackets.reverse().map(b => b === '{' ? '}' : ']').join('');
            const recovered = text.slice(0, pos + 1) + closeStr;
            try {
                return { value: JSON.parse(recovered) as T, parseOk: true };
            } catch { /* try next candidate */ }
        }

        return { value: fallback, parseOk: false };
    }
}

/**
 * Best-effort repair of near-JSON: trailing commas, // and block comments,
 * single-quoted values, raw control characters inside strings, "}{" fusion.
 * Only called on text that already failed JSON.parse — never on valid JSON.
 */
function repairJson(str: string): string {
    let r = str;

    r = r.replace(/,\s*([}\]])/g, '$1');

    r = r.replace(/\/\/[^\n]*/g, '');

    r = r.replace(/\/\*[\s\S]*?\*\//g, '');

    r = r.replace(
        /"([^"\\]*(\\.[^"\\]*)*)"\s*:/g,
        (match) => match
    );

    r = r.replace(/:\s*'"([^']*)'([,}\]])/g, ': "$1"$2');
    r = r.replace(/:\s*'([^']*)'([,}\]])/g, ': "$1"$2');
    r = r.replace(/\[\s*'/g, '["');
    r = r.replace(/'\s*,\s*'/g, '", "');
    r = r.replace(/'\s*]/g, '"]');
    r = r.replace(/"\s*:\s*'([^']*(?:\\.[^']*)*)'\s*([,}\]])/g, '"$1"$2');

    let inString = false;
    let escaped = false;
    let result = '';
    for (let i = 0; i < r.length; i++) {
        const ch = r[i];
        if (escaped) {
            result += ch;
            escaped = false;
            continue;
        }
        if (ch === '\\' && inString) {
            result += ch;
            escaped = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            result += ch;
            continue;
        }
        if (inString) {
            if (ch === '\n') { result += '\\n'; continue; }
            if (ch === '\r') { result += '\\r'; continue; }
            if (ch === '\t') { result += '\\t'; continue; }
            if (ch === '\x00') { continue; }
        }
        result += ch;
    }
    r = result;

    r = r.replace(/\}\s*\{/g, '},{');

    return r.trim();
}

/** Return `text` untouched if it already parses; otherwise run repairJson. */
function repairIfBroken(text: string): string {
    const trimmed = text.trim();
    if (trimmed.length === 0) return trimmed;
    try {
        JSON.parse(trimmed);
        return trimmed;
    } catch {
        return repairJson(trimmed);
    }
}

/**
 * Robustly extracts the first JSON object or array found in a text string.
 * Handles <think> tags (closed or unclosed), markdown code blocks, and
 * leading/trailing chatter. Broken-but-close JSON is repaired.
 */
export function extractJson(text: string): string {
    let clean = text.replace(/<think[\s\S]*?<\/think\s*>/gi, '');
    clean = stripUnclosedThinkTag(clean);

    const markdownMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (markdownMatch) {
        clean = markdownMatch[1];
    }

    const firstObj = clean.indexOf('{');
    const firstArr = clean.indexOf('[');
    const start = (firstObj !== -1 && (firstArr === -1 || firstObj < firstArr)) ? firstObj : firstArr;

    if (start !== -1) {
        const lastObj = clean.lastIndexOf('}');
        const lastArr = clean.lastIndexOf(']');
        const end = (lastObj !== -1 && (lastArr === -1 || lastObj > lastArr)) ? lastObj : lastArr;

        if (end !== -1 && end > start) {
            return repairIfBroken(clean.substring(start, end + 1));
        }
    }

    return repairIfBroken(clean);
}
