import { isMap, isSeq, LineCounter, parseDocument } from "yaml";
import type { Node } from "yaml";

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

function walkYamlNode(
  node: Node | null | undefined,
  currentPath: string,
  filePath: string,
  lineCounter: LineCounter,
  locations: YamlLocationMap,
  keyLocations?: YamlLocationMap,
): void {
  if (!node || !currentPath) return;

  const location = getLocation(filePath, lineCounter, node);
  if (location) {
    locations.set(currentPath, location);
  }

  if (isMap(node)) {
    for (const item of node.items) {
      const keyValue = scalarValue(item.key);
      if (!keyValue) continue;
      const path = childPath(currentPath, keyValue);
      const keyLocation = keyLocations ? getLocation(filePath, lineCounter, item.key as Node) : undefined;
      if (keyLocation) keyLocations!.set(path, keyLocation);
      walkYamlNode(
        item.value as Node | null | undefined,
        path,
        filePath,
        lineCounter,
        locations,
        keyLocations,
      );
    }
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
    );
  }

  return locations;
}
