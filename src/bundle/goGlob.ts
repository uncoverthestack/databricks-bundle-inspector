import { existsSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";

// The Databricks CLI expands `include` entries with Go's `filepath.Glob`, not with
// .gitignore rules as its documentation says. `*` stays inside one folder, `**` is
// just `*` again, and `{a,b}` is not supported. This mirrors those rules so the
// inspector can tell when an entry matches nothing; a match is checked against the
// real CLI in the tests.

type Term =
  | { kind: "star" }
  | { kind: "any" }
  | { kind: "char"; value: string }
  | { kind: "set"; negated: boolean; ranges: Array<[number, number]> };

/** Whether an `include` entry is a pattern for the CLI. Only these characters make it one. */
export function hasGlobCharacters(entry: string): boolean {
  return /[*?[]/.test(entry);
}

/** The pattern split into terms, or undefined when Go would report a syntax error. */
function parsePattern(pattern: string): Term[] | undefined {
  const chars = Array.from(pattern);
  const terms: Term[] = [];
  let i = 0;

  const readSetCharacter = (): number | undefined => {
    if (i >= chars.length || chars[i] === "-" || chars[i] === "]") return undefined;
    let value = chars[i]!;
    if (value === "\\") {
      i += 1;
      if (i >= chars.length) return undefined;
      value = chars[i]!;
    }
    i += 1;
    // A set must still be closed after this character.
    if (i >= chars.length) return undefined;
    return value.codePointAt(0);
  };

  while (i < chars.length) {
    const char = chars[i]!;
    if (char === "*") {
      terms.push({ kind: "star" });
      i += 1;
    } else if (char === "?") {
      terms.push({ kind: "any" });
      i += 1;
    } else if (char === "\\") {
      i += 1;
      if (i >= chars.length) return undefined;
      terms.push({ kind: "char", value: chars[i]! });
      i += 1;
    } else if (char === "[") {
      i += 1;
      let negated = false;
      if (chars[i] === "^") {
        negated = true;
        i += 1;
      }
      const ranges: Array<[number, number]> = [];
      for (;;) {
        if (chars[i] === "]" && ranges.length > 0) {
          i += 1;
          break;
        }
        const low = readSetCharacter();
        if (low === undefined) return undefined;
        let high = low;
        if (chars[i] === "-") {
          i += 1;
          const end = readSetCharacter();
          if (end === undefined) return undefined;
          high = end;
        }
        ranges.push([low, high]);
      }
      terms.push({ kind: "set", negated, ranges });
    } else {
      terms.push({ kind: "char", value: char });
      i += 1;
    }
  }
  return terms;
}

function termMatches(term: Term, character: string): boolean {
  if (term.kind === "any") return true;
  if (term.kind === "char") return term.value === character;
  if (term.kind === "set") {
    const code = character.codePointAt(0)!;
    const inSet = term.ranges.some(([low, high]) => low <= code && code <= high);
    return inSet !== term.negated;
  }
  return false;
}

/**
 * Whether one file or folder name matches a pattern, the way Go's `filepath.Match`
 * does for a single path segment. Returns undefined for a malformed pattern, which
 * the CLI reports itself.
 */
export function matchGoSegment(pattern: string, name: string): boolean | undefined {
  const terms = parsePattern(pattern);
  if (!terms) return undefined;
  const characters = Array.from(name);

  // reachable[j]: the terms so far can consume exactly the first j characters.
  let reachable = new Array<boolean>(characters.length + 1).fill(false);
  reachable[0] = true;
  for (const term of terms) {
    const next = new Array<boolean>(characters.length + 1).fill(false);
    if (term.kind === "star") {
      let seen = false;
      for (let j = 0; j <= characters.length; j++) {
        seen = seen || reachable[j]!;
        next[j] = seen;
      }
    } else {
      for (let j = 0; j < characters.length; j++) {
        if (reachable[j] && termMatches(term, characters[j]!)) next[j + 1] = true;
      }
    }
    reachable = next;
  }
  return reachable[characters.length]!;
}

/**
 * The files and folders under `root` that an `include` entry selects, as paths
 * relative to `root`. Walks one segment at a time like Go's `filepath.Glob`.
 * Returns undefined when the pattern is malformed.
 */
export function globSync(root: string, entry: string): string[] | undefined {
  const segments = posix.normalize(entry).split("/").filter((segment) => segment !== "" && segment !== ".");
  let folders = [""];

  for (const segment of segments) {
    const next: string[] = [];
    for (const folder of folders) {
      const relative = (name: string) => (folder ? `${folder}/${name}` : name);
      if (!/[*?[\\]/.test(segment)) {
        if (existsSync(join(root, relative(segment)))) next.push(relative(segment));
        continue;
      }
      let names: string[];
      try {
        names = readdirSync(join(root, folder)).sort();
      } catch {
        continue;
      }
      for (const name of names) {
        const matched = matchGoSegment(segment, name);
        if (matched === undefined) return undefined;
        if (matched) next.push(relative(name));
      }
    }
    folders = next;
  }
  return folders;
}
