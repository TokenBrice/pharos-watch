# /funding/ Public Release Plan

Date: 2026-04-20

## Assumptions

- "Take `/funding/` out of stealth" means the route becomes indexable, appears in normal site discovery surfaces, and is safe to share publicly.
- The release should keep the current static JSON-backed architecture. No Worker API, D1 table, cron, or donation automation is required for this release.
- This plan originally inventoried the stealth state and listed the work needed for a clean public launch. Implementation began after user confirmation on 2026-04-20.

## Success Criteria

- `/funding/` is reachable from normal product navigation and at least one persistent low-friction site surface.
- The generated HTML and Cloudflare Pages response headers no longer emit `noindex` or `nofollow` for `/funding/`.
- `/funding/` appears in `sitemap.xml` with a meaningful last-modified date.
- Public indexes that summarize Pharos routes, especially `/llms.txt`, include the funding page.
- Public copy is internally consistent about sustainability, paid API plans, and community support.
- Funding data is current, correctly classified, and link targets are verified before announcement.
- Route docs and architecture docs describe the public-release contract instead of the stealth contract.
- Relevant tests, lint, build, SEO, and merge-gate checks pass.

## Pre-Implementation State Inventory

- Route exists at `src/app/funding/page.tsx` and is static-export friendly.
- Page metadata currently sets `robots: { index: false, follow: false }` with the comment `stealth release - not indexed in v1`.
- `public/_headers` adds `X-Robots-Tag: noindex, nofollow` for `/funding/*`. This is an independent crawl blocker beyond Next metadata.
- `src/app/sitemap.ts` omits `/funding/` from the static sitemap.
- `src/lib/nav-config.ts` omits `/funding/`, so the desktop sidebar, mobile menu, and command palette do not expose it.
- `src/components/footer.tsx` omits `/funding/`.
- `scripts/generate-llms-txt.ts` omits `/funding/`.
- `docs/funding-page.md`, `docs/architecture.md`, and `docs/README.md` explicitly describe `/funding/` as noindex, nofollow, and absent from sitemap/nav.
- Existing tests cover funding helpers and page sections:
  - `shared/lib/funding/__tests__/helpers.test.ts`
  - `src/components/funding/__tests__/funding-page-sections.test.tsx`
- Existing nav tests in `src/lib/__tests__/nav-config.test.ts` will need updates if `/funding/` joins a nav group.
- Current checked-in funding data:
  - `shared/data/funding/costs.json`: 8 cost items, $1,709.01/month, reviewed 2026-04-18 11:09:34 UTC.
  - `shared/data/funding/donations.json`: 1 donation row, updated 2026-04-18 12:00:00 UTC.
  - The only donation is `tokenbrice.eth`, 0.1 ETH, $219.22, received 2026-04-13 09:30:47 UTC, currently marked `kind: "community"`.

## P0 Release Blockers

### 1. Confirm Data Integrity And Public Labels

- Run the `funding-update` workflow immediately before release so donation data is current.
- Confirm whether the existing `tokenbrice.eth` row should be public community support or a founder/self-funding row. If it is founder support, change `kind` to `"founder"` so the page does not inflate community funding.
- Verify `pharos-watch.eth` resolves to `0x5d698362EDb8AEa1C2b2483096BDeE3265D860DB`.
- Verify the Giveth project URL still resolves to the intended Pharos project and recurring donation path.
- Verify the supported direct-donation chains in copy match the funding-update skill and explorer-link support: Ethereum, Base, Optimism, Arbitrum, Polygon, and Gnosis.
- Normalize public social handles before launch:
  - Funding page uses `https://x.com/PharosWatch`.
  - Costs note says `@pharos_watch`.
  - Funding page uses `https://t.me/pharoswatchers`.
  - Footer uses `https://t.me/pharoswatch`.
  - About page links the Telegram bot.
- Decide whether donation rows should show creator-controlled names like `tokenbrice.eth` as-is, use a founder label, or remain hidden from the public donor list.

### 2. Resolve Public Sustainability Copy Conflict

- `/about/` currently says Pharos has "no plan to monetize."
- `/funding/` says long-term sustainability may include paid API access for institutional users with heavy programmatic needs.
- Resolve this before public release. Recommended stance: "the public dashboard remains free; heavy programmatic/API usage may become a paid sustainability lane."
- Update the About page copy and `docs/about-page.md` if this stance changes.
- Re-read the funding FAQ after the copy update and remove any ambiguity around donations, API monetization, and what supporters receive.

### 3. Remove Crawl Blockers

- In `src/app/funding/page.tsx`, remove `robots: { index: false, follow: false }`.
- Prefer switching the route to `buildPageMetadata(...)` so funding gets route-specific Open Graph and Twitter metadata consistent with other public pages.
- Remove the `/funding/*` `X-Robots-Tag: noindex, nofollow` block from `public/_headers`.
- Remove or rewrite the build-time comment that says weekly staleness is acceptable because the page is stealth-released.
- After build, verify exported HTML has no `noindex` robots tag for `/funding/`.

### 4. Add Sitemap Coverage

- Add `/funding/` to `src/app/sitemap.ts`.
- Use a data-aware `lastModified`, not only git-derived route edit time. Recommended calculation:
  - `max(lastEdited("/funding/"), costs.last_reviewed_at, donations.last_updated_at)`
- Suggested sitemap profile:
  - `changeFrequency: "weekly"`
  - `priority: 0.5` or `0.6`
- Ensure `npm run seo:check` sees `/funding/` as both indexable and present in sitemap.

### 5. Add Internal Discoverability

