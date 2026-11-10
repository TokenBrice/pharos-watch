/**
 * Compiled glob matchers for the executable-test project patterns.
 *
 * `path.matchesGlob` builds a minimatch parse for every call, and executable-test
 * validation asks one pattern set about every candidate file: a full-universe
 * selection spent ~5 s per pass in `regExpEscape`. The constant project patterns
 * are compiled once here instead. `matchesGlob` stays the authority — the owning
 * suite compares both over the real candidate universe, and every pattern this
 * compiler does not model is delegated to `matchesGlob` rather than escaped.
 */
import { matchesGlob } from "node:path";

function escapeRegexCharacter(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/** An alternative this compiler reproduces literally (no nested pattern syntax). */
const LITERAL_GLOB_ALTERNATIVE = /^[A-Za-z0-9._-]+$/;

/**
 * Whether every token in `pattern` is one `compileGlobMatcher` models: `**`,
 * `*`, `?`, `?(a|b)`, `{a,b}` and `[abc]` with literal alternatives. Extglobs
 * `+(`, `!(`, `@(`, `*(`, negated character classes, nested braces and
 * backslash escapes are left to `matchesGlob`, because escaping them literally
 * would silently drop matching files from the test universe.
 */
function isCompilableGlob(pattern: string): boolean {
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "\\") return false;
    if (character === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end < 0 || !LITERAL_GLOB_ALTERNATIVE.test(pattern.slice(index + 1, end))) return false;
      index = end;
    } else if (character === "{") {
      const end = pattern.indexOf("}", index + 1);
      if (end < 0 || !pattern.slice(index + 1, end).split(",").every((part) => LITERAL_GLOB_ALTERNATIVE.test(part))) return false;
      index = end;
    } else if (character === "?" && pattern[index + 1] === "(") {
      const end = pattern.indexOf(")", index + 2);
      if (end < 0 || !pattern.slice(index + 2, end).split("|").every((part) => LITERAL_GLOB_ALTERNATIVE.test(part))) return false;
      index = end;
    } else if ("+!@*".includes(character) && pattern[index + 1] === "(") {
      return false;
    }
  }
  return true;
}

/**
 * Compile a `path.matchesGlob` pattern once. Supports the syntax the executable
 * project patterns use (`**`, `*`, `?`, `{a,b}`, `[abc]`, the `?(a|b)` extglob)
 * and delegates every other pattern to `matchesGlob` itself, so no pattern can
 * silently select fewer files than the authority (the owning test compares
 * both over the real candidate universe).
 */
export function compileGlobMatcher(pattern: string): (file: string) => boolean {
  if (!isCompilableGlob(pattern)) return (file: string) => matchesGlob(file, pattern);
  let source = "^";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          source += "(?:[^/]+/)*";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      if (pattern[index + 1] === "(") {
        const end = pattern.indexOf(")", index + 2);
        if (end < 0) {
          source += "[^/]";
          continue;
        }
        const alternatives = pattern.slice(index + 2, end).split("|").map(escapeRegexCharacter);
        source += `(?:${alternatives.join("|")})?`;
        index = end;
      } else {
        source += "[^/]";
      }
    } else if (character === "{") {
      const end = pattern.indexOf("}", index + 1);
      if (end < 0) {
        source += "\\{";
        continue;
      }
      const alternatives = pattern.slice(index + 1, end).split(",").map(escapeRegexCharacter);
      source += `(?:${alternatives.join("|")})`;
      index = end;
    } else if (character === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end < 0) {
        source += "\\[";
        continue;
      }
      source += pattern.slice(index, end + 1);
      index = end;
    } else {
      source += escapeRegexCharacter(character);
    }
  }
  // eslint-disable-next-line security/detect-non-literal-regexp -- built from the constant project glob patterns
  const regex = new RegExp(`${source}$`);
  return (file: string) => regex.test(file);
}

const cachedGlobMatchers = new Map<string, (file: string) => boolean>();

/** Compile each distinct pattern at most once per process. */
export function cachedGlobMatcher(pattern: string): (file: string) => boolean {
  let matcher = cachedGlobMatchers.get(pattern);
  if (!matcher) cachedGlobMatchers.set(pattern, matcher = compileGlobMatcher(pattern));
  return matcher;
}
