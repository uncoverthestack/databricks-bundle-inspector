# Telemetry proxy

A Cloudflare Worker that sits between the extension and PostHog:

```
extension ──POST /e──► this Worker (holds the PostHog key) ──► PostHog
```

- The PostHog key is stored only as a Worker secret. It never ships in the extension.
- Events are checked against `src/telemetry/schema.ts`. Unknown events, unknown properties and invalid values are dropped.
- Each client IP is limited to 60 requests per minute, and batches to 50 events and 64 KB.

The request handling lives in `src/telemetry/proxy.ts` and is covered by `npm run test:unit`.

## Deploy

You need a Cloudflare account (the free plan is enough) and a PostHog project.

```sh
cd telemetry-proxy
npx wrangler login
npx wrangler secret put POSTHOG_API_KEY   # paste the PostHog project key (phc_…)
npx wrangler deploy
```

`deploy` prints the Worker URL, for example
`https://databricks-bundle-inspector-telemetry.<account>.workers.dev`.
Set `TELEMETRY_ENDPOINT` in `src/telemetry/config.ts` to that URL plus `/e`, then release the extension.

## Rotating the PostHog key

Run `npx wrangler secret put POSTHOG_API_KEY` again. No extension release is needed.

## Changing events

Update `src/telemetry/schema.ts` and `telemetry.json` together (a unit test checks they match), then redeploy the Worker **before** releasing the extension. Otherwise the Worker drops the new events.
