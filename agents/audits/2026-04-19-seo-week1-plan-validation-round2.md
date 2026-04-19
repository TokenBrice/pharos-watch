# SEO Week 1 Plan Validation Round 2

Date: 2026-04-19

Plan reviewed: `agents/plans/2026-04-19-seo-week1-hygiene-schema.md`

Review mode: second read-only validation after the initial correction pass. Three gpt-5.4/xhigh plan-reviewer subagents reviewed:

- Cloudflare Pages/Functions and static route behavior
- Structured-data and SEO correctness
- Docs, verification commands, sequencing, and rollout safety

## Findings Applied

1. **Site-data live check used the wrong HTTP method.**
   - Finding: `curl -I` sends `HEAD`, but `functions/_site-data/[[path]].ts` accepts only `GET`.
   - Plan correction: Task 11 now uses `curl -sS -o /dev/null -w "%{http_code}\n" ...` and expects `200`.

2. **Taxonomy axis parent hubs still lacked inbound links.**
   - Finding: `/stablecoins/` rendered child cohort links but did not link to `/stablecoins/backing/`, `/stablecoins/governance/`, or `/stablecoins/infrastructure/`.
   - Plan correction: Task 6 now requires each axis card title to be a real `Link` to `axis.href`, plus the footer link to `/stablecoins/`.

3. **Task 6 and Task 3 sequencing was still ambiguous.**
   - Finding: Task 6 snippets use `breadcrumbItems`, which requires Task 3's `FeaturePageShell` prop update.
   - Plan correction: Commit grouping and task notes now require a combined Task 3 + Task 6 commit with shared breadcrumb API first, hub files second, deep callsites third. Task 6 verification is explicitly after both tasks are applied.

4. **Pages Function header tests were too optional.**
   - Finding: The plan changed tested Pages Function behavior but did not require test assertions.
   - Plan correction: Task 13 now includes `functions/__tests__/admin-host-gate.test.ts` and `functions/__tests__/ops-admin-proxy.test.ts` as modified files and requires `X-Robots-Tag` assertions.

5. **Docs scope missed the docs route index.**
   - Finding: new taxonomy parent routes should update `docs/README.md`, not only `docs/architecture.md`.
   - Plan correction: Task 15 now includes `docs/README.md`.

6. **Robots operator disallows missed no-trailing-slash variants.**
   - Finding: `/admin` and `/api/admin` are operator surfaces too.
   - Plan correction: Task 10 now disallows `/admin`, `/admin/`, `/api/admin`, and `/api/admin/`.

7. **Dataset provenance fields were semantically unsafe.**
   - Finding: Dataset `sameAs` should identify duplicate/canonical dataset descriptions; CoinGecko/DefiLlama/issuer links do not. `citation` and hardcoded `temporalCoverage` were also not defensible.
   - Plan correction: Task 11 now omits `sameAs`, `citation`, and `temporalCoverage` for Week 1 unless future implementation has verified dataset-specific values.

8. **Digest Article image should use the digest-specific asset.**
   - Finding: `/og-digest.png` is a better representative digest image than `/og-card.png`.
   - Plan correction: Task 5 now uses `/og-digest.png` for Article JSON-LD and instructs OpenGraph/Twitter detail metadata to match.

9. **Rollback ordering did not match commit grouping.**
   - Finding: rollback list was task-oriented while commit strategy groups several tasks.
   - Plan correction: rollback section now lists reverse commit groups.

## Remaining Status

Local consistency checks after applying the round-2 findings:

- `git diff --check -- agents/plans/2026-04-19-seo-week1-hygiene-schema.md agents/audits/2026-04-19-seo-week1-plan-verification.md` passed.
- Stale-claim grep checks found no remaining unsupported `_redirects` 404 instruction, no protected API Dataset distribution URL, no `curl -I` site-data check, and no "all 191 detail pages" Dataset assertion.

The plan is substantially stronger after this round. The implementation agent should still run the plan's own final verification, especially `npm run build`, `npm run seo:check`, JSON-LD parsing checks, and the targeted Pages Function tests.
