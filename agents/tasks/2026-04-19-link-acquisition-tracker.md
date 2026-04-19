# Pharos Link Acquisition Tracker - 2026-04-19

## Status Legend

- `[x]` Done or submitted
- `[~]` In progress / waiting on third party
- `[ ]` Not started
- `[blocked]` Requires owner account, CAPTCHA, private credential, or external approval

## Completed / Submitted

- [x] Built Stablecoin Cemetery dataset exports
  - JSON: `https://pharos.watch/datasets/stablecoin-cemetery.json`
  - CSV: `https://pharos.watch/datasets/stablecoin-cemetery.csv`
  - Repo commit: `4d64d6f3 feat(cemetery): publish research dataset exports`
- [x] Blockscan / Etherscan Community Resource Suggestions
  - Submitted without email; confirmation shown by form.
- [x] Ethereum Ecosystem
  - Submitted by owner through hCaptcha-protected form.
- [x] DappRadar
  - Submitted by owner through DappRadar dashboard.
- [x] The Grid
  - Profile-claim submitted by owner.
- [x] SaaSHub
  - Submitted by owner.
- [x] Uneed
  - Submitted by owner.
- [x] Startup Stash
  - Submitted by owner.
- [x] StableCoin Hub
  - Submitted with `admin@pharos.watch`.
  - Caveat: form displayed only a client-side alert confirmation.
- [x] llmstxt.site
  - Submitted with `admin@pharos.watch`; thank-you page reached.
- [x] llms.txt Hub
  - PR: https://github.com/thedaviddias/llms-txt-hub/pull/916
- [x] Ethereum dashboards
  - PR: https://github.com/superphiz/dashboards/pull/28
- [x] awesome-web3-data
  - PR: https://github.com/DROOdotFOO/awesome-web3-data/pull/16
- [x] awesome-decentralized-finance
  - PR: https://github.com/ong/awesome-decentralized-finance/pull/91
- [x] ethereum.org Resources
  - Issue: https://github.com/ethereum/ethereum-org-website/issues/17993

## In Progress / Waiting

- [~] External PRs/issues above
  - Monitor for review comments and merge/close outcome.
- [~] Directory submissions above
  - Watch `admin@pharos.watch` for verification, approval, or profile-claim follow-up.

## Implemented This Round

- [x] Postman collection artifact
  - Collection: `https://pharos.watch/postman/pharos-api.postman_collection.json`
  - Environment: `https://pharos.watch/postman/pharos-api.postman_environment.json`
  - Next owner action: import to Postman, publish in a public workspace, then submit/share through Postman API Network.
- [x] OpenAPI endpoint catalogue
  - Spec: `https://pharos.watch/openapi.json`
  - Enables OpenAPI imports and APIs.guru submission after deployment.
- [x] awesome-digital-assets
  - PR: https://github.com/larsulbricht/awesome-digital-assets/pull/8
- [x] DeFi Developer Road Map
  - PR: https://github.com/OffcierCia/DeFi-Developer-Road-Map/pull/137
- [x] moov-io awesome-fintech
  - PR: https://github.com/moov-io/awesome-fintech/pull/60
- [x] Stablecoin Insider
  - Submitted public Typeform with `admin@pharos.watch`.
  - Caveat: form only allowed broad interest selection; selected `Something Else` rather than paid/sponsored options.

## Remaining Owner-Action Opportunities

- [blocked] AlternativeTo
  - Status: submission paused on weekend.
  - Action: resume when app submissions reopen.
- [blocked] Product Hunt
  - Status: intentionally skipped for now.
  - Action: do only when ready for launch-day participation.
- [blocked] Alchemy Dapp Store
  - Status: old Airtable intake is password-protected.
  - Action: ask Alchemy for the current Dapp Store intake path or access password.
- [blocked] Postman API Network publishing
  - Status: collection/environment files are ready.
  - Action: requires Postman account/workspace ownership.
- [x] APIs.guru
  - Web form was broken because its RawGit submit helper returns 404.
  - Opened direct repo issue instead: https://github.com/APIs-guru/openapi-directory/issues/2431
  - Definition URL: `https://pharos.watch/openapi.json`
- [ ] PublicAPIs.io
  - Lower authority than APIs.guru/Postman; can submit after API positioning is settled.
