import { describe, test, expect } from "@jest/globals";
import {
  BUNDLE_PROBE_TARGET,
  inspectBundleWithFallback,
} from "../../../bundle/validateBundle.js";
import type { BundleResult } from "../../../bundle/validateBundle.js";
import type { ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";

function makeOkResult(overrides: Partial<ParsedBundleConfig> = {}): BundleResult {
  return {
    ok: true,
    data: {
      bundle: { name: "demo-bundle" },
      resources: {},
      ...overrides,
    } as ParsedBundleConfig,
  };
}

function makeErrorResult(error: string, details?: string): BundleResult {
  return {
    ok: false,
    error: {
      bundleDir: "/workspace/demo",
      bundleName: "demo",
      error,
      ...(details ? { details } : {}),
    },
  };
}

describe("inspectBundleWithFallback", () => {
  test("probe mode when no target requested — single validate call, mode=probe", async () => {
    const calls: Array<string | undefined> = [];
    const validateFn = async (_dir: string, target?: string): Promise<BundleResult> => {
      calls.push(target);
      return makeOkResult();
    };

    const result = await inspectBundleWithFallback("/workspace/demo", undefined, validateFn);

    expect(result.inspectedTargetMode).toBe("probe");
    expect(result.inspectedTarget).toBe(BUNDLE_PROBE_TARGET);
    expect(result.fallbackMessage).toBeUndefined();
    expect(result.result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeUndefined();
  });

  test("target mode when target succeeds — single validate call, mode=target", async () => {
    const calls: Array<string | undefined> = [];
    const validateFn = async (_dir: string, target?: string): Promise<BundleResult> => {
      calls.push(target);
      return makeOkResult();
    };

    const result = await inspectBundleWithFallback("/workspace/demo", "dev", validateFn);

    expect(result.inspectedTargetMode).toBe("target");
    expect(result.inspectedTarget).toBe("dev");
    expect(result.fallbackMessage).toBeUndefined();
    expect(result.result.ok).toBe(true);
    expect(calls).toEqual(["dev"]);
  });

  test("falls back to probe when target validation fails", async () => {
    const calls: Array<string | undefined> = [];
    const validateFn = async (_dir: string, target?: string): Promise<BundleResult> => {
      calls.push(target);
      return target === "dev" ? makeErrorResult("auth failed") : makeOkResult();
    };

    const result = await inspectBundleWithFallback("/workspace/demo", "dev", validateFn);

    expect(result.inspectedTargetMode).toBe("probe");
    expect(result.inspectedTarget).toBe(BUNDLE_PROBE_TARGET);
    expect(result.result.ok).toBe(true);
    expect(calls).toEqual(["dev", undefined]);
  });

  test("fallbackMessage uses error.details when present", async () => {
    const validateFn = async (_dir: string, target?: string): Promise<BundleResult> => {
      if (target === "prod") return makeErrorResult("failed", "Databricks authentication is not configured.");
      return makeOkResult();
    };

    const result = await inspectBundleWithFallback("/workspace/demo", "prod", validateFn);

    expect(result.fallbackMessage).toBe("Databricks authentication is not configured.");
  });

  test("fallbackMessage falls back to error.error when details absent", async () => {
    const validateFn = async (_dir: string, target?: string): Promise<BundleResult> => {
      if (target === "prod") return makeErrorResult("target not found");
      return makeOkResult();
    };

    const result = await inspectBundleWithFallback("/workspace/demo", "prod", validateFn);

    expect(result.fallbackMessage).toBe("target not found");
  });

  test("no fallback when no target requested even if probe also fails", async () => {
    const validateFn = async (): Promise<BundleResult> =>
      makeErrorResult("CLI not found");

    const result = await inspectBundleWithFallback("/workspace/demo", undefined, validateFn);

    expect(result.inspectedTargetMode).toBe("probe");
    expect(result.fallbackMessage).toBeUndefined();
    expect(result.result.ok).toBe(false);
  });

  test("returns failed probe result when both target and fallback probe fail", async () => {
    const validateFn = async (): Promise<BundleResult> =>
      makeErrorResult("CLI not found");

    const result = await inspectBundleWithFallback("/workspace/demo", "dev", validateFn);

    expect(result.inspectedTargetMode).toBe("probe");
    expect(result.inspectedTarget).toBe(BUNDLE_PROBE_TARGET);
    expect(result.fallbackMessage).toBe("CLI not found");
    expect(result.result.ok).toBe(false);
  });
});
