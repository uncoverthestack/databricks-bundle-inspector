export interface SecretScopeNodeData {
  name: string;
  backendType: "DATABRICKS" | "AZURE_KEYVAULT" | undefined;
  keyvaultMetadata: KeyVaultMetadata | undefined;
  permissions: SecretScopePermission[];
  sourceFile: string;
  sourceLine: number;
  sourceColumn: number;

  referencedByFiles: SecretKeyReference[];
  referencedByTasks: string[];
}

export interface KeyVaultMetadata {
  dnsName: string;
  resourceId: string;
}

export interface SecretScopePermission {
  principal: string;
  permission: "READ" | "WRITE" | "MANAGE";
  principalType: "user" | "group" | "service_principal" | undefined;
}

export interface SecretKeyReference {
  scope: string;
  key: string;
  sourceFile: string;
  sourceLine: number;
  isInBundle: boolean;
}

/** A `secret_scopes` resource in the bundle: its node id, resource key and real scope name. */
export interface BundleSecretScope {
  id: string;
  resourceKey: string;
  name: string;
}

export interface SecretScopeMatch {
  /** Graph node id: the bundle's scope resource, or `secret:<name>` for a scope outside the bundle. */
  nodeId: string;
  /**
   * Set when the name used matches no scope but is the resource key of a bundle scope,
   * e.g. `app_scope` where the scope is named `app-secrets`. At runtime this fails.
   */
  resourceKeyMisuse?: { resourceId: string; scopeName: string };
}

/**
 * Finds which scope a name used in code or config refers to. Databricks knows a
 * bundle scope by its `name`, never by the resource key, so only `name` matches.
 */
export function matchSecretScope(
  scopeName: string,
  bundleScopes: readonly BundleSecretScope[],
): SecretScopeMatch {
  const byName = bundleScopes.find((scope) => scope.name === scopeName);
  if (byName) return { nodeId: byName.id };
  const byKey = bundleScopes.find((scope) => scope.resourceKey === scopeName);
  return {
    nodeId: `secret:${scopeName}`,
    ...(byKey ? { resourceKeyMisuse: { resourceId: byKey.id, scopeName: byKey.name } } : {}),
  };
}

/** `{{secrets/<scope>/<key>}}`, the syntax for secrets in cluster Spark config and env vars. */
const SECRET_REFERENCE = /\{\{\s*secrets\/([^/{}\s]+)\/([^/{}\s]+)\s*\}\}/g;

export interface ConfigSecretReference {
  scope: string;
  key: string;
  /** Config path of the value, relative to the object scanned, e.g. `spark_env_vars.DB_PASSWORD`. */
  path: string;
}

/**
 * Secret references in a cluster spec's `spark_conf` and `spark_env_vars`, the
 * two places Databricks resolves `{{secrets/...}}`.
 */
export function findClusterSecretReferences(cluster: unknown): ConfigSecretReference[] {
  if (typeof cluster !== "object" || cluster === null) return [];
  const refs: ConfigSecretReference[] = [];
  for (const field of ["spark_conf", "spark_env_vars"] as const) {
    const values = (cluster as Record<string, unknown>)[field];
    if (typeof values !== "object" || values === null) continue;
    for (const [name, value] of Object.entries(values)) {
      if (typeof value !== "string") continue;
      for (const match of value.matchAll(SECRET_REFERENCE)) {
        if (match[1] && match[2]) refs.push({ scope: match[1], key: match[2], path: `${field}.${name}` });
      }
    }
  }
  return refs;
}
