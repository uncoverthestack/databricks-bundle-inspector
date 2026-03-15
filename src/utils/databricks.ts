import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export class DatabricksCliUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabricksCliUnavailableError";
  }
}

export function extractVersion(text: string): string | null {
  const match = text.match(/\bv?(\d+\.\d+\.\d+)\b/);
  return match ? match[1] : null;
}

export async function runDatabricksVersionCommand(): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync("databricks --version");
    return `${stdout}\n${stderr}`.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabricksCliUnavailableError(
      `Failed to run 'databricks --version': ${message}`,
    );
  }
}

export async function getDatabricksCliVersion(): Promise<string> {
  const output = await runDatabricksVersionCommand();
  const version = extractVersion(output);

  if (!version) {
    throw new DatabricksCliUnavailableError(
      `Unable to detect Databricks CLI version from output: ${output}`,
    );
  }

  return version;
}