- [blocked] RapidAPI
  - Status: not a passive directory; it is a marketplace/provider gateway listing.
  - Action: defer unless Pharos intentionally wants a RapidAPI provider account, RapidAPI gateway setup, pricing/free-plan decisions, and API key handling through RapidAPI.
- [blocked] Bluechip outreach
  - Status: skipped by owner for now.
  - Potential later action: ask for a neutral use-case/resource mention because Pharos surfaces Bluechip safety ratings.
- [blocked] CoinGecko case study / API spotlight
  - Status: support form blocked by Cloudflare security verification in automation browser.
  - Action: owner can submit manually via `https://support.coingecko.com/hc/en-us/requests/new`.
- [blocked] DefiLlama docs/example
  - Status: skipped by owner for now.
  - Potential later action: propose a technical example or docs mention around stablecoin API consumption without pushing a promotional link.
- [blocked] Stablecoin Standard
  - Status: public contact form rejected automated submission with `Captcha validation failed`.
  - Action: owner can submit manually at `https://www.stablecoinstandard.com/contact` or email `hello@stablecoinstandard.com`.
- [ ] Academic and policy-resource outreach
  - Share Cemetery dataset with stablecoin researchers and policy-resource curators.

## API Directory Execution Notes - 2026-04-19

Sources checked:

- Postman API Network docs: `https://learning.postman.com/docs/postman-api-network/showcase/prepare/overview/`, `https://learning.postman.com/docs/postman-api-network/showcase/prepare/public-collections/`, `https://learning.postman.com/docs/postman-api-network/showcase/publish/public-apis/`
- APIs.guru add API form and repo: `https://old.apis.guru/add-api/`, `https://github.com/APIs-guru/openapi-directory`
- PublicAPIs.io submit page: `https://publicapis.io/submit`
- RapidAPI provider/listing docs: `https://docs.rapidapi.com/docs/hub-listing-general-tab`, `https://docs.rapidapi.com/docs/hub-listing-definitions-tab`, `https://docs.rapidapi.com/v2.0/docs/configuring-api-authentication`

Findings:

- Postman: blocked on owner login. A public workspace, public API reference collection, overview collection, and environment are needed. Current local artifacts exist under `public/postman/`, but the live URLs returned the Pharos 404 page during this pass, so they are not usable until deployed.
- APIs.guru: blocked on a stable public machine-readable definition URL. The form can be completed without an owner login after Pharos publishes a durable OpenAPI JSON/YAML URL. The old form lists Postman Collection as an accepted machine-readable format, but APIs.guru's repo goal and update process are OpenAPI-centered, so publish OpenAPI first.
- PublicAPIs.io: blocked on payment decision. The live browser form currently presents only a Pro listing flow with `$99` payment redirect; `?plan=free` did not expose a free intake path. No autonomous submission was made.
- RapidAPI: blocked and lower fit. Publishing requires a RapidAPI provider account, a public API project, logo/category/descriptions, endpoint definitions or OAS upload, base URL routing, auth decisions, visibility approval, and pricing/free-plan decisions. It is not suitable as a no-login directory submission.

Paste-ready directory values:

- API name: `Pharos API`
- Website/docs URL: `https://pharos.watch/about/api/`
- Base URL: `https://api.pharos.watch`
- Category preference: `Cryptocurrency`; fallback `Open Data`, `Analytics`, or `Data Access` depending on directory taxonomy.
- Contact email: `admin@pharos.watch`
- Logo URL: `https://pharos.watch/pharos-icon.png`
- Short description: `Stablecoin risk, peg, liquidity, safety score, blacklist, mint/burn, yield, and chain-health data from Pharos.`
- Access note: `Protected public routes require X-API-Key. Request access in the Pharos Telegram channel with intended endpoints, cadence, and expected volume. Health checks and static datasets are public.`

## Paste-Ready Positioning

Short tagline:

> Stablecoin risk, peg, liquidity, and safety analytics in one dashboard.

Long description:

> Pharos is a free, open-source stablecoin analytics dashboard built for stablecoin risk and market-structure analysis. It tracks active stablecoins across major chains and peg currencies, combining live peg monitoring, supply data, safety scores, DEX liquidity, reserve and redemption context, yield intelligence, blacklist and freeze-event risk, mint/burn flows, dependency maps, chain health, and market-wide stability signals. Pharos also includes transparent methodology docs, public API references, llms.txt support, and a downloadable Stablecoin Cemetery dataset covering failed, abandoned, depegged, and discontinued stablecoins.
