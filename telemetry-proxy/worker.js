// Cloudflare Worker entry. The logic lives in src/telemetry/proxy.ts so it is
// unit-tested with the rest of the extension; wrangler bundles it on deploy.
import { handleTelemetryRequest } from "../src/telemetry/proxy.js";

export default {
  /** @param {Request} request @param {import("../src/telemetry/proxy.js").ProxyEnv} env */
  fetch(request, env) {
    return handleTelemetryRequest(request, env);
  },
};