- Add `/funding/` to normal navigation. The most coherent location is the `Reference` group in `src/lib/nav-config.ts`, likely near `About`.
- Update `src/lib/__tests__/nav-config.test.ts` for the new item and intended order.
- Check side effects of adding it to `NAV_GROUPS.info`:
  - `AboutReferenceModule` automatically renders all Reference items except `/about`; adding `/funding/` changes that module from 5 cards to 6.
  - Update the module layout if needed so 6 cards do not leave an awkward 5-column row.
  - Update `docs/about-page.md` if the reference-card set changes.
- Add `/funding/` to `FOOTER_PRIMARY_LINKS` in `src/components/footer.tsx` for persistent low-friction discovery.
- Consider a contextual link from the `/about/` "public good" or "Get in Touch" section to `/funding/`.
- Keep homepage placement optional unless you explicitly want a fundraising CTA on the first screen.

### 6. Update Public Indexes

- Add `/funding/` to `scripts/generate-llms-txt.ts`, probably under the API/About or Core Data section with a short transparency-focused description.
- Run `npm run prebuild` or `tsx scripts/generate-llms-txt.ts` so `public/llms.txt` updates.
- Run `npm run check:llms-txt` after generation.
- Decide whether `docs/funding-page.md` should become a public `/docs/funding-page/` entry. This is optional because the doc is mostly an internal route contract and mentions operational skill details.

### 7. Fix Funding-Specific Share And CTA Details

- Change `PHAROS_SHARE_MESSAGE` in `src/components/funding/funding-page-sections.tsx` from `https://pharos.watch` to `https://pharos.watch/funding/`.
- Check all funding CTAs for public-launch accuracy:
  - Giveth recurring support.
  - Direct wallet copy.
  - GitHub issues/PRs.
  - X.
  - Telegram.
- Consider adding a visible "last donation refresh" or "as of" line near the KPI row, not only in the donor card, so public readers know the ledger cadence.

### 8. Update Documentation

- `docs/funding-page.md`
  - Remove "stealth-released" and "no sitemap or navigation entry in v1."
  - Document public metadata, sitemap, nav/footer presence, and release/update cadence.
  - Replace the stealth build-staleness rationale with the public maintenance contract.
- `docs/architecture.md`
  - Move `/funding/` from "Stealth/noindex public routes" to the indexable route list.
  - Remove `/funding/` from the sitemap omission sentence.
  - Mention `/funding/` in the static-copy major feature route list or as its own public transparency route.
- `docs/README.md`
  - Change the route-contract summary from noindex to public funding ledger.
- `docs/about-page.md`
  - Update if `/about/` copy changes or if the reference module includes Funding.
- `docs/start-page.md`
  - Update only if the Start page gains a funding shortcut.

### 9. Verification Commands

Run targeted checks first:

```bash
npx vitest run shared/lib/funding/__tests__/helpers.test.ts src/components/funding/__tests__/funding-page-sections.test.tsx src/lib/__tests__/nav-config.test.ts
npm run check:llms-txt
npm run lint
npm run build
npm run seo:check
```

Before push, run the repo gate:

```bash
npm run test:merge-gate
```

If the Worker is untouched, `cd worker && npx tsc --noEmit` should not be necessary for this change, but running the merge gate is the authoritative pre-push check.

### 10. Post-Deploy Verification

After deployment, verify production behavior directly:

```bash
curl -I https://pharos.watch/funding/
curl -s https://pharos.watch/funding/ | rg -i "noindex|nofollow|canonical|og:title|twitter:card"
curl -s https://pharos.watch/sitemap.xml | rg "https://pharos.watch/funding/"
curl -s https://pharos.watch/robots.txt
curl -s https://pharos.watch/llms.txt | rg -i "funding|donation|support"
```

Expected results:

- No `X-Robots-Tag: noindex` header for `/funding/`.
- No `noindex` or `nofollow` robots meta in `/funding/` HTML.
- Canonical is `https://pharos.watch/funding/` or resolves to `/funding/` through `metadataBase`.
- `/funding/` appears in `sitemap.xml`.
- `/robots.txt` still allows normal public routes.
- `/llms.txt` includes the funding page if the llms index is updated.

Because the old route used response-header noindex and normal HTML caching, purge `/funding/*` or verify after the CDN cache has refreshed.

## P1 Optional Polish

- Create a dedicated funding Open Graph image. The default Pharos OG card is acceptable for release, but a route-specific image would make social shares clearer.
- Add FAQ JSON-LD for the funding FAQ if SEO clarity is important. Breadcrumb JSON-LD already comes from `FeaturePageShell`.
- Add a small funding card to `/about/` rather than only an inline link if the public-good/sustainability story should be prominent.
- Add a route-level metadata test if route metadata regressions have been common elsewhere.
- Add a lightweight data consistency test for funding JSON if manual edits become frequent:
  - timestamps are positive unix seconds
  - tx hashes are unique by chain
  - `kind` is valid
  - `last_updated_at` is not older than the newest donation
  - costs are non-negative

## Rollout Sequence

1. Run/confirm funding data update and resolve the TokenBrice/community classification.
2. Align public sustainability copy across `/about/` and `/funding/`.
3. Remove noindex controls from metadata and headers.
4. Add sitemap entry, navigation/footer links, llms entry, and share URL update.
5. Update docs.
6. Run targeted tests, lint, build, SEO check, and merge gate.
7. Deploy.
8. Verify production headers, HTML, sitemap, robots, llms, and main navigation.
9. Announce publicly only after production verification passes.

## Rollback

Rollback is low-risk because the page has no database migration or runtime API dependency.

- Re-add `robots: { index: false, follow: false }` to `src/app/funding/page.tsx`.
- Restore the `/funding/*` `X-Robots-Tag: noindex, nofollow` block in `public/_headers`.
- Remove `/funding/` from `src/app/sitemap.ts`, nav, footer, and llms index.
- Redeploy and verify the noindex header/meta are back in production.
