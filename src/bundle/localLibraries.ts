import { existsSync } from "node:fs";
import path from "node:path";
import { globSync, hasGlobCharacters } from "./goGlob.js";

/**
 * Local library files as `bundle deploy` reads them (CLI v1.27.0, bundle/libraries): task
 * `whl` and `jar` paths and job environment dependencies. Deploy expands globs and checks
 * each file after building artifacts, failing with "file doesn't exist" or "no files match
 * pattern" (#482, #525). `bundle validate` checks none of this.
 */

// PEP 440 version, as the CLI's pep440Regex (local_path.go).
const PEP440 =
  String.raw`(\d+!)?(\d+(\.\d+)*)([-_.]?(a|b|rc)\d+)?([-_.]?post\d+)?([-_.]?dev\d+)?(\+[a-zA-Z0-9]+([-_.][a-zA-Z0-9]+)*)?`;
const PACKAGE = new RegExp(String.raw`^[a-zA-Z0-9\-_]+\s?(\[.*\])?\s?((==|!=|<=|>=|~=|>|<)\s?${PEP440}(\.\*)?,?)*$`);
const PIP_FLAG = /(^|\s+)--?[a-zA-Z0-9-]+(([\s|=]+)|$)/;
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Whether an environment dependency is a local file to the CLI (`IsLibraryLocal`): one
 * starting with `.`, or anything that isn't a pip flag, a package name, a URL lookup
 * (`name @ url`), a URI or an absolute path. `-r` and `-e` paths are handled elsewhere by
 * the CLI; a missing requirements file already fails `bundle validate`.
 */
export function isLocalDependency(dependency: string): boolean {
  if (!dependency) return false;
  if (dependency.startsWith(".")) return true;
  if (PIP_FLAG.test(dependency)) return false;
  if (PACKAGE.test(dependency) || dependency.split(" @ ").length === 2) return false;
  const unquoted = dependency.replace(/^["']+|["']+$/g, "");
  return !unquoted.startsWith("/") && !SCHEME.test(unquoted);
}

/** `./dist/a.whl[extra]` without its extras, which the CLI strips before matching. */
export function withoutWheelExtras(dependency: string): string {
  return dependency.replace(/(\.whl)\[[^\]]*\]$/i, "$1");
}

/**
 * Where a local library path points from `baseDir`, and whether a file is there. A glob
 * (`../dist/*.whl`) exists when at least one file matches it, with Go's rules, as deploy
 * expands it. Letter case is not compared: the CLI uploads the file it finds locally.
 */
export function localLibrary(rawPath: string, baseDir: string): { resolvedPath: string; exists: boolean } {
  const resolvedPath = path.resolve(baseDir, rawPath);
  if (!hasGlobCharacters(rawPath)) return { resolvedPath, exists: existsSync(resolvedPath) };
  return { resolvedPath, exists: (globSync(baseDir, rawPath)?.length ?? 0) > 0 };
}

/** Folders that deploy may write library files to before it checks them (see {@link buildOutputs}). */
export interface BuildOutputs {
  /** Folders an artifact builds into: a library missing there may be built at deploy. */
  folders: string[];
  /** A build whose output can't be told (a build script, an artifact without `files`): any library may be built. */
  anywhere: boolean;
}

/**
 * The folders `bundle deploy` may build library files into before it checks them
 * (CLI v1.27.0, artifacts/prepare.go and phases/build.go):
 *
 * - the `files[].source` folders of an artifact with a `build`, or of a `tgz` the CLI
 *   builds from `include` or `git`; `files` without a build are already there;
 * - a `whl` artifact without `files`: `<path>/dist`, with `path` the bundle root unless set;
 * - no `artifacts` and a `setup.py` in the bundle root: `<bundle root>/dist`;
 * - a `preinit`, `prebuild` or `postbuild` hook in `experimental.scripts`, or an artifact
 *   with a build and no files, could write anything: {@link BuildOutputs.anywhere}.
 *
 * @param definedIn The folder of the YAML file that defines an artifact, for relative paths.
 *   A real target gives them absolute already.
 */
export function buildOutputs(
  config: { artifacts?: unknown; experimental?: unknown },
  bundleRoot: string,
  definedIn: (name: string) => string,
): BuildOutputs {
  const record = (value: unknown) =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  const folders: string[] = [];
  // Build hooks are `experimental.scripts`, plain commands. Top-level `scripts` are only
  // run by `bundle run`, never by deploy (CLI scripts.go getCommand).
  const hooks = record(record(config.experimental)?.scripts);
  let anywhere = ["preinit", "prebuild", "postbuild"].some((name) => {
    const command = hooks?.[name];
    return typeof command === "string" && command.trim() !== "";
  });
  const artifacts = record(config.artifacts);
  if (!artifacts) {
    if (existsSync(path.join(bundleRoot, "setup.py"))) folders.push(path.join(bundleRoot, "dist"));
    return { folders, anywhere };
  }
  for (const [name, value] of Object.entries(artifacts)) {
    const artifact = record(value);
    if (!artifact) continue;
    const dir = definedIn(name);
    const builds = typeof artifact.build === "string" && artifact.build.trim() !== "";
    // A tgz with `include` or `git` is built by the CLI itself.
    const native = artifact.type === "tgz" && ((Array.isArray(artifact.include) && artifact.include.length > 0) || artifact.git !== undefined);
    const files = Array.isArray(artifact.files) ? artifact.files : [];
    const sources = files.map((file) => record(file)?.source).filter((source): source is string => typeof source === "string");
    if (sources.length > 0) {
      // Files without a build are already there: nothing writes them at deploy.
      if (!builds && !native) continue;
      for (const source of sources) {
        const folder = path.dirname(path.resolve(dir, source));
        if (hasGlobCharacters(folder) || source.includes("${")) anywhere = true;
        else folders.push(folder);
      }
    } else if (artifact.type === "whl") {
      // Built with "setup.py bdist_wheel" unless `build` says otherwise, into <path>/dist.
      // `path` is the bundle root unless set, else read from the defining file's folder.
      const base = typeof artifact.path === "string" && artifact.path ? path.resolve(dir, artifact.path) : bundleRoot;
      if (base.includes("${")) anywhere = true;
      else folders.push(path.join(base, "dist"));
    } else if (builds) {
      anywhere = true;
    }
  }
  return { folders, anywhere };
}

/** Whether deploy may build `resolvedPath` before checking it, so a missing file there is no finding. */
export function mayBeBuilt(resolvedPath: string, outputs: BuildOutputs | undefined): boolean {
  if (!outputs) return false;
  return outputs.anywhere || outputs.folders.includes(path.dirname(resolvedPath));
}
