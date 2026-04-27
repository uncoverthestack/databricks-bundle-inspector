import { describe, test, expect } from "@jest/globals";
import { validateBundleWithDependencies } from "../../../bundle/validateBundle.js";
import type { ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";

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
describe("validateBundleWithDependencies", () => {
  test("returns CLI_NOT_FOUND when no CLI is resolved", async () => {
    const result = await validateBundleWithDependencies(
      "/workspace/demo",
      undefined,
      {
        execFileAsync: async () => ({ stdout: "", stderr: "" }),
        resolveDatabricksCli: async () => undefined,
      },
    );

    expect(result.ok).toBe(false);

    if (result.ok) return;

    expect(result.error.errorCode).toBe("CLI_NOT_FOUND");
    expect(result.error.bundleName).toBe("demo");
  });

  test("returns parsed bundle on successful validation", async () => {
    const bundle = createBundle();
    const calls: Array<{
      file: string;
      args: string[];
      cwd: string;
      timeout: number;
    }> = [];
    const probeTarget = `__bundle_inspector_probe__`;

    const result = await validateBundleWithDependencies(
      "/workspace/demo",
      probeTarget,
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
        resolveDatabricksCli: async () => ({
          ok: true,
          candidate: "databricks",
          versionOutput: "v0.295.0",
        }),
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data).toEqual(bundle);
    expect(calls).toEqual([
      {
        file: "databricks",
        args: [
          "bundle",
          "validate",
          "--output",
          "json",
          "--target",
          probeTarget,
        ],
        cwd: "/workspace/demo",
        timeout: 30_000,
      },
    ]);
  });

  test("surfaces stderr diagnostics as BUNDLE_DIAGNOSTICS on success", async () => {
    const result = await validateBundleWithDependencies(
      "/workspace/demo",
      undefined,
      {
        execFileAsync: async () => ({
          stdout: JSON.stringify(createBundle()),
          stderr: "Warning: unknown field: includ\n  in databricks.yml:4:1",
        }),
        resolveDatabricksCli: async () => ({
          ok: true,
          candidate: "databricks",
          versionOutput: "v0.295.0",
        }),
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.issues?.[0]?.code).toBe("BUNDLE_DIAGNOSTICS");
    expect(result.issues?.[0]?.diagnostics?.[0]).toMatchObject({
      severity: "warning",
      message: "unknown field: includ",
      path: "databricks.yml",
      line: 4,
      column: 1,
    });
  });

  test("tolerates auth errors when stdout contains valid JSON", async () => {
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
        resolveDatabricksCli: async () => ({
          ok: true,
          candidate: "databricks",
          versionOutput: "v0.295.0",
        }),
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.issues?.[0]?.code).toBe("AUTH_NOT_CONFIGURED");
  });

  test("treats non-zero exit with valid JSON as a CLI warning", async () => {
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
        resolveDatabricksCli: async () => ({
          ok: true,
          candidate: "databricks",
          versionOutput: "v0.295.0",
        }),
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.issues?.[0]?.code).toBe("CLI_WARNING");
  });

  test("maps ETIMEDOUT to a timeout error", async () => {
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
        resolveDatabricksCli: async () => ({
          ok: true,
          candidate: "databricks",
          versionOutput: "v0.295.0",
        }),
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.errorCode).toBe("VALIDATION_TIMEOUT");
  });

  test("returns validation failure when stdout is not valid JSON", async () => {
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
        resolveDatabricksCli: async () => ({
          ok: true,
          candidate: "databricks",
          versionOutput: "v0.295.0",
        }),
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.errorCode).toBe("VALIDATION_FAILED");
    expect(result.error.details ?? "").toMatch(/json parse failed/);
  });
});
