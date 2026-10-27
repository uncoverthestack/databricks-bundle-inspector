import type { InspectorIssueKind } from "./issues.js";

const REPOSITORY = "https://github.com/uncoverthestack/databricks-bundle-inspector";

/**
 * The page that explains a finding's code: its section in docs/checks.md, at the tag of
 * the installed version so the text matches what this version does. GitHub links a
 * heading written as `code` by the code itself.
 *
 * @param version The extension's version, as in package.json; `main` when unknown.
 */
export function issueDocsUrl(kind: InspectorIssueKind, version: string | undefined): string {
  return `${REPOSITORY}/blob/${docsRef(version)}/docs/checks.md#${kind}`;
}

/** The usage guide (docs/usage.md), at the tag of the installed version, like {@link issueDocsUrl}. */
export function usageDocsUrl(version: string | undefined): string {
  return `${REPOSITORY}/blob/${docsRef(version)}/docs/usage.md`;
}

export const NEW_ISSUE_URL = `${REPOSITORY}/issues/new`;

function docsRef(version: string | undefined): string {
  return version && /^\d+\.\d+\.\d+$/.test(version) ? `v${version}` : "main";
}

/** A diagnostic's code as a string, whether VS Code holds it as a value or as `{ value, target }`. */
export function codeValue(code: string | number | { value: string | number } | undefined): string | undefined {
  if (code === undefined) return undefined;
  return typeof code === "object" ? String(code.value) : String(code);
}
