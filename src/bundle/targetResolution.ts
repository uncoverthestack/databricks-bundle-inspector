import type { ParsedBundleConfig, Variable } from "./graph/bundleGraph.js";

export type ResolutionSource =
  | "cli_resolved"
  | "target_override"
  | "global_default"
  | "lookup"
  | "no_default"
  | "outside_files"
  | "unresolved";

export interface VariableResolution {
  name: string;
  expression: string;
  value: string | undefined;
  source: ResolutionSource;
  /**
   * `unset`: the structural preview of a variable with no default. A target, an
   * environment variable or variable-overrides.json may set it, so it is not an error.
   */
  status: "resolved" | "lookup" | "unset" | "unresolved";
}

export interface ExpressionResolution {
  value: string;
  changed: boolean;
  unresolvedVariables: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringifyValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}

function rawValue(
  definition: Variable | Record<string, unknown> | unknown,
  key: "value" | "default",
): { found: boolean; value?: unknown } {
  if (!isRecord(definition) || !(key in definition)) return { found: false };
  return { found: true, value: definition[key] };
}

/** The settings a variable can have, which make a target's override its full form. */
export const VARIABLE_SETTINGS = new Set(["default", "description", "lookup", "type", "value"]);

/**
 * Whether a target's override is the full form (`default:`, `lookup:` ...) rather than
 * the value itself. The CLI reads a mapping as the full form only when every key is
 * a variable setting: `{default: x, a: y}` is a complex value (checked on CLI 1.21.0).
 */
export function isFullFormOverride(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length > 0 && Object.keys(value).every((key) => VARIABLE_SETTINGS.has(key));
}

function targetOverrideRaw(value: unknown): { found: boolean; value?: unknown } {
  if (isFullFormOverride(value)) {
    const own = rawValue(value, "value");
    return own.found ? own : rawValue(value, "default");
  }
  return { found: true, value };
}

/**
 * A reference as the variable it names and the path into that variable's value:
 * `c.list[1].x` is the variable `c` and the path `list`, 1, `x`. The CLI reads
 * fields and list items of a complex variable this way (acceptance tests
 * variables/complex and resolve-field-within-complex).
 */
export function splitVariableReference(reference: string): { name: string; path: (string | number)[] } {
  const [name = reference, ...rest] = reference.split(/\.|\[|\]/).filter((part) => part !== "");
  return { name, path: rest.map((part) => (/^\d+$/.test(part) ? Number(part) : part)) };
}

/** JSON with sorted keys, to compare values from YAML and from the CLI's JSON. */
function sameValue(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : isRecord(value)
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
        : value;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** The value at a path, or `found: false` when the path is not in it. */
function valueAtPath(value: unknown, path: (string | number)[]): { found: boolean; value?: unknown } {
  let current = value;
  for (const key of path) {
    if (Array.isArray(current) && typeof key === "number" && key < current.length) {
      current = current[key];
    } else if (isRecord(current) && typeof key === "string" && key in current) {
      current = current[key];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

export function resolveVariableForTarget(
  parsedBundle: ParsedBundleConfig | null | undefined,
  variableName: string,
  targetName?: string | null,
): VariableResolution {
  const expression = `\${var.${variableName}}`;
  const { name, path } = splitVariableReference(variableName);
  const variableDefinition = parsedBundle?.variables?.[name];
  const result = (
    source: ResolutionSource,
    raw: { found: boolean; value?: unknown },
  ): VariableResolution => {
    // A field or item the value doesn't have: the CLI says "reference does not exist".
    const field = valueAtPath(raw.value, path);
    if (!field.found) {
      return { name: variableName, expression, value: undefined, source: "unresolved", status: "unresolved" };
    }
    return { name: variableName, expression, value: stringifyValue(field.value), source, status: "resolved" };
  };

  const cliResolved = rawValue(variableDefinition, "value");
  if (targetName) {
    const targetVariables = parsedBundle?.targets?.[targetName]?.variables;
    const override =
      targetVariables && name in targetVariables ? targetOverrideRaw(targetVariables[name]) : { found: false };
    // The CLI's value is what deploys. A BUNDLE_VAR_ environment variable or
    // variable-overrides.json wins over the target's override (docs, precedence order).
    if (override.found && (!cliResolved.found || sameValue(override.value, cliResolved.value))) {
      return result("target_override", override);
    }
    const globalDefault = rawValue(variableDefinition, "default");
    if (
      cliResolved.found &&
      (override.found || (globalDefault.found && !sameValue(globalDefault.value, cliResolved.value)))
    ) {
      return result("outside_files", cliResolved);
    }
  }

  if (cliResolved.found) return result("cli_resolved", cliResolved);

  const globalDefault = rawValue(variableDefinition, "default");
  if (globalDefault.found) return result("global_default", globalDefault);

  if (isRecord(variableDefinition) && isRecord(variableDefinition.lookup)) {
    return {
      name: variableName,
      expression,
      value: undefined,
      source: "lookup",
      status: "lookup",
    };
  }

  // Defined with no default: in a target nothing set it, which the CLI rejects; the
  // preview can't know, as a target or the environment may set it.
  if (variableDefinition !== undefined && !targetName) {
    return { name: variableName, expression, value: undefined, source: "no_default", status: "unset" };
  }

  return {
    name: variableName,
    expression,
    value: undefined,
    source: "unresolved",
    status: "unresolved",
  };
}

export function resolveExpressionForTarget(
  value: string,
  parsedBundle: ParsedBundleConfig | null | undefined,
  targetName?: string | null,
): ExpressionResolution {
  const unresolvedVariables = new Set<string>();
  let changed = false;

  const resolved = value.replace(
    /\$\{(bundle\.name|bundle\.target|var\.([^}]+))\}/g,
    (match, token, variableName) => {
      if (token === "bundle.name" && parsedBundle?.bundle?.name) {
        changed = true;
        return parsedBundle.bundle.name;
      }

      if (token === "bundle.target" && targetName) {
        changed = true;
        return targetName;
      }

      if (typeof variableName === "string") {
        const variable = resolveVariableForTarget(
          parsedBundle,
          variableName,
          targetName,
        );
        if (variable.status === "resolved" && variable.value !== undefined) {
          changed = true;
          return variable.value;
        }
        unresolvedVariables.add(variableName);
      }

      return match;
    },
  );

  return {
    value: resolved,
    changed,
    unresolvedVariables: [...unresolvedVariables],
  };
}

export function isVariableResolvedForTarget(
  parsedBundle: ParsedBundleConfig | null | undefined,
  variableName: string,
  targetName?: string | null,
): boolean {
  return (
    resolveVariableForTarget(parsedBundle, variableName, targetName).status !==
    "unresolved"
  );
}
