import type { ParsedBundleConfig } from "./graph/bundleGraph.js";
import { isFullFormOverride, splitVariableReference } from "./targetResolution.js";

/**
 * Loops between variable values (#228), which the structural preview never resolves, so
 * the CLI's error only shows once a target is picked. Checked on Databricks CLI v1.24.0,
 * each case in a bundle of its own (the CLI stops at the first):
 *
 * - The CLI follows `${var...}` per field: `a.x: ${var.b}` with `b: ${var.a.x}` is a loop;
 *   `a.y: ${var.b}` with `b: ${var.a.x}` and `a.x: main` is not.
 * - A loop made of field references fails validate and deploy: `cycle detected in field
 *   resolution`. One that passes through a whole complex value (`${var.a}` where `a` is a
 *   mapping or list) only warns: `Variables references are too deep, stopping resolution
 *   after 11 rounds`, and leaves the `${var...}` text in place.
 * - A loop fails a target even when nothing uses the variables in it.
 * - A target's override replaces the default for that target, so it can make a loop or
 *   break one.
 */

export interface VariableLoop {
  /** The loop as the CLI prints it, from its first variable back to it: `a -> b -> a`. */
  path: string[];
  /** The variables in it, in the order they first appear in the loop. */
  variables: string[];
  /** Through a whole complex value: the CLI warns instead of failing. */
  complex: boolean;
  /** Targets it fails, in the bundle's order. Empty when the bundle defines none. */
  targets: string[];
  /** Whether it is in every target (or the bundle has none). */
  everyTarget: boolean;
  /** Per variable in the loop, the target whose override it comes from, if not the default. */
  overrideTarget: Record<string, string | undefined>;
}

type Leaf = { id: string; text: string | undefined };
/** A variable's value in one target, and the target whose override it is, if any. */
type Value = { value: unknown; override?: string | undefined };

const REFERENCE = /\$\{var\.([^}]+)\}/g;

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === "object" && value !== null;
}

/** `a.x`, `a.list[1]`: how the CLI names a field in its message. */
function fieldName(name: string, path: (string | number)[]): string {
  return path.reduce<string>((text, part) => (typeof part === "number" ? `${text}[${part}]` : `${text}.${part}`), name);
}

/** Every scalar in a value, with its field name. */
function leavesOf(name: string, value: unknown, path: (string | number)[] = []): Leaf[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => leavesOf(name, item, [...path, index]));
  if (isContainer(value)) return Object.entries(value).flatMap(([key, item]) => leavesOf(name, item, [...path, key]));
  return [{ id: fieldName(name, path), text: typeof value === "string" ? value : undefined }];
}

/** The part of a value at a path, if it has one. */
function at(value: unknown, path: (string | number)[]): { found: boolean; value?: unknown } {
  let current = value;
  for (const part of path) {
    if (Array.isArray(current) && typeof part === "number" && part < current.length) current = current[part];
    else if (isContainer(current) && !Array.isArray(current) && typeof part === "string" && part in current) current = current[part];
    else return { found: false };
  }
  return { found: true, value: current };
}

/** Each variable's value in one target: its override there, else its default. */
function valuesFor(
  parsedBundle: ParsedBundleConfig,
  target: string | undefined,
): Map<string, Value> {
  const values = new Map<string, Value>();
  const overrides = target ? (parsedBundle.targets?.[target]?.variables as Record<string, unknown> | undefined) : undefined;
  for (const [name, definition] of Object.entries(parsedBundle.variables ?? {})) {
    if (overrides && name in overrides) {
      const raw = overrides[name];
      const value = isFullFormOverride(raw) ? (raw.value ?? raw.default) : raw;
      if (value !== undefined) {
        values.set(name, { value, override: target });
        continue;
      }
    }
    const def = definition as Record<string, unknown> | undefined;
    if (def && "default" in def) values.set(name, { value: def.default });
  }
  return values;
}

/**
 * Strongly connected parts of a graph (Tarjan), each with more than one node or a node
 * that points at itself: every node in one is on a loop.
 */
