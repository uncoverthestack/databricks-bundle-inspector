import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export function extractVersion(text: string): string | null {
  const match = text.match(/\bv?(\d+\.\d+\.\d+)\b/);
  return match ? match[1] : null;
}

export async function runDatabricksVersionCommand(): Promise<string> {
  const { stdout, stderr } = await execAsync("databricks --version");
  return `${stdout}\n${stderr}`.trim();
}

export async function getDatabricksCliVersion(): Promise<string | null> {
  const output = await runDatabricksVersionCommand();
  return extractVersion(output);
}
