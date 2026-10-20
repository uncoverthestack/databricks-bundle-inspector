import { parseArgs } from "node:util";

export const suites = ["cliNotFound", "includeMistakes", "issueCodes", "resourceFiles", "graphRefresh", "alwaysOn", "savedFile", "targets"] as const;

export function requireSuite(value: string): typeof suites[number] {
  const suite = suites.find(suite => suite === value);
  if (!suite) throw new Error(`Unknown e2e suite "${value}". Known suites: ${suites.join(", ")}`);
  return suite;
}

export function readOptions(args: string[], env: NodeJS.ProcessEnv) {
  const { values } = parseArgs({
    args,
    options: {
      suite: { type: "string" },
      fixture: { type: "string" },
      "folder-case": { type: "string" },
      "pause-ms": { type: "string" },
      profile: { type: "string" },
    },
  });
  const suite = requireSuite(values.suite ?? env.E2E_SUITE ?? "cliNotFound");
  const folderCase = values["folder-case"] ?? env.E2E_FOLDER_CASE;
  if (folderCase !== undefined && folderCase !== "other") {
    throw new Error('Expected --folder-case to be "other".');
  }
  const pauseMs = values["pause-ms"] ?? env.E2E_PAUSE_MS ?? "0";
  if (!/^\d+$/.test(pauseMs) || !Number.isSafeInteger(Number(pauseMs))) {
    throw new Error("Expected --pause-ms to be a non-negative integer.");
  }
  return {
    suite,
    fixture: values.fixture ?? env.E2E_FIXTURE ?? "src/test/e2e/fixtures/bundle",
    folderCase,
    pauseMs,
    profile: values.profile ?? env.INSPECTOR_TEST_PROFILE,
  };
}
