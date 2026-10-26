# Dependency review — 24 October 2026

Official npm registry audit metadata was checked for both dependency trees. This
is a dependency/advisory assessment, not a penetration test or a claim that the
application is vulnerability-free. Audit counts can change as metadata changes;
transitive effects can count several package nodes for one underlying issue.

## Changes

- Root development MCP SDK: **1.30.0 → 1.32.2**, retaining an exact pin.
- Nested record-cycle server MCP SDK: **1.30.0 → 1.32.2**, manifest minimum
  `^1.32.2`, exact installed version recorded in its lockfile.
- Compatible nested transitive refresh: `body-parser` 2.3.0 → 2.4.0,
  `fast-uri` 3.1.7 → 3.1.9, `hono` 4.13.5 → 4.13.13,
  `ip-address` 10.7.0 → 10.7.4, `proxy-addr` 2.0.7 → 2.0.8,
  `zod` 4.5.4 → 4.6.7 (and associated compatible dependency resolution).
- No force upgrade, lifecycle install scripts or override of pi's upstream pin.

Before refresh, this audit reported root **7 affected package nodes** (6 high,
1 moderate) and nested MCP **13** (2 critical, 5 high, 6 moderate). After refresh:
**nested MCP zero reported advisories**; root **2 affected package nodes**
(1 high, 1 moderate), both from the remaining development-only dependency below.

## Reachability matters

The record server imports SDK `Server`, `StdioServerTransport` and request
schemas. It exposes a local stdio record tool, not an HTTP listener, OAuth
client/server, experimental task service, Express proxy-trust configuration or
Hono static/JSX renderer. The critical
[proxy-addr spoofing advisory](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)
therefore describes a dormant HTTP dependency path here, not demonstrated
remote exploitation of this harness. It was nevertheless removed by the refresh.

SDK advisories included OAuth/redirect/token/task handling and validation memory
exhaustion. The shared schema/validation code is relevant to stdio too:
[Zod collection exhaustion](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)
and the [SDK validation advisory](https://github.com/advisories/GHSA-46jr-4wx8-v453)
were reasons to update rather than dismiss every finding as HTTP-only. No
exploitability proof or hostile-input containment guarantee is inferred from
this source-level reachability review.

## Remaining development dependency

`@earendil-works/pi-coding-agent@1.4.0` explicitly pins **`undici@8.10.2`**.
The affected range is `>=8.0.0 <8.12.2`; official registry version 8.12.2 exists.
Remaining advisories:

| Advisory | Severity | Condition |
|---|---|---|
| [GHSA-4qv8-2p9j-2685](https://github.com/advisories/GHSA-4qv8-2p9j-2685) | Moderate | Unbounded memory in EventSource parser |
| [GHSA-f72v-6w45-q472](https://github.com/advisories/GHSA-f72v-6w45-q472) | Moderate | Subresource-integrity bypass through algorithm token casing |
| [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c) | High | Unhandled error on excessive HTTP content encodings |

Root pi is a **development dependency** for type checking and extension-host
fixtures. The core engine/CLI has no runtime npm dependencies; the nested MCP
production tree does not include this undici dependency. Offline tests do not
exercise authenticated provider HTTP traffic. This narrows exposure, but is not
proof that developer tooling can never reach vulnerable code.

An override would break an upstream exact dependency contract; none was applied.
`npm audit fix --force` proposed a different pi release line, not a safe routine
patch. Prefer a compatible upstream pi update when available, or separately
review and authorize an override with regression testing. Updating this checkout
also does **not** update any user's independently installed pi CLI.

## Verification

```sh
npm audit --json
npm audit --json --prefix extensions/mcp/record-cycle-server
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix extensions/mcp/record-cycle-server
npm test
npm run check
node bin/jay-pi.mjs demo --json
git diff --check
```

The dependency refresh is tested with local fixtures and real MCP stdio, not
live models/accounts. See [verification](verification.md) for final test counts.
