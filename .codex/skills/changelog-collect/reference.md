## Changelog Collection — Extended Reference

Editorial models for the weekly entry. Output path, barrel generation, rendering and the commit cap are owned by [Blog Publishing §Changelog](../../../docs/process/blog-publishing.md#changelog).

### Noise filter

The filter removes work with no reader-visible effect so it cannot bury real signal or skew the clusters. Judge by what the commit changed, not its prefix:

| Drop from analysis and manifest | Keep |
| --- | --- |
| `chore(generated):` and other regenerated-artifact refreshes | `test:` commits that add coverage for shipped behaviour |
| Dependency bumps (`chore(deps):`) | `docs:` commits that publish or change a methodology, policy or public page |
| `[skip ci]` commits | `fix(ci):` commits that repair a release, deploy or data-publication path |
| Baseline, ratchet and test-corpus budget churn (compacting, retiring or re-pinning tests to fit a ceiling) | `chore:` commits that remove or change a user-visible surface |
| Doc-sync-only and documentation-cleanup churn | |
| Reverts paired with their re-landing | |

### Cluster themes

Look for natural themes:

- Coverage / data expansion (new stablecoins, reserve adapters, chain support)
- Pipeline / sync reliability (cron, `sync-*`, fetch hardening)
- Risk tooling / scoring (PSI, DEWS, Safety Score, Liquidity Score, blacklist)
- UI / UX improvements
- Infrastructure / CI / deploys
- Testing / quality
- Documentation
- Methodology version bumps: one summary item per lane whose version moved, labelled with the lane and its new version (for example `Pricing 6.90`)

### Milestone signals — additional patterns

- **Live-reserve adapter additions**: `feat(reserves): add … adapter` / `promote … to live` / `enable live reserves for …`. Aggregate and cite the new total if material.
- **Audit / remediation series**: mentions of `audit`, `remediation`, `tranche`, `phase \d`. Usually a single "Codebase hardening" (`security`) cluster.
- **Auth / security milestones**: `auth`, `JWT`, `JWKS`, `api-keys`, `pepper`. Use `security` tag.

### Headline reference models

- "Supporter API keys now use contract-keyed donation eligibility."
- "Upcoming launch deadlines now expire on the browser clock."
- "Reserve reviews distinguish missing disclosures from reviewed absence."

### Summary href routes

`summary[].href` accepts any internal route in `PUBLIC_ROUTE_PATHS` (`src/lib/public-route-inventory.ts`); external or unknown routes fail `check:editorial-content`. Link the methodology changelog for a methodology item and the owning public page (for example `/api/`, `/cemetery/`, `/compliance/`, `/status/`) for a product item. List the methodology changelog routes from their source; the source file wins:

```bash
rg -n "CHANGELOG_PATH" shared/lib/methodology-versions/constants.ts
```

Non-obvious name mappings: Safety Score → `scoring-changelog`; PegScore / DEWS / depeg events → `depeg-changelog`; DDR verdicts → `depeg-resolver-changelog`; PSI → `stability-index-changelog`. General overview → `/methodology/`.

### Quality guidelines

- Summary bullets read like a product update, not a git log. User-facing impact first.
- Field Notes reads like a short editor's note: interpretive, specific, and grounded in the shipped work.
- Prefer combining over enumeration: "Telegram delivery hardened (rate-limit handling, HTML repair, retry cap)" beats listing each fix.
- Labels are noun phrases, parallel in structure.
- Headlines name shipped features with concrete numbers when available.
