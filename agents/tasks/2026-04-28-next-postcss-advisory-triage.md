# Next/PostCSS Advisory Triage

Date: 2026-04-28

## Finding

`npm audit --json --audit-level=low` reports GHSA-qx2v-qp2m-jg93 / npm advisory `1117015` for PostCSS CSS stringify output. The affected installed path is:

- `next@16.2.4 -> postcss@8.4.31`

The root toolchain paths are not on the vulnerable version:

- `@tailwindcss/postcss@4.2.2 -> postcss@8.5.10`
- `vite@8.0.8 -> postcss@8.5.10`
- `madge` parser dependencies -> `postcss@8.5.10`

## Current Package Context

- `next`: current `16.2.4`
- `npm view next version`: `16.2.4`
- `npm outdated --json`: no newer Next.js version is available
- `npm audit` suggested fix: `next@9.3.3`, which is a major downgrade and not applicable to this Next 16 static export app

## Reachability Assessment

The dashboard builds a static Next.js export for Cloudflare Pages. The vulnerable PostCSS copy is vendored under Next and is used during local/CI build tooling, not as a request-time dependency in the exported Pages artifact or the Cloudflare Worker API. The app does not expose a route that accepts user-supplied CSS and sends it through Next's vendored PostCSS stringifier at runtime.

The reachable root PostCSS users in the current dependency tree resolve to `postcss@8.5.10`, which is outside the advisory range `<8.5.10`.

## Decision

Risk accepted for now. Do not add an override or force a dependency update in this remediation package.

Rationale:

- The vulnerable copy is nested under the latest supported Next release available today.
- The advisory path appears limited to build-time/static-export tooling for this app.
- Forcing an override inside Next's vendored dependency has not been proven safe with Next 16.
- Routine dependency updates are intentionally out of scope for A6.

## Follow-Up

Revisit by 2026-05-28, or sooner if a Next.js 16 patch release updates the vendored PostCSS to `8.5.10` or later. At that point, prefer the supported Next patch over an npm override.
