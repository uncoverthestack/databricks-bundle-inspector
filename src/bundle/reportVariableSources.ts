import { readFileSync } from "node:fs";
import path from "node:path";

export interface OutsideReportVariable { name: string; source: "environment" | "file" }

/** Capture provenance while checking, before the CLI resolves lookup and outside values alike. */
export function outsideReportVariables(bundleRoot?: string, target?: string, env: NodeJS.ProcessEnv = process.env): OutsideReportVariable[] {
  const names: OutsideReportVariable[] = Object.keys(env).filter(key => key.startsWith("BUNDLE_VAR_") && env[key] !== undefined)
    .map(key => ({ name: key.slice("BUNDLE_VAR_".length), source: "environment" as const }));
  if (bundleRoot && target) {
    try {
      const overrides: unknown = JSON.parse(readFileSync(path.join(bundleRoot, ".databricks", "bundle", target, "variable-overrides.json"), "utf8"));
      if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return [{ name: "*", source: "file" }];
      names.push(...Object.keys(overrides).map(name => ({ name, source: "file" as const })));
    } catch (error) {
      // An unreadable provenance file is never permission to print possibly private values.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return [{ name: "*", source: "file" }];
    }
  }
  return names;
}
