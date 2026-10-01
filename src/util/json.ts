/**
 * Tolerant extraction of the JSON a model returned (spec §5.2 `edge_broken_json`): strip `<thinking>` blocks, take the content of
 * `<final_answer>`, unwrap code fences, ignore prose around the JSON, repair trailing commas / raw newlines inside strings.
 * Returns data only; schema validation is the caller's job (providers/structured.ts).
 */

export type ParsedModelJson = { ok: true; value: unknown; jsonText: string } | { ok: false; error: string };

/** Content of the last `<final_answer>…</final_answer>` (closing tag optional), or null. */
export function extractFinalAnswer(raw: string): string | null {
  const open = raw.lastIndexOf('<final_answer>');
  if (open === -1) return null;
  const from = open + '<final_answer>'.length;
  const close = raw.indexOf('</final_answer>', from);
  return (close === -1 ? raw.slice(from) : raw.slice(from, close)).trim();
}

export function stripThinking(raw: string): string {
  return raw.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').replace(/<thinking>[\s\S]*$/i, '');
}

/** Candidate JSON substrings, most specific first. */
function candidates(raw: string): string[] {
  const out: string[] = [];
  const fa = extractFinalAnswer(raw);
  const body = stripThinking(fa ?? raw).replace(/^﻿/, '').trim();
  if (fa !== null) out.push(fa.trim());

  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g;
  for (let m = fence.exec(body); m; m = fence.exec(body)) if (m[1]) out.push(m[1].trim());

  out.push(body);
  // balanced scans from each `{` / `[`
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '{' || c === '[') {
      const end = scanBalanced(body, i);
      if (end !== -1) out.push(body.slice(i, end + 1));
    }
  }
  return out.filter((c, i, a) => c !== '' && a.indexOf(c) === i);
}

/** Index of the bracket closing the one at `start`, respecting JSON strings; -1 if unbalanced. */
function scanBalanced(s: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** Light, conservative repairs: trailing commas, raw control characters inside strings. */
export function repairJson(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (inString) {
      if (c === '\\') {
        out += c + (text[i + 1] ?? '');
        i++;
      } else if (c === '"') {
        inString = false;
        out += c;
      } else if (c === '\n') out += '\\n';
      else if (c === '\r') out += '\\r';
      else if (c === '\t') out += '\\t';
      else out += c;
      continue;
    }
    if (c === '"') inString = true;
    out += c;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

export function parseModelJson(raw: string): ParsedModelJson {
  let lastError = 'no JSON object or array found in the response';
  for (const cand of candidates(raw)) {
    for (const attempt of [cand, repairJson(cand)]) {
      try {
        const value: unknown = JSON.parse(attempt);
        if (value !== null && typeof value === 'object') return { ok: true, value, jsonText: attempt };
        lastError = 'response JSON is not an object or array';
      } catch (e) {
        lastError = (e as Error).message;
      }
    }
  }
  return { ok: false, error: lastError };
}
