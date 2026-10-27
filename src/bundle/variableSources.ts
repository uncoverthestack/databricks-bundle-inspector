import { isAlias, isMap, isNode, isScalar, isSeq, LineCounter, parseDocument, visit } from "yaml";
import type { Document, Node } from "yaml";
import type { YamlLocation } from "./sourceLocations.js";
import { VARIABLE_SETTINGS } from "./targetResolution.js";

/** Where a bundle variable is set: its top-level definition and each target's override. */
export interface VariableSources {
  definition?: YamlLocation;
  targets: Record<string, YamlLocation>;
}

interface LoadedFile {
  file: string;
  text: string;
}

/** A key's node, for its line when it has no value, and its value's node. */
interface Entry {
  key: Node | null;
  value: Node | null;
}

/** A bare `key:`, whose null value node may sit past the end of its line. */
function isEmpty(node: Node | null): boolean {
  return !node || (isScalar(node) && node.value === null);
}

/** Per anchor name, the nodes that carry it, in file order. */
type Anchors = Map<string, Node[]>;

/** Every anchor in a document, read once: `Alias.resolve` reads the whole document each time. */
export function anchorsOf(doc: Document): Anchors {
  const anchors: Anchors = new Map();
  visit(doc, (_key, node) => {
    if (isNode(node) && node.anchor) {
      const list = anchors.get(node.anchor) ?? [];
      list.push(node);
      anchors.set(node.anchor, list);
    }
  });
  return anchors;
}

/** An alias read as the node it points to: the last node with that anchor before it, as in YAML. */
function resolved(anchors: Anchors, node: unknown): Node | undefined {
  let current = node as Node | null | undefined;
  for (let hops = 0; current && isAlias(current) && hops < 100; hops++) {
    const at = current.range?.[0] ?? Infinity;
    current = anchors.get(current.source)?.filter((n) => (n.range?.[0] ?? Infinity) < at).at(-1);
  }
  return current ?? undefined;
}

/**
 * A mapping's keys and value nodes as the Databricks CLI reads them: `<<` merges
 * first, a later merged map winning over an earlier one, then the mapping's own
 * keys, which win over merged ones wherever they are written. The CLI's acceptance
 * tests yaml_anchors/target_variable_precedence and target_variable_shorthand_alias
 * show both rules. A key YAML reads as null (`~`, `null`) is named as it is written,
 * as the CLI names it (checked on CLI 0.299.0 and 1.21.0).
 */
export function entries(anchors: Anchors, node: unknown, depth = 0): Map<string, Entry> {
  const map = resolved(anchors, node);
  const result = new Map<string, Entry>();
  if (!map || !isMap(map) || depth > 50) return result;
  const own: [string, Entry][] = [];
  for (const pair of map.items) {
    const key = isScalar(pair.key) ? (pair.key.value ?? pair.key.source) : pair.key;
    const value = (pair.value ?? null) as Node | null;
    if (key === "<<") {
      const merged = resolved(anchors, value);
      const sources = merged && isSeq(merged) ? merged.items : [value];
      for (const source of sources) {
        for (const [k, v] of entries(anchors, source, depth + 1)) result.set(k, v);
      }
    } else if (key !== null && key !== undefined) {
      own.push([String(key), { key: pair.key as Node | null, value }]);
    }
  }
  for (const [k, v] of own) result.set(k, v);
  return result;
}

/**
 * The line that sets each variable's value, read from the files the bundle loaded,
 * in the order the CLI loads them: the bundle's databricks.yml, then its `include`
 * files in the CLI's order. A later file wins, as it does for the CLI. A definition
 * points at its `value:`, `default:` or `lookup:`, a target's override at its value;
 * a value taken from an anchor points where the anchor writes it.
 */
export function findVariableSources(files: readonly LoadedFile[]): Record<string, VariableSources> {
  const sources: Record<string, VariableSources> = {};
  const sourcesOf = (name: string) => (sources[name] ??= { targets: {} });

  for (const { file, text } of files) {
    const lineCounter = new LineCounter();
    let doc: Document;
    try {
      // The CLI accepts a repeated key and keeps the last one (acceptance test
      // yaml_duplicate_keys/target_variable_default); so does `entries`.
      doc = parseDocument(text, { lineCounter, uniqueKeys: false });
    } catch {
      continue;
    }
    if (doc.errors.length > 0) continue;
    const anchors = anchorsOf(doc);

    const locate = (node: Node | null | undefined, fallback: Node | null | undefined): YamlLocation | undefined => {
      const offset = node?.range?.[0] ?? fallback?.range?.[0];
      if (typeof offset !== "number") return undefined;
      const { line, col } = lineCounter.linePos(offset);
      return { file, line, column: col };
    };
    /**
     * A variable's value line: its value, default or lookup when it is a mapping of
     * variable settings. A target's mapping with any other key is the value itself.
     */
    const valueOf = ({ key, value }: Entry, isTarget = false) => {
      const fields = entries(anchors, value);
      const fullForm = !isTarget || (fields.size > 0 && [...fields.keys()].every((k) => VARIABLE_SETTINGS.has(k)));
      const field = fullForm ? fields.get("value") ?? fields.get("default") ?? fields.get("lookup") : undefined;
      if (field) return locate(isEmpty(field.value) ? null : field.value, field.key);
      return locate(isEmpty(value) ? null : value, key);
    };

    const root = entries(anchors, doc.contents);
    for (const [name, entry] of entries(anchors, root.get("variables")?.value)) {
      const location = valueOf(entry);
      if (location) sourcesOf(name).definition = location;
    }
    for (const [target, targetEntry] of entries(anchors, root.get("targets")?.value)) {
      for (const [name, entry] of entries(anchors, entries(anchors, targetEntry.value).get("variables")?.value)) {
        const location = valueOf(entry, true);
        if (location) sourcesOf(name).targets[target] = location;
      }
    }
  }
  return sources;
}
