/**
 * Compiled rule patterns, cached per (source, flags). Patterns come from the frozen config, so the cache is bounded; `matchAll`
 * clones before executing, so sharing one compiled RegExp is safe.
 */
import { EngineError } from '../util/errors.js';
import { compilePattern } from '../util/regex.js';

const cache = new Map<string, RegExp>();

/** `compilePattern` with the rule-file dialect; an invalid pattern is a configuration error, not an input error. */
export function rulePattern(source: string, flags?: string): RegExp {
  const key = `${flags ?? '(default)'}\u0000${source}`;
  let re = cache.get(key);
  if (!re) {
    try {
      re = compilePattern(source, flags);
    } catch (e) {
      throw new EngineError('CONFIG_INVALID', (e as Error).message, { pattern: source });
    }
    cache.set(key, re);
  }
  return re;
}

/** Same pattern anchored at `lastIndex` (for "a match starting exactly here"). */
export function stickyPattern(source: string, flags?: string): RegExp {
  const re = rulePattern(source, flags);
  return new RegExp(re.source, `${re.flags.replace('g', '')}y`);
}

/** `$1`…`$9` in a replacement template, filled from the match groups (missing groups become empty). */
export function expandTemplate(template: string, groups: readonly string[]): string {
  return template.replace(/\$(\d)/g, (_, d: string) => groups[Number(d) - 1] ?? '');
}
