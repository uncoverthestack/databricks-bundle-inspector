import path from "node:path";
import { validateBundle, extractBundleGraph } from "./validateBundle.js";

async function main() {
  const bundleDirArg = process.argv[2];
  const target = process.argv[3];

  if (!bundleDirArg) {
    console.error("Usage: tsx run.ts <bundleDir> [target]");
    process.exit(1);
  }

  const bundleDir = path.resolve(bundleDirArg);

  const result = await validateBundle(bundleDir, target);

  if (result.ok) {
    console.log(JSON.stringify(extractBundleGraph(result.data), null, 2));
  } else {
    console.error(JSON.stringify(result.error, null, 2));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
