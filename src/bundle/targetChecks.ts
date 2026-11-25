import { isMap, isScalar, LineCounter, parseDocument } from "yaml";
import { isAtLeastVersion } from "../databricksCli/parsing.js";
import type { SourceFile } from "./jobStructure.js";
import type { YamlLocation } from "./sourceLocations.js";

/**
 * Checks the Databricks CLI runs only once it has picked a target (#389). The structural
 * preview validates with a target that doesn't exist, so the CLI stops at "no such target"
 * before them, and their errors never reach the Problems panel. Each rule here is one the
 * CLI runs in its initialize phase before it first calls the workspace
 * (bundle/phases/initialize.go, up to PopulateCurrentUser), read from the CLI's own output
 * where it can be, and checked against the real CLI by targetChecks.integration.test.ts.
 *
 * Older CLIs: each field below arrived in the same CLI release as its rule (script env in
 * v1.8.0, secrets in v1.12.0, internal resources in v1.16.0), and an older CLI drops a
 * field it doesn't know with an "unknown field" warning. So a rule that finds its field in
 * the CLI's output applies to that CLI. Only the Terraform rules, which changed what an
 * existing field may say, need the CLI's version.
 */

/** The codes these checks report, in docs/checks.md order. */
export const TARGET_CHECK_KINDS = [
  "internal_resource_set",
  "resource_not_defined",
  "variable_in_auth_field",
  "variable_in_bundle_name",
  "invalid_engine",
  "terraform_engine_removed",
  "terraform_setting_has_no_effect",
  "script_no_content",
  "variable_in_script_content",
  "script_env_reference_not_resolved",
  "secret_value_not_variable",
  "secret_variable_has_default",
] as const;

export type TargetCheckKind = (typeof TARGET_CHECK_KINDS)[number];

export interface TargetCheckFinding {
  kind: TargetCheckKind;
  severity: "error" | "warning";
  title: string;
  fixHint: string;
  /** The YAML path the finding is about, e.g. `targets.dev.workspace.host`. */
  yamlPath: string;
  /** The resource it belongs to, e.g. `resources.jobs.my_job`. */
  resourceId?: string;
  location?: YamlLocation;
}

/** The CLI release that removed the Terraform engine and made `bundle.terraform` a no-op (v1.20.0). */
export const TERRAFORM_REMOVED_CLI_VERSION = "v1.20.0";

/** The workspace fields that configure sign-in, from validate/interpolation_in_auth_config.go (v1.26.0). */
const AUTH_FIELDS = [
  "host",
  "profile",
  "auth_type",
  "metadata_service_url",
  "client_id",
  "google_service_account",
  "azure_resource_id",
  "azure_use_msi",
  "azure_client_id",
  "azure_tenant_id",
  "azure_environment",
  "azure_login_app_id",
  "account_id",
  "workspace_id",
] as const;

/** What a script's env may refer to, the prefixes resolved before scripts run (validate/scripts.go). */
const SCRIPT_ENV_PREFIXES = ["bundle", "workspace", "var", "variables"];

/**
 * A `${...}` reference as the CLI matches one (libs/dyn/dynvar/ref.go): names of letters,
 * digits, `-` and `_`, joined by dots, with optional `[n]` indexes.
 */
const NAME = String.raw`_*\p{L}+(?:[-_]*[\p{L}\p{N}]+)*`;
const REFERENCE_SOURCE = String.raw`\$\{(${NAME}(?:\.${NAME}(?:\[[0-9]+\])*)*(?:\[[0-9]+\])*)\}`;

/**
 * The CLI release from which `$${...}` is an escaped literal, not a reference (v1.15.0,
 * `isEscapedAt` in libs/dyn/dynvar/ref.go). v0.299.2 rejects `echo $${HOME}` in a script.
 */
export const ESCAPED_REFERENCE_CLI_VERSION = "v1.15.0";

/**
 * Each reference in a string the CLI would resolve.
 *
 * @param honourEscapes Whether `$${...}` is escaped, as from {@link ESCAPED_REFERENCE_CLI_VERSION}.
 */
export function variableReferences(value: string, honourEscapes = true): string[] {
  const found: string[] = [];
  for (const match of value.matchAll(new RegExp(REFERENCE_SOURCE, "gu"))) {
    if (honourEscapes && match.index > 0 && value[match.index - 1] === "$") continue;
    found.push(match[1]!);
  }
  return found;
}

