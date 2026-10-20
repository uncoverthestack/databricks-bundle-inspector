import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, test, expect, jest } from "@jest/globals";
import path from "node:path";
import {
  BUNDLE_PROBE_TARGET,
  validateBundleWithDependencies,
  MAX_CLI_OUTPUT_BYTES,
} from "../../../bundle/validateBundle.js";
import type { ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { bundleTempDir } from "../../../databricksCli/restrictedExecution.js";

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
  test("tells the CLI not to run code the bundle defines", async () => {
    let env: NodeJS.ProcessEnv | undefined;
    await validateBundleWithDependencies("/workspace/demo", undefined, {
      execFileAsync: async (_file, _args, options) => {
        env = options?.env;
        return { stdout: JSON.stringify(createBundle()), stderr: "" };
      },
      resolveDatabricksCli: async () => ({ ok: true, candidate: "databricks", versionOutput: undefined }),
    });

    expect(env?.DATABRICKS_BUNDLE_RESTRICTED_CODE_EXECUTION).toBe("1");
    expect(env?.DATABRICKS_BUNDLE_ROOT).toBe(path.resolve("/workspace/demo"));
    expect(env?.BUNDLE_ROOT).toBe(path.resolve("/workspace/demo"));
    expect(env?.DATABRICKS_BUNDLE_TMP).toBe(bundleTempDir("/workspace/demo"));
    // Check pass-through without dumping the process environment if an assertion fails.
    // On Windows PATH is spelled "Path".
    const overridden = new Set([
      "DATABRICKS_BUNDLE_RESTRICTED_CODE_EXECUTION", "DATABRICKS_BUNDLE_TMP",
      "DATABRICKS_BUNDLE_ROOT", "BUNDLE_ROOT",
    ]);
    for (const key of Object.keys(process.env)) {
      if (!overridden.has(key)) expect(env?.[key] === process.env[key]).toBe(true);
    }
  });

  test("tells the CLI to keep its working files outside the bundle folder", async () => {
    const tempDirs: string[] = [];
    for (const bundleDir of ["/workspace/demo", "/workspace/demo", "/workspace/other"]) {
      await validateBundleWithDependencies(bundleDir, "dev", {
        execFileAsync: async (_file, _args, options) => {
          tempDirs.push(options?.env?.DATABRICKS_BUNDLE_TMP ?? "");
          return { stdout: JSON.stringify(createBundle()), stderr: "" };
        },
        resolveDatabricksCli: async () => ({ ok: true, candidate: "databricks", versionOutput: undefined }),
      });
    }

    const [first, again, other] = tempDirs;
    expect(first).toBeTruthy();
    // The same folder for the same bundle, another for another bundle.
    expect(again).toBe(first);
    expect(other).not.toBe(first);
    for (const dir of tempDirs) {
      const fromBundle = path.relative(path.resolve("/workspace/demo"), dir);
      expect(fromBundle.startsWith("..") || path.isAbsolute(fromBundle)).toBe(true);
    }
  });

  describe("--profile", () => {
    async function argsFor(target: string | undefined, profile: string | undefined) {
      let args: string[] = [];
      await validateBundleWithDependencies(
        "/workspace/demo",
        target,
        {
          execFileAsync: async (_file, callArgs) => {
            args = callArgs;
            return { stdout: JSON.stringify(createBundle()), stderr: "" };
          },
          resolveDatabricksCli: async () => ({ ok: true, candidate: "databricks", versionOutput: undefined }),
        },
        profile,
      );
      return args;
    }

    test("is passed for a real target when a profile is set", async () => {
      expect(await argsFor("prod", " WORK ")).toEqual([
        "bundle", "validate", "--output", "json", "--target", "prod", "--profile", "WORK",
      ]);
    });

    test("is never passed for the structural preview", async () => {
      expect(await argsFor(undefined, "WORK")).not.toContain("--profile");
      expect(await argsFor(BUNDLE_PROBE_TARGET, "WORK")).not.toContain("--profile");
    });

    test("is not passed when no profile is set", async () => {
      expect(await argsFor("prod", undefined)).not.toContain("--profile");
      expect(await argsFor("prod", "  ")).not.toContain("--profile");
    });
  });

  test("returns CLI_NOT_FOUND when no CLI is resolved", async () => {
    const result = await validateBundleWithDependencies(
      "/workspace/demo",
      undefined,
      {
        execFileAsync: async () => ({ stdout: "", stderr: "" }),
        resolveDatabricksCli: async () => ({ ok: false, problem: "not_installed" }),
      },
    );

    expect(result.ok).toBe(false);

    if (result.ok) return;

    expect(result.error.errorCode).toBe("CLI_NOT_FOUND");
    expect(result.error.cliProblem).toBe("not_installed");
    expect(result.error.bundleName).toBe("demo");
  });

  test("names the cliPath setting when it is what failed", async () => {
    const result = await validateBundleWithDependencies("/workspace/demo", undefined, {
      execFileAsync: async () => ({ stdout: "", stderr: "" }),
      resolveDatabricksCli: async () => ({
        ok: false,
        problem: "configured_path_invalid",
        configuredPath: "/opt/wrong/databricks",
      }),
    });

    if (result.ok) throw new Error("expected failure");
    expect(result.error.cliProblem).toBe("configured_path_invalid");
    expect(result.error.error).toContain('cliPath setting ("/opt/wrong/databricks")');
  });

  test("says when the databricks on the PATH is another program", async () => {
    const result = await validateBundleWithDependencies("/workspace/demo", undefined, {
      execFileAsync: async () => ({ stdout: "", stderr: "" }),
      resolveDatabricksCli: async () => ({
        ok: false,
        problem: "not_databricks_cli",
        versionOutput: "databricks 2.1.0",
      }),
    });

    if (result.ok) throw new Error("expected failure");
    expect(result.error.cliProblem).toBe("not_databricks_cli");
    expect(result.error.cliVersionOutput).toBe("databricks 2.1.0");
    expect(result.error.error).toBe(
      'The "databricks" command on your PATH is not the Databricks CLI (it printed "databricks 2.1.0"). Install the Databricks CLI.',
    );
  });

  test("names the legacy pip package when that is what answered", async () => {
    const result = await validateBundleWithDependencies("/workspace/demo", undefined, {
      execFileAsync: async () => ({ stdout: "", stderr: "" }),
      resolveDatabricksCli: async () => ({
        ok: false,
        problem: "not_databricks_cli",
        versionOutput: "Version 0.18.0",
      }),
    });

    if (result.ok) throw new Error("expected failure");
    expect(result.error.error).toBe(
      'The "databricks" command on your PATH is the legacy databricks-cli pip package (0.18.0), which can\'t check bundles. Install the Databricks CLI.',
    );
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
        cwd: path.resolve("/workspace/demo"),
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
      stderr: "Error: cannot configure default credentials",
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
    expect(result.issues?.[0]?.diagnostics?.[0]?.severity).toBe("warning");
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

  // The CLI stops at its first error and still prints the bundle, with the target only
  // half applied, so the caller falls back to the structural preview.
  describe("a real target the CLI could not finish", () => {
    const failWith = (stderr: string) => {
      jest.spyOn(console, "warn").mockImplementation(() => {});
      return validateBundleWithDependencies("/workspace/demo", "dev", {
        execFileAsync: async () => {
          throw Object.assign(new Error("exit status 1"), {
            stderr,
            stdout: JSON.stringify(createBundle()),
          });
        },
        resolveDatabricksCli: async () => ({ ok: true, candidate: "databricks", versionOutput: "v0.295.0" }),
      });
    };

    test("fails without a login, even though the CLI printed a bundle", async () => {
      const result = await failWith("Error: cannot configure default credentials, please check the docs");

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.errorCode).toBe("AUTH_NOT_CONFIGURED");
      expect(result.error.details).toContain("cannot configure default credentials");
    });

    test("fails on any other CLI error, with the CLI's message as the reason", async () => {
      const result = await failWith(
        "Error: cannot resolve bundle auth configuration: profile NO_SUCH_PROFILE_E2E not found",
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.errorCode).toBe("VALIDATION_FAILED");
      expect(result.error.details).toContain("profile NO_SUCH_PROFILE_E2E not found");
    });
  });

  test("does not warn for expected probe target failure with valid JSON", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const debugSpy = jest.spyOn(console, "debug").mockImplementation(() => {});
    const error = Object.assign(new Error("probe target failed"), {
      stderr: `Error: ${BUNDLE_PROBE_TARGET}: no such target. Available targets: dev`,
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

    expect(result.issues).toBeUndefined();
    expect(result.targetOptions).toEqual(["dev"]);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith(
      "[validateBundle] probe target unavailable; parsing stdout",
      expect.objectContaining({
        cliPath: "databricks",
        bundleDir: path.resolve("/workspace/demo"),
        target: BUNDLE_PROBE_TARGET,
      }),
    );

    warnSpy.mockRestore();
    debugSpy.mockRestore();
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

  test("does not surface raw command text for probe target only failures", async () => {
    const error = Object.assign(
      new Error(
        `Command failed: databricks bundle validate --output json --target ${BUNDLE_PROBE_TARGET}\nError: ${BUNDLE_PROBE_TARGET}: no such target. Available targets: dev, prod`,
      ),
      {
        stderr: `Error: ${BUNDLE_PROBE_TARGET}: no such target. Available targets: dev, prod`,
        stdout: "",
      },
    );

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
    expect(result.error.error).toBe("Failed to validate Databricks bundle.");
    expect(result.error.details).toBeUndefined();
  });
});

describe("validateBundleWithDependencies: large output and time limits", () => {
  const cli = async () => ({ ok: true as const, candidate: "databricks", versionOutput: undefined });

  test("allows far more than Node's 1 MiB default, but a bounded amount", async () => {
    let maxBuffer: number | undefined;
    await validateBundleWithDependencies("/workspace/demo", undefined, {
      execFileAsync: async (_file, _args, options) => {
        maxBuffer = options?.maxBuffer;
        return { stdout: JSON.stringify(createBundle()), stderr: "" };
      },
      resolveDatabricksCli: cli,
    });
    expect(maxBuffer).toBe(MAX_CLI_OUTPUT_BYTES);
    expect(MAX_CLI_OUTPUT_BYTES).toBeGreaterThanOrEqual(16 * 1024 * 1024);
  });

  test("says the output was too large, instead of a generic failure", async () => {
    // A real child that prints more than the limit allows.
    const run = promisify(execFile);
    const result = await validateBundleWithDependencies("/workspace/demo", undefined, {
      execFileAsync: (_file, _args, options) =>
        run(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096))"], { ...options, cwd: undefined, maxBuffer: 1024 }),
      resolveDatabricksCli: cli,
    });
    expect(result.ok ? undefined : result.error.errorCode).toBe("VALIDATION_OUTPUT_TOO_LARGE");
  });

  test("a CLI stopped at the time limit is a timeout, not a generic failure", async () => {
    // execFile kills a child at its timeout: the error has `killed`, not ETIMEDOUT.
    const run = promisify(execFile);
    const result = await validateBundleWithDependencies("/workspace/demo", undefined, {
      execFileAsync: (_file, _args, options) =>
        run(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { ...options, cwd: undefined, timeout: 100 }),
      resolveDatabricksCli: cli,
    });
    expect(result.ok ? undefined : result.error.errorCode).toBe("VALIDATION_TIMEOUT");
  });
});
