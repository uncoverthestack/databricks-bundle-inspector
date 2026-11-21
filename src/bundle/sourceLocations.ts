import { isAlias, isMap, isSeq, LineCounter, parseDocument } from "yaml";
import type { Document, Node, YAMLMap } from "yaml";

export interface YamlLocation {
  file: string;
  line: number;
  column: number;
}

export type YamlLocationMap = Map<string, YamlLocation>;

function getNodeOffset(node: Node | null | undefined): number | undefined {
  const range = node?.range;
  return Array.isArray(range) && typeof range[0] === "number"
    ? range[0]
    : undefined;
}

function getLocation(
  filePath: string,
  lineCounter: LineCounter,
  node: Node | null | undefined,
): YamlLocation | undefined {
  const offset = getNodeOffset(node);
  if (offset === undefined) return undefined;
  const { line, col } = lineCounter.linePos(offset);
  return { file: filePath, line, column: col };
}

function childPath(parentPath: string, childKey: string): string {
  return parentPath ? `${parentPath}.${childKey}` : childKey;
}

function itemPath(parentPath: string, index: number): string {
  return `${parentPath}[${index}]`;
}

function scalarValue(node: unknown): string | undefined {
  if (typeof node !== "object" || node === null || !("value" in node)) {
    return undefined;
  }
  const value = (node as { value?: unknown }).value;
  return value === undefined ? undefined : String(value);
}

/** The maps a `<<` merge key brings in, in order: one alias, a list of aliases, or a plain map. */
function mergedMaps(value: unknown, document: Document): YAMLMap[] {
  const resolve = (item: unknown): unknown => (isAlias(item) ? item.resolve(document) : item);
  const items = isSeq(value) ? value.items.map(resolve) : [resolve(value)];
  return items.filter((item): item is YAMLMap => isMap(item));
}

/** What following `<<` merge keys needs, shared by the whole walk. */
interface WalkContext {
  document: Document;
  /** Maps being merged right now, so a merge that leads back to itself stops. */
  merging: Set<YAMLMap>;
}

/**
 * Walks a map's keys under `currentPath`. Keys a `<<` merge key brings in go first, each
 * merged map walked the same way (so an anchor that merges another one is followed), and
 * the keys written in the map last, so they win; in `<<: [*a, *b]` the later map wins. The
 * CLI merges the same way (#467). A merged value's line is where the anchor writes it.
 */
function walkMapEntries(
  map: YAMLMap,
  currentPath: string,
  filePath: string,
  lineCounter: LineCounter,
  locations: YamlLocationMap,
  keyLocations: YamlLocationMap | undefined,
  context: WalkContext | undefined,
): void {
  if (context) {
    for (const item of map.items) {
      if (scalarValue(item.key) !== "<<") continue;
      for (const merged of mergedMaps(item.value, context.document)) {
        if (context.merging.has(merged)) continue;
        context.merging.add(merged);
        walkMapEntries(merged, currentPath, filePath, lineCounter, locations, keyLocations, context);
        context.merging.delete(merged);
      }
    }
  }
  for (const item of map.items) {
    const keyValue = scalarValue(item.key);
    if (!keyValue || (context && keyValue === "<<")) continue;
    const path = childPath(currentPath, keyValue);
    const keyLocation = keyLocations ? getLocation(filePath, lineCounter, item.key as Node) : undefined;
    if (keyLocation) keyLocations!.set(path, keyLocation);
    walkYamlNode(item.value as Node | null | undefined, path, filePath, lineCounter, locations, keyLocations, context);
  }
}

function walkYamlNode(
  node: Node | null | undefined,
  currentPath: string,
  filePath: string,
  lineCounter: LineCounter,
  locations: YamlLocationMap,
  keyLocations?: YamlLocationMap,
  context?: WalkContext,
): void {
  if (!node || !currentPath) return;

  const location = getLocation(filePath, lineCounter, node);
  if (location) {
    locations.set(currentPath, location);
  }

  if (isMap(node)) {
    walkMapEntries(node, currentPath, filePath, lineCounter, locations, keyLocations, context);
    return;
  }

  if (isSeq(node)) {
    node.items.forEach((item, index) => {
      walkYamlNode(
        item as Node | null | undefined,
        itemPath(currentPath, index),
        filePath,
        lineCounter,
        locations,
        keyLocations,
        context,
      );
    });
  }
}

/**
 * Where each value in a YAML file starts, by its path (`resources.jobs.daily.tasks[0]`).
 *
 * @param keyLocations When given, filled with where each key is written. A value's own
 *   location is where its content starts, which for a block is the line after its key.
 */
export function parseYamlLocations(
  filePath: string,
  content: string,
  keyLocations?: YamlLocationMap,
): YamlLocationMap {
  const lineCounter = new LineCounter();
  const document = parseDocument(content, { lineCounter });
  const locations: YamlLocationMap = new Map();
  const root = document.contents;

  if (!root || !isMap(root)) return locations;

  const context: WalkContext = { document, merging: new Set() };
  for (const item of root.items) {
    const keyValue = scalarValue(item.key);
    if (!keyValue) continue;
    walkYamlNode(
      item.value as Node | null | undefined,
      keyValue,
      filePath,
      lineCounter,
      locations,
      keyLocations,
      context,
    );
  }

  return locations;
}