/** Whether a string is one reference and nothing else, as a secret's value must be. */
export function isPureReference(value: string): boolean {
  return new RegExp(`^${REFERENCE_SOURCE}$`, "u").test(value);
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const has = (value: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(value, key);

/**
 * Where a key is written, the first file that has it: the line of `host:`, not of its
 * value, so a missing or empty value still has a line. Keys reached through `<<` merges or
 * aliases aren't followed; those findings fall back to no line.
 */
export function keyLocator(files: SourceFile[]): (path: string[]) => YamlLocation | undefined {
  const parsed = new Map<SourceFile, { doc: ReturnType<typeof parseDocument>; lines: LineCounter }>();
  return (path) => {
    for (const file of files) {
      if (file.text === undefined) continue;
      let entry = parsed.get(file);
      if (!entry) {
        const lines = new LineCounter();
        entry = { doc: parseDocument(file.text, { lineCounter: lines, uniqueKeys: false }), lines };
        parsed.set(file, entry);
      }
      let node: unknown = entry.doc.contents;
      let keyOffset: number | undefined;
      for (const part of path) {
        if (!isMap(node)) {
          node = undefined;
          break;
        }
        // The last of a repeated key wins, as in the CLI.
        const pair = node.items.filter((item) => isScalar(item.key) && String(item.key.value) === part).at(-1);
        if (!pair) {
          node = undefined;
          break;
        }
        keyOffset = isScalar(pair.key) ? pair.key.range?.[0] : undefined;
        node = pair.value;
      }
      if (node === undefined || typeof keyOffset !== "number") continue;
      const { line, col } = entry.lines.linePos(keyOffset);
      return { file: file.file, line, column: col };
    }
    return undefined;
  };
}

/** The value written at a path in one file's YAML, or undefined when the file doesn't write it. */
function writtenAt(doc: unknown, path: string[]): { found: boolean; value?: unknown } {
  let node: unknown = doc;
  for (const part of path) {
    const map = record(node);
    if (!has(map, part)) return { found: false };
    node = map[part];
  }
  return { found: true, value: node };
}

interface Place {
  /** `""` for the bundle's own settings, else the target's name. */
  target: string;
  /** The YAML path prefix: `[]` or `["targets", name]`. */
  prefix: string[];
  config: Record<string, unknown>;
}

/** The bundle's own settings and each target's overrides, which the CLI merges before checking. */
function places(bundle: Record<string, unknown>): Place[] {
  return [
    { target: "", prefix: [], config: bundle },
    ...Object.entries(record(bundle.targets)).map(([name, target]) => ({
      target: name,
      prefix: ["targets", name],
      config: record(target),
    })),
  ];
}

const where = (place: Place) => (place.target ? ` in target "${place.target}"` : "");

/**
 * The problems the CLI reports once a target is picked, from the CLI's preview output and
 * the bundle's YAML files.
 *
 * @param cliVersion The version of the CLI that wrote the output, such as `v1.26.0`. When
 *   it can't be read, the newest CLI's rules apply, as with the notebook rule.
 */
export function findTargetCheckProblems(
  cliOutput: unknown,
  files: SourceFile[],
  cliVersion?: string,
): TargetCheckFinding[] {
  const bundle = record(cliOutput);
  const resources = record(bundle.resources);
  const locate = keyLocator(files);
  const findings: TargetCheckFinding[] = [];
  const add = (finding: Omit<TargetCheckFinding, "location">, path: string[]) => {
    const location = locate(path);
    findings.push({ ...finding, ...(location ? { location } : {}) });
  };
  const atLeast = (version: string) => !cliVersion || isAtLeastVersion(cliVersion, version) !== false;
  const terraformRemoved = atLeast(TERRAFORM_REMOVED_CLI_VERSION);
  const honourEscapes = atLeast(ESCAPED_REFERENCE_CLI_VERSION);
  const references = (value: string) => variableReferences(value, honourEscapes);

  // Internal resources: only the CLI writes these (validate: RejectInternalResources).
  for (const [group, entries] of Object.entries(resources)) {
    if (!group.startsWith("internal_")) continue;
    for (const key of Object.keys(record(entries))) {
      add(
        {
          kind: "internal_resource_set",
          severity: "error",
          title: `"${group}" is set by the Databricks CLI itself, not in a bundle. Validate and deploy may fail.`,
          fixHint: `The CLI stops with "Internal resources cannot be set in bundle configuration". Remove ${group} from the bundle.`,
          yamlPath: `resources.${group}.${key}`,
          resourceId: `resources.${group}.${key}`,
        },
        ["resources", group, key],
      );
    }
  }

  // A resource key with nothing under it (validate: AllResourcesHaveValues).
  for (const [group, entries] of Object.entries(resources)) {
    for (const [key, value] of Object.entries(record(entries))) {
      if (value !== null) continue;
      const type = group.replace(/s$/, "");
      add(
        {
          kind: "resource_not_defined",
          severity: "error",
          title: `${group} "${key}" has no settings. Validate and deploy may fail.`,
          fixHint: `The CLI stops with "${type} ${key} is not defined". Add its settings under the key, or remove the key.`,
          yamlPath: `resources.${group}.${key}`,
          resourceId: `resources.${group}.${key}`,
        },
        ["resources", group, key],
      );
    }
  }

  for (const place of places(bundle)) {
    // ${...} in a sign-in setting (validate: NoInterpolationInAuthConfig): sign-in is
    // configured before variables are resolved.
    const workspace = record(place.config.workspace);
    for (const field of AUTH_FIELDS) {
      const value = workspace[field];
      if (typeof value !== "string" || references(value).length === 0) continue;
      add(
        {
          kind: "variable_in_auth_field",
          severity: "warning",
          title: `workspace.${field} uses \${...}${where(place)}. The Databricks CLI doesn't resolve variables in sign-in settings.`,
          fixHint:
            field === "host"
              ? "Write the value itself, or leave it out and set the DATABRICKS_HOST environment variable."
              : `Write the value itself, or leave it out and set it with its environment variable.`,
          yamlPath: [...place.prefix, "workspace", field].join("."),
        },
        [...place.prefix, "workspace", field],
      );
    }

    const bundleSection = record(place.config.bundle);
    // ${...} in the bundle name (validate: NoInterpolationInBundleName).
    const name = bundleSection.name;
    if (typeof name === "string" && references(name).length > 0) {
      add(
        {
          kind: "variable_in_bundle_name",
          severity: "warning",
          title: `The bundle name uses \${...}${where(place)}. Deploys may go to different folders, and destroy may miss resources.`,
          fixHint: "The name is part of the folder each deploy keeps its state in. Write the name itself.",
          yamlPath: [...place.prefix, "bundle", "name"].join("."),
        },
        [...place.prefix, "bundle", "name"],
      );
    }

    // bundle.engine (validate: ValidateEngine).
    const engine = bundleSection.engine;
    if (typeof engine === "string" && engine !== "" && engine !== "direct" && engine !== "terraform") {
      add(
        {
          kind: "invalid_engine",
          severity: "error",
          title: `bundle.engine "${engine}" is not an engine the Databricks CLI knows${where(place)}. Validate and deploy may fail.`,
          fixHint: terraformRemoved ? 'Use "direct", or leave bundle.engine out.' : 'Use "direct" or "terraform", or leave bundle.engine out.',
          yamlPath: [...place.prefix, "bundle", "engine"].join("."),
        },
        [...place.prefix, "bundle", "engine"],
      );
    }
    if (engine === "terraform" && terraformRemoved) {
      add(
        {
          kind: "terraform_engine_removed",
          severity: "error",
          title: `bundle.engine "terraform"${where(place)} may fail. Databricks CLI ${TERRAFORM_REMOVED_CLI_VERSION} removed the Terraform engine.`,
          fixHint: 'Change it to "direct", or leave bundle.engine out. A bundle deployed with Terraform may need migrating first; see the Databricks CLI release notes for v1.20.0.',
          yamlPath: [...place.prefix, "bundle", "engine"].join("."),
        },
        [...place.prefix, "bundle", "engine"],
      );
    }
    if (has(bundleSection, "terraform") && terraformRemoved) {
      add(
        {
          kind: "terraform_setting_has_no_effect",
          severity: "warning",
          title: `bundle.terraform has no effect${where(place)}. Databricks CLI ${TERRAFORM_REMOVED_CLI_VERSION} removed the Terraform engine.`,
          fixHint: "Remove bundle.terraform.",
          yamlPath: [...place.prefix, "bundle", "terraform"].join("."),
        },
        [...place.prefix, "bundle", "terraform"],
      );
    }
  }

  // Scripts (validate: Scripts). The CLI only has the top-level scripts section.
  for (const [key, value] of Object.entries(record(bundle.scripts))) {
    const script = record(value);
    const content = typeof script.content === "string" ? script.content : "";
    if (content === "") {
      add(
        {
          kind: "script_no_content",
          severity: "error",
          title: `Script "${key}" has no content. Validate and deploy may fail.`,
          fixHint: "Add the commands to run under content:, or remove the script.",
          yamlPath: `scripts.${key}`,
        },
        has(script, "content") ? ["scripts", key, "content"] : ["scripts", key],
      );
      continue;
    }
    const inContent = references(content);
    if (inContent.length > 0) {
      add(
        {
          kind: "variable_in_script_content",
          severity: "error",
          title: `Script "${key}" uses \${${inContent[0]}} in its content. Validate and deploy may fail.`,
          fixHint: `The CLI doesn't allow \${...} in script content. Set it under env:, for example env: MY_VALUE: \${${inContent[0]}}, and use $MY_VALUE in the content.`,
          yamlPath: `scripts.${key}.content`,
        },
        ["scripts", key, "content"],
      );
    }
    for (const [name, envValue] of Object.entries(record(script.env))) {
      if (typeof envValue !== "string") continue;
      for (const reference of references(envValue)) {
        const prefix = reference.split(".")[0]!;
        if (SCRIPT_ENV_PREFIXES.includes(prefix)) continue;
        add(
          {
            kind: "script_env_reference_not_resolved",
            severity: "error",
            title: `Script "${key}" sets ${name} to \${${reference}}, which isn't known before scripts run. Validate and deploy may fail.`,
            fixHint: "Only ${bundle.*}, ${workspace.*} and ${var.*} can be used in a script's env.",
            yamlPath: `scripts.${key}.env.${name}`,
          },
          ["scripts", key, "env", name],
        );
      }
    }
  }

  // Secrets (validate: ValidateSecretValueIsVariable). The CLI's output hides each value as
  // "[redacted]", so the value is read from the YAML as written: in the bundle's own
  // resources and in each target's. A CLI before v1.12.0 has no secrets and drops them.
  const secretKeys = new Set(places(bundle).flatMap((place) => Object.keys(record(record(place.config.resources).secrets))));
  if (secretKeys.size > 0 && atLeast("v1.12.0")) {
    const variables = record(bundle.variables);
    const targetSets = (variable: string) =>
      Object.values(record(bundle.targets)).some((target) => has(record(record(target).variables), variable));
    for (const key of secretKeys) {
      const written: Array<{ path: string[]; value: unknown }> = [];
      for (const file of files) {
        for (const prefix of [[], ...Object.keys(record(record(file.doc).targets)).map((name) => ["targets", name])]) {
          const path = [...prefix, "resources", "secrets", key, "value"];
          const at = writtenAt(file.doc, path);
          if (at.found) written.push({ path, value: at.value });
        }
      }
      const secretId = `resources.secrets.${key}`;
      if (written.length === 0) {
        const place = places(bundle).find((place) => has(record(record(place.config.resources).secrets), key))!;
        const secretPath = [...place.prefix, "resources", "secrets", key];
        add(
          {
            kind: "secret_value_not_variable",
            severity: "error",
            title: `Secret "${key}" has no value. Validate and deploy may fail.`,
            fixHint: "Set value: to a variable with no default, for example value: ${var.my_secret}, and pass it at deploy with --var or BUNDLE_VAR_my_secret.",
            yamlPath: secretPath.join("."),
            resourceId: secretId,
          },
          secretPath,
        );
        continue;
      }
      for (const { path, value } of written) {
        if (typeof value !== "string" || !isPureReference(value)) {
          add(
            {
              kind: "secret_value_not_variable",
              severity: "error",
              title:
                typeof value === "string"
                  ? `Secret "${key}" has its value written in the file. Validate and deploy may fail.`
                  : `Secret "${key}" has a value that isn't text. Validate and deploy may fail.`,
              fixHint: "The CLI only accepts a variable reference, so the secret isn't stored in plain text. Use value: ${var.my_secret} with no default, and pass it at deploy with --var or BUNDLE_VAR_my_secret.",
              yamlPath: path.join("."),
              resourceId: secretId,
            },
            path,
          );
          continue;
        }
        const reference = references(value)[0]!;
        const [root, variable, field] = reference.split(".");
        // The CLI also resolves its full configuration path (#606). A reference to
        // variables.pw.default (or .value) must not hide the same plaintext default.
        if (!variable || !(root === "var" || (root === "variables" && (field === "default" || field === "value")))) continue;
        const definition = record(variables[variable]);
        if (!has(definition, "default") && !targetSets(variable)) continue;
        add(
          {
            kind: "secret_variable_has_default",
            severity: "error",
            title: root === "variables"
              ? `Secret "${key}" uses variable "${variable}", which has a value written in the bundle as plain text.`
              : `Secret "${key}" uses variable "${variable}", which has a value in the bundle. Validate and deploy may fail.`,
            fixHint: `A value in the bundle is stored in plain text. Remove the default (and any target's value) of "${variable}", and pass it at deploy with --var or BUNDLE_VAR_${variable}.`,
            yamlPath: path.join("."),
            resourceId: secretId,
          },
          path,
        );
      }
    }
  }

  return findings;
}
