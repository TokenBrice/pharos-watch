# Feature Flags

Feature flags gate the riskiest of the May 2026 detail-page changes. All default to off.

To enable locally: `NEXT_PUBLIC_PHAROS_<NAME>=true npm run dev`.

To enable in prod: set the env var in Cloudflare Pages settings.

Implementation lives in `src/lib/feature-flags.ts`. The flags are read at usage sites by name; they are intentionally not registered in any `.env` file or `next.config.*`.

## Flags

| Flag | Gates | Default | How to enable | Linked plan section |
| --- | --- | --- | --- | --- |
| `NEXT_PUBLIC_PHAROS_HERO_VERDICT` | Idea 1 (hero `oneLiner` verdict + AI-summary TL;DR promotion) | off | `NEXT_PUBLIC_PHAROS_HERO_VERDICT=true npm run dev` or Cloudflare Pages env | Wave 2, Idea 1 |
| `NEXT_PUBLIC_PHAROS_BLACKLIST_BANNER` | Idea 13b (recent blacklist banner) | off | `NEXT_PUBLIC_PHAROS_BLACKLIST_BANNER=true npm run dev` or Cloudflare Pages env | Wave 2, Idea 13b |
| `NEXT_PUBLIC_PHAROS_QUIET_DEVIATIONS` | Idea 19 severity-color threshold (quiet calm deviations + magnitude-aware mcap delta) | off | `NEXT_PUBLIC_PHAROS_QUIET_DEVIATIONS=true npm run dev` or Cloudflare Pages env | Wave 1, Idea 19 |
| `NEXT_PUBLIC_PHAROS_MOBILE_STICKY_SUMMARY` | Idea 20b (mobile sticky compact summary) | off | `NEXT_PUBLIC_PHAROS_MOBILE_STICKY_SUMMARY=true npm run dev` or Cloudflare Pages env | Wave 5, Idea 20b |
| `NEXT_PUBLIC_PHAROS_LAZY_CHARTS` | Idea 20c (lazy-mount charts) | off | `NEXT_PUBLIC_PHAROS_LAZY_CHARTS=true npm run dev` or Cloudflare Pages env | Wave 5, Idea 20c |
| `NEXT_PUBLIC_PHAROS_CHART_ANNOTATIONS` | Idea 4 (event-annotated charts) | off | `NEXT_PUBLIC_PHAROS_CHART_ANNOTATIONS=true npm run dev` or Cloudflare Pages env | Wave 6, Idea 4 |

## Spec source

Spec, success criteria, and per-idea steps live in the plan file:
`agents/stablecoin-detail-improvements-plan-2026-05-15.md`.

(That path is local-scratch under `/agents/` per `docs/process/agent-artifacts.md`; in production the durable spec would live under `docs/process/`. The flag table above is the durable reference once the plan is consumed.)