function loopsIn(nodes: string[], edges: Map<string, Set<string>>): string[][] {
  let index = 0;
  const order = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const parts: string[][] = [];
  function visit(node: string): void {
    order.set(node, index);
    low.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of edges.get(node) ?? []) {
      if (!order.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node)!, low.get(next)!));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node)!, order.get(next)!));
      }
    }
    if (low.get(node) === order.get(node)) {
      const part: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        part.push(member);
      } while (member !== node);
      if (part.length > 1 || edges.get(node)?.has(node)) parts.push(part.reverse());
    }
  }
  for (const node of nodes) if (!order.has(node)) visit(node);
  return parts;
}

/** One walk around a loop's fields, starting at its first field, as the CLI prints it. */
function walk(start: string, members: Set<string>, edges: Map<string, Set<string>>): string[] {
  const path = [start];
  const seen = new Set([start]);
  let current = start;
  for (;;) {
    const next = [...(edges.get(current) ?? [])].find((n) => members.has(n));
    if (next === undefined) return path;
    path.push(next);
    if (seen.has(next)) return path;
    seen.add(next);
    current = next;
  }
}

/** The loops in one target's values. */
function loopsForValues(values: Map<string, Value>) {
  const leaves = new Map<string, Leaf & { variable: string }>();
  for (const [name, { value }] of values) {
    for (const leaf of leavesOf(name, value)) leaves.set(leaf.id, { ...leaf, variable: name });
  }
  const fieldEdges = new Map<string, Set<string>>();
  const allEdges = new Map<string, Set<string>>();
  const link = (map: Map<string, Set<string>>, from: string, to: string) => map.set(from, (map.get(from) ?? new Set()).add(to));
  for (const leaf of leaves.values()) {
    for (const match of (leaf.text ?? "").matchAll(REFERENCE)) {
      const { name, path } = splitVariableReference(match[1]!);
      const target = values.get(name);
      if (!target) continue;
      const part = at(target.value, path);
      if (!part.found) continue;
      if (isContainer(part.value)) {
        // A whole mapping or list: the CLI resolves it in rounds and only warns.
        for (const inner of leavesOf(name, part.value, path)) link(allEdges, leaf.id, inner.id);
      } else {
        const id = fieldName(name, path);
        link(fieldEdges, leaf.id, id);
        link(allEdges, leaf.id, id);
      }
    }
  }
  const ids = [...leaves.keys()];
  const found: { fields: string[]; complex: boolean; edges: Map<string, Set<string>> }[] = [];
  const covered = new Set<string>();
  for (const part of loopsIn(ids, fieldEdges)) {
    found.push({ fields: part, complex: false, edges: fieldEdges });
    part.forEach((id) => covered.add(id));
  }
  for (const part of loopsIn(ids, allEdges)) {
    if (part.every((id) => covered.has(id))) continue;
    found.push({ fields: part, complex: true, edges: allEdges });
  }
  return found.map(({ fields, complex, edges }) => {
    const members = new Set(fields);
    const start = ids.find((id) => members.has(id))!;
    const path = walk(start, members, edges);
    const variables = [...new Set(path.map((id) => leaves.get(id)!.variable))];
    const overrideTarget = Object.fromEntries(variables.map((name) => [name, values.get(name)?.override]));
    return { path, variables, complex, overrideTarget };
  });
}

/**
 * The variable loops that fail (or, through a complex value, warn on) each target, merged
 * across targets: one entry per loop, with the targets it is in.
 */
export function findVariableLoops(parsedBundle: ParsedBundleConfig): VariableLoop[] {
  const targets = Object.keys(parsedBundle.targets ?? {});
  const scopes: (string | undefined)[] = targets.length > 0 ? targets : [undefined];
  const merged = new Map<string, VariableLoop>();
  for (const scope of scopes) {
    for (const loop of loopsForValues(valuesFor(parsedBundle, scope))) {
      // The same loop from the same lines, whichever target it is in.
      const key = JSON.stringify([loop.path, loop.complex, loop.overrideTarget]);
      const entry = merged.get(key) ?? { ...loop, targets: [], everyTarget: false };
      if (scope) entry.targets.push(scope);
      merged.set(key, entry);
    }
  }
  return [...merged.values()].map((loop) => ({
    ...loop,
    everyTarget: targets.length === 0 || loop.targets.length === targets.length,
  }));
}
