import { splitVariableReference } from "../../bundle/targetResolution.js";

export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

export interface VariableSources {
  definition?: SourceLocation;
  targets?: Record<string, SourceLocation>;
}

/**
 * The line to open for a variable in the graph: in a target, that target's override
 * when it has one, as the CLI lets a target's value win over the top-level default;
 * otherwise the top-level definition. The structural preview has no target.
 */
export function variableSourceLocation(
  variableSources: Record<string, VariableSources> | undefined,
  reference: string,
  targetName: string | null | undefined,
): SourceLocation | undefined {
  // A field reference such as `c.a.b` opens the variable `c`.
  const sources = variableSources?.[splitVariableReference(reference).name];
  if (!sources) return undefined;
  return (targetName ? sources.targets?.[targetName] : undefined) ?? sources.definition;
}
