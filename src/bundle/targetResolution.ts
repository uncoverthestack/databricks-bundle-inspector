import type { ParsedBundleConfig, Variable } from "./graph/bundleGraph.js";

export type ResolutionSource =
  | "cli_resolved"
  | "target_override"
  | "global_default"
  | "lookup"
  | "unresolved";

export interface VariableResolution {
  name: string;
  expression: string;
  value: string | undefined;
  source: ResolutionSource;
  status: "resolved" | "lookup" | "unresolved";
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

function variableValue(
  definition: Variable | Record<string, unknown> | unknown,
  key: "value" | "default",
): string | undefined {
  if (!isRecord(definition) || !(key in definition)) return undefined;
  return stringifyValue(definition[key]);
}

function targetOverrideValue(value: unknown): string | undefined {
  if (isRecord(value)) {
    return variableValue(value, "value") ?? variableValue(value, "default");
  }
  return stringifyValue(value);
}

export function resolveVariableForTarget(
  parsedBundle: ParsedBundleConfig | null | undefined,
  variableName: string,
  targetName?: string | null,
): VariableResolution {
  const expression = `\${var.${variableName}}`;
  const variableDefinition = parsedBundle?.variables?.[variableName];

  if (targetName) {
    const targetVariables = parsedBundle?.targets?.[targetName]?.variables;
    if (targetVariables && variableName in targetVariables) {
      return {
        name: variableName,
        expression,
        value: targetOverrideValue(targetVariables[variableName]),
        source: "target_override",
        status: "resolved",
      };
    }
  }

  const cliResolved = variableValue(variableDefinition, "value");
  if (cliResolved !== undefined) {
    return {
      name: variableName,
      expression,
      value: cliResolved,
      source: "cli_resolved",
      status: "resolved",
    };
  }

  const globalDefault = variableValue(variableDefinition, "default");
  if (globalDefault !== undefined) {
    return {
      name: variableName,
      expression,
      value: globalDefault,
      source: "global_default",
      status: "resolved",
    };
  }

  if (isRecord(variableDefinition) && isRecord(variableDefinition.lookup)) {
    return {
      name: variableName,
      expression,
      value: undefined,
      source: "lookup",
      status: "lookup",
    };
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
  if (!targetName) {
    return Boolean(parsedBundle?.variables?.[variableName]);
  }
  return (
    resolveVariableForTarget(parsedBundle, variableName, targetName).status !==
    "unresolved"
  );
}
