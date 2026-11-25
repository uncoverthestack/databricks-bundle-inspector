import type { BundleDiagnostic } from "./parseBundleDiagnostics.js";

/** The preview needs no login; suppress that diagnostic alone, not its siblings. */
export function isAuthDiagnostic(diagnostic: BundleDiagnostic): boolean {
  return diagnostic.message.includes("cannot configure default credentials");
}
