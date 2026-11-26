// JSON with object keys sorted, so the same value always gives the same text and
// checksum. Used by the fixture recorder (update-validated-bundle-fixture.mjs) to stamp
// each recorded validated-bundle.json, and by the tests that check those stamps.
// CommonJS, so both the .mjs scripts and the TypeScript tests can import it.
const { createHash } = require("node:crypto");

/** @param {unknown} value @returns {string} */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** @param {unknown} value @returns {string} */
function canonicalJsonSha256(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

module.exports = { canonicalJson, canonicalJsonSha256 };
