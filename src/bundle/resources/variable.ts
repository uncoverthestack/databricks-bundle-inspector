export type VariableValueType = "string" | "complex";
export type VariableValue = string | ComplexVariableValue;
export type ComplexVariableValue = Record<string, string> | string[];

export interface VariableNodeData {
  name: string;
  description: string | undefined;
  default: VariableValue | undefined;
  type: VariableValueType | undefined;
  lookup: VariableLookup | undefined;
  perTargetValues: Record<string, TargetVariableResolution>;
  usageSummary: VariableUsageSummary;
  sourceFile: string;
  sourceLine: number;
  sourceColumn: number;
}

export interface VariableLookup {
  resourceType:
    | "alert"
    | "cluster"
    | "cluster_policy"
    | "dashboard"
    | "instance_pool"
    | "job"
    | "metastore"
    | "notification_destination"
    | "pipeline"
    | "query"
    | "service_principal"
    | "warehouse";
  resourceName: string;
  resolvedId: string | undefined;
}

export interface TargetVariableResolution {
  override: VariableValue | undefined;

  resolvedValue: string | undefined;
  resolvedByCliCall: boolean; // did we get this from CLI or did we infer it

  // resolution path — how did we get this value
  resolutionSource:
    | "cli_resolved" // came from variables[*].value in per-target call
    | "target_override" // came from targets.<name>.variables.<var>
    | "global_default" // fell back to variables.<var>.default
    | "lookup" // resolved via resource lookup
    | "unresolved"; // no value found anywhere

  confidence: "HIGH" | "MEDIUM" | "LOW";
  // HIGH   → cli_resolved
  // MEDIUM → target_override or global_default without CLI confirmation
  // LOW    → unresolved
}

export interface VariableUsageSummary {
  // where is this variable referenced across the bundle
  referencedInFiles: string[]; // file paths
  referencedByTasks: string[]; // task keys
  referencedByResources: string[]; // resource names
  referencedByTargets: string[]; // target names that override it

  hasNoDefault: boolean; // no global default defined
  hasNoTargetOverrideInSomeTargets: boolean; // some targets don't override it
  isUnresolvedInSomeTargets: boolean; // unresolved in at least one target
  isUnusedAnywhere: boolean; // defined but never referenced
}
