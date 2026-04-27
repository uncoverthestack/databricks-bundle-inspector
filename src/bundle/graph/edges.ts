export type EdgeKind =
  | "contains"    // job → task
  | "depends_on"  // task → task (execution order)
  | "references"  // task → file, task → resource, job → job (run_job_task)
  | "uses"        // task → variable, task → library, task → cluster, task → warehouse
  | "lookup";     // variable → resource (variable.lookup field)

export interface BundleEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  data?: Record<string, unknown>;
}
