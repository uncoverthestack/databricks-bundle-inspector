import { exec } from "child_process";

export function extractVersion(text: string): string | null {
  const match = text.match(/\bv?(\d+\.\d+\.\d+)\b/);
  return match ? match[1] : null;
}

export function runDatabricksVersionCommand(): Promise<string> {
  return new Promise((resolve, reject) => {
    exec("databricks --version", (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }

      if (stderr) {
        reject(new Error(stderr));
        return;
      }

      resolve(stdout.trim());
    });
  });
}

export async function getDatabricksCliVersion(): Promise<string | null> {
  const output = await runDatabricksVersionCommand();
  return extractVersion(output);
}
