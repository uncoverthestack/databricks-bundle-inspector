#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";

const require = createRequire(import.meta.url);

function packageVersion(packageName) {
  return require(`${packageName}/package.json`).version;
}

function packageExists(packageName) {
  try {
    require.resolve(packageName);
    return true;
  } catch {
    return false;
  }
}

function linuxLibc() {
  const report = process.report?.getReport?.();
  return report?.header?.glibcVersionRuntime ? "gnu" : "musl";
}

function nativePackages() {
  const platform = os.platform();
  const arch = os.arch();
  const rolldownVersion = packageVersion("rolldown");
  const unrsVersion = packageVersion("unrs-resolver");

  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) {
    return [
      `@rolldown/binding-darwin-${arch}@${rolldownVersion}`,
      `@unrs/resolver-binding-darwin-${arch}@${unrsVersion}`,
    ];
  }

  if (platform === "linux") {
    const libc = linuxLibc();
    const rolldownArch =
      arch === "x64"
        ? `x64-${libc}`
        : arch === "arm64"
          ? `arm64-${libc}`
          : undefined;
    const unrsArch =
      arch === "x64"
        ? `x64-${libc}`
        : arch === "arm64"
          ? `arm64-${libc}`
          : arch === "arm"
            ? `arm-${libc}eabihf`
            : undefined;

    return [
      rolldownArch
        ? `@rolldown/binding-linux-${rolldownArch}@${rolldownVersion}`
        : undefined,
      unrsArch
        ? `@unrs/resolver-binding-linux-${unrsArch}@${unrsVersion}`
        : undefined,
    ].filter(Boolean);
  }

  if (platform === "win32" && (arch === "x64" || arch === "arm64")) {
    return [
      `@rolldown/binding-win32-${arch}-msvc@${rolldownVersion}`,
      `@unrs/resolver-binding-win32-${arch}-msvc@${unrsVersion}`,
    ];
  }

  return [];
}

const requiredPackages = nativePackages();
const missingPackages = requiredPackages.filter((specifier) => {
  const packageName = specifier.slice(0, specifier.lastIndexOf("@"));
  return !packageExists(packageName);
});

if (missingPackages.length === 0) {
  process.exit(0);
}

console.log(
  `[native-deps] Installing missing optional native packages: ${missingPackages.join(", ")}`,
);

const result = spawnSync(
  "npm",
  [
    "install",
    "--no-save",
    "--package-lock=false",
    "--ignore-scripts",
    ...missingPackages,
  ],
  { stdio: "inherit" },
);

process.exitCode = result.status ?? 1;
