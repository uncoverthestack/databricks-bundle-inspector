import assert from "node:assert/strict";
import test from "node:test";
import { validateBundleWithDependencies } from "../databricksCli/validateBundle.js";
import type { ParsedBundleConfig } from "../shared/bundleGraph.js";

function createBundle(): ParsedBundleConfig {
  return {
    bundle: {
      name: "demo-bundle",
    },
    resources: {
      jobs: {
        sample_job: {
          name: "Sample Job",
          tasks: [],
        },
      },
    },
  };
}

test("validateBundle returns CLI_NOT_FOUND when no CLI is resolved", async () => {
  const result = await validateBundleWithDependencies(
    "/workspace/demo",
    undefined,
    {
      execFileAsync: async () => ({ stdout: "", stderr: "" }),
      resolveDatabricksCli: async () => null,
    },
  );

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }

  assert.equal(result.error.errorCode, "CLI_NOT_FOUND");
  assert.equal(result.error.bundleName, "demo");
});

test("validateBundle returns parsed bundle on successful validation", async () => {
  const bundle = createBundle();
  const calls: Array<{
    file: string;
    args: string[];
    cwd: string;
    timeout: number;
  }> = [];

  const result = await validateBundleWithDependencies(
    "/workspace/demo",
    "dev",
    {
      execFileAsync: async (file, args, options) => {
        calls.push({
          file,
          args,
          cwd: options?.cwd ?? "",
          timeout: options?.timeout ?? 0,
        });
        return {
          stdout: JSON.stringify(bundle),
          stderr: "",
        };
      },
      resolveDatabricksCli: async () => "databricks",
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.deepEqual(result.data, bundle);
  assert.deepEqual(calls, [
    {
      file: "databricks",
      args: ["bundle", "validate", "--output", "json", "--target", "dev"],
      cwd: "/workspace/demo",
      timeout: 30_000,
    },
  ]);
});

test("validateBundle surfaces stderr as a validation warning on success", async () => {
  const result = await validateBundleWithDependencies(
    "/workspace/demo",
    undefined,
    {
      execFileAsync: async () => ({
        stdout: JSON.stringify(createBundle()),
        stderr: "warning: something non-fatal happened",
      }),
      resolveDatabricksCli: async () => "databricks",
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.equal(result.issues?.[0]?.code, "VALIDATION_WARNING");
});

test("validateBundle tolerates auth errors when stdout contains valid JSON", async () => {
  const error = Object.assign(new Error("auth failed"), {
    stderr: "cannot configure default credentials",
    stdout: JSON.stringify(createBundle()),
  });

  const result = await validateBundleWithDependencies(
    "/workspace/demo",
    undefined,
    {
      execFileAsync: async () => {
        throw error;
      },
      resolveDatabricksCli: async () => "databricks",
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.equal(result.issues?.[0]?.code, "AUTH_NOT_CONFIGURED");
});

test("validateBundle treats non-zero exit with valid JSON as a CLI warning", async () => {
  const error = Object.assign(new Error("warning exit"), {
    stderr: "partial warning",
    stdout: JSON.stringify(createBundle()),
  });

  const result = await validateBundleWithDependencies(
    "/workspace/demo",
    undefined,
    {
      execFileAsync: async () => {
        throw error;
      },
      resolveDatabricksCli: async () => "databricks",
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.equal(result.issues?.[0]?.code, "CLI_WARNING");
});

test("validateBundle maps ETIMEDOUT to a timeout error", async () => {
  const error = Object.assign(new Error("timed out"), {
    code: "ETIMEDOUT",
  });

  const result = await validateBundleWithDependencies(
    "/workspace/demo",
    undefined,
    {
      execFileAsync: async () => {
        throw error;
      },
      resolveDatabricksCli: async () => "databricks",
    },
  );

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }

  assert.equal(result.error.errorCode, "VALIDATION_TIMEOUT");
});

test("validateBundle returns validation failure when stdout is not valid JSON", async () => {
  const error = Object.assign(new Error("bad output"), {
    stderr: "json parse failed",
    stdout: "not-json",
  });

  const result = await validateBundleWithDependencies(
    "/workspace/demo",
    undefined,
    {
      execFileAsync: async () => {
        throw error;
      },
      resolveDatabricksCli: async () => "databricks",
    },
  );

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }

  assert.equal(result.error.errorCode, "VALIDATION_FAILED");
  assert.match(result.error.details ?? "", /json parse failed/);
});
