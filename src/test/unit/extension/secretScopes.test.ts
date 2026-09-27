import { describe, test, expect } from "@jest/globals";
import {
  findClusterSecretReferences,
  matchSecretScope,
} from "../../../bundle/resources/secretScope.js";
import { buildInspectorIssues } from "../../../bundle/issues.js";
import type { BundleGraph } from "../../../bundle/graph/bundleGraph.js";

const scopes = [
  { id: "resources.secret_scopes.app_scope", resourceKey: "app_scope", name: "app-secrets" },
];

describe("matchSecretScope", () => {
  test("matches a bundle scope by its name", () => {
    expect(matchSecretScope("app-secrets", scopes)).toEqual({
      nodeId: "resources.secret_scopes.app_scope",
    });
  });

  test("flags a use of the resource key, which is not a real scope name", () => {
    expect(matchSecretScope("app_scope", scopes)).toEqual({
      nodeId: "secret:app_scope",
      resourceKeyMisuse: { resourceId: "resources.secret_scopes.app_scope", scopeName: "app-secrets" },
    });
  });

  test("treats any other name as a scope outside the bundle", () => {
    expect(matchSecretScope("shared-team-scope", scopes)).toEqual({
      nodeId: "secret:shared-team-scope",
    });
  });

  test("a scope whose key and name are the same matches by name", () => {
    expect(
      matchSecretScope("same", [{ id: "resources.secret_scopes.same", resourceKey: "same", name: "same" }]),
    ).toEqual({ nodeId: "resources.secret_scopes.same" });
  });
});

describe("findClusterSecretReferences", () => {
  test("finds {{secrets/scope/key}} in spark_conf and spark_env_vars", () => {
    expect(
      findClusterSecretReferences({
        spark_conf: {
          "spark.hadoop.fs.azure.account.key": "{{secrets/conf-scope/storage_key}}",
          "spark.plain": "not a secret",
        },
        spark_env_vars: {
          DB_PASSWORD: "{{ secrets/env-scope/db_password }}",
          JDBC_URL: "jdbc:x?user={{secrets/env-scope/user}}&pw={{secrets/env-scope/pw}}",
        },
        custom_tags: { owner: "{{secrets/ignored/not-a-spark-setting}}" },
      }),
    ).toEqual([
      { scope: "conf-scope", key: "storage_key", path: "spark_conf.spark.hadoop.fs.azure.account.key" },
      { scope: "env-scope", key: "db_password", path: "spark_env_vars.DB_PASSWORD" },
      { scope: "env-scope", key: "user", path: "spark_env_vars.JDBC_URL" },
      { scope: "env-scope", key: "pw", path: "spark_env_vars.JDBC_URL" },
    ]);
  });

  test("ignores a missing or malformed cluster spec", () => {
    expect(findClusterSecretReferences(undefined)).toEqual([]);
    expect(findClusterSecretReferences({ spark_env_vars: "x" })).toEqual([]);
  });
});

describe("secret scope name warning", () => {
  test("warns at the code line where the resource key is used, owned by the task", () => {
    const graph: BundleGraph = {
      nodes: [
        { id: "resources.jobs.j.tasks.t", kind: "notebook", nodeType: "task", displayName: "t", data: {} },
        { id: "file:/b/src/nb.py", kind: "file", nodeType: "file", displayName: "nb.py", data: {} },
        {
          id: "secret:app_scope",
          kind: "secret_scope",
          nodeType: "secret_scope",
          displayName: "app_scope",
          data: {
            scope: "app_scope",
            resourceKeyMisuse: { resourceId: "resources.secret_scopes.app_scope", scopeName: "app-secrets" },
          },
        },
      ],
      edges: [
        { id: "e1", source: "resources.jobs.j.tasks.t", target: "file:/b/src/nb.py", kind: "references" },
        {
          id: "e2",
          source: "file:/b/src/nb.py",
          target: "secret:app_scope",
          kind: "references",
          data: { line: 2, key: "k", file: "/b/src/nb.py" },
        },
      ],
    };

    expect(buildInspectorIssues(graph, { bundle: { name: "b" } }, [], "/b")).toEqual([
      {
        id: "secret-scope-name:secret:app_scope:/b/src/nb.py:2",
        severity: "warning",
        kind: "secret_scope_name_mismatch",
        title: 'Secret scope "app_scope" may not exist. Did you mean "app-secrets"?',
        taskId: "resources.jobs.j.tasks.t",
        taskName: "t",
        fixHint:
          '"app_scope" is the resource key of the bundle\'s secret scope named "app-secrets". Unless a scope called "app_scope" exists outside this bundle, use "app-secrets".',
        file: "/b/src/nb.py",
        line: 2,
      },
    ]);
  });
});
