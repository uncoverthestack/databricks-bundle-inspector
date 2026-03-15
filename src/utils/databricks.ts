import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export class DatabricksCliCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabricksCliCommandError";
  }
}

export class DatabricksCliVersionParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabricksCliVersionParseError";
  }
}

export function extractVersion(text: string): string | null {
  const match = text.match(/\bv?(\d+\.\d+\.\d+)\b/);
  return match ? match[1] : null;
}

export async function runCommand(command: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(command);
    return `${stdout}\n${stderr}`.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DatabricksCliCommandError(
      `Failed to run '${command}': ${message}`,
    );
  }
}

export async function getDatabricksCliVersion(
  runner: (command: string) => Promise<string> = runCommand,
): Promise<string> {
  const output = await runner("databricks --version");
  const version = extractVersion(output);

  if (!version) {
    throw new DatabricksCliVersionParseError(
      `Unable to parse Databricks CLI version from output: ${output}`,
    );
  }

  return version;
}
