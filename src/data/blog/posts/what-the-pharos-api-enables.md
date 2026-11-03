Most readers meet Pharos as a website. The same data is served by an API: Safety Score report cards, peg and depeg history, the stress signals behind our early warnings, DEX liquidity, reserves and redemption routes, supply and mint-and-burn flows, yields and the daily digest. Teams with keys rarely tell us what they build with it, so at the end of September we asked them. KPK and CurveDEX answered in writing, Frankencoin replied separately, and Newton had already written up its integration. All four agreed to be named, and each uses the data for a different job.

## Newton: no new exposure under stress

[Newton Labs](https://newton.xyz/) builds an authorization layer that checks each on-chain transaction against a policy before it settles. In September it published [a stablecoin safe mode built with Pharos](https://blog.newton.xyz/a-stablecoin-safe-mode-built-with-pharos/). The rule is narrow. When Pharos reports rising stress or an active depeg on a stablecoin a vault holds, the vault stops adding exposure to that coin. A deposit fails, and a withdrawal one block later goes through. Redemptions and swaps into an approved safer asset stay open, and nobody has to be awake to flip a switch.

Price alone could not support that rule. Newton's oracle packs Pharos's stress score and the indicators behind it, the exit liquidity available at the slippage the policy accepts, whether direct redemption works, and the age of the data into one attested snapshot for the coin and chain in question. That snapshot becomes the receipt for each decision, allowed or denied. A maximum data age and a failure mode are among the policy's five settings, and in the setup Newton describes, nothing that adds exposure goes through if Pharos cannot answer. Pharos stamps responses with freshness headers, and most also carry a `_meta` block stating when the data was produced, so a consumer can enforce an age limit.

## KPK: depeg alerts for an emergency-response system

[KPK](https://kpk.io/) runs on-chain asset management for treasuries. It uses Pharos's depeg events and DEWS, the Depeg Early Warning System's per-coin stress score, to raise alerts, and also relies on DEX liquidity, reserves, redemption backstops and mint-and-burn flows. The next step is to route those alerts into KPK's agentic emergency-response system. Nothing executes on-chain from the API yet; "that's the goal," the team told us.

KPK was "up and running in a matter of days" and valued coverage of less common stablecoins such as avUSD, ftUSD and ZCHF.

KPK also curates two vaults that Pharos rates, KPK USDC Prime and KPK USDC Yield. In October it answered our evidence questions on both, as any issuer can; its API access plays no part in how they are scored.

## CurveDEX: a risk layer for Curve pools

[CurveDEX](https://llama.box/curvedex/) is an alternative Curve Finance frontend, part of the llama.box toolkit. Pharos report cards are the primary source for its stablecoin risk layer. The grades feed llama.box's [ratings aggregator](https://llama.box/ratings/), which rates each pool by its weakest stablecoin, and appear on pool pages and in the Info tab of each token card. Its home widgets for top yield, reliable pools and stablecoins leave out pools below a grade threshold. When CurveDEX answered in early October, the aggregator listed 969 tokens, 910 of them graded.

The integration plans for failure. It matches grades to tokens by contract address through the `/api/stablecoins` catalog, leaves out unrated cards and cross-checks against Bluechip. If the API goes down, CurveDEX keeps the last known grades with their date and falls back to the free safety-grades feed, which needs no key. From mid-September to its October 3 answer, it pulled every six hours with no 429, 403 or 5xx in its logs.

CurveDEX also told us what went wrong. When we retired the unversioned report-card route in late July, it started returning 404 with no notice, and CurveDEX found the new `/v9` path through our OpenAPI file. Since October 27, the retired route answers 410 with the replacement path. A Cloudflare challenge that blocked server-side calls at the time has been fixed. CurveDEX also pointed out that only the `X-API-Key` header authenticates, and a key sent as `Authorization: Bearer` gets a 401; the [API reference](/api/reference/#public-api-auth) now says so.

## Frankencoin: an issuer that publishes its grade

[Frankencoin](https://www.frankencoin.com/), the protocol behind the ZCHF Swiss franc stablecoin, shows its Pharos Safety Score on its homepage: the grade and score, the methodology version and update time, and the three pillar grades with their evidence labels, linked to the [full report card](/stablecoin/zchf-frankencoin/). The section states that Pharos has no affiliation with Frankencoin. Its key is free because the display is free to its readers, and the key plays no part in how ZCHF is scored. The feed is live, so any change to ZCHF's grade reaches Frankencoin's homepage.

## What else the API covers

The four integrations use part of what is available. The [API reference](/api/reference/) documents every endpoint; the main families are:

- **Safety Scores:** report cards with pillar grades and evidence (`/api/report-cards/v9`), score history, and grades alone with no key (`/api/safety-grades`).
- **Peg and depeg:** current deviation per coin, the depeg incident log and the Depeg Duration Resolver's recovery calls (`/api/peg-summary`, `/api/depeg-events`, `/api/depeg-resolver`).
- **Stress:** DEWS stress signals and the Pharos Stability Index (`/api/stress-signals`, `/api/stability-index`).
- **Exit and backing:** DEX liquidity, redemption backstops and reserve composition (`/api/dex-liquidity`, `/api/redemption-backstops`, `/api/stablecoin-reserves/{id}`).
- **Supply:** supply history, mint and burn flows, and freeze events (`/api/supply-history`, `/api/mint-burn-flows`, `/api/blacklist`).
- **Yield and digest:** yield rankings and history, the daily digest and dated snapshots.

OpenAPI and Postman files are linked from the [API page](/api/).

## How to get a key

- **No key:** Safety Score grades for every tracked stablecoin, at `https://api.pharos.watch/api/safety-grades`.
- **Supporter key:** donate $10 or more in stablecoins graded A or B, then claim a key on the [API page](/api/#supporter-key). It allows 10 requests per minute and does not expire.
- **Partner key:** for teams in production. Message [@TokenBrice on Telegram](https://t.me/TokenBrice) or DM [@PharosWatch on X](https://x.com/PharosWatch). Partner keys start at 120 requests per minute. They are free when your service is free to its users; commercial terms are agreed case by case.

Access does not change how anything is scored. Any issuer can answer our evidence questions, with or without a key, and every rating follows the same published methodology.

If you build on Pharos data, tell us what you are building. With your agreement, we will add your logo to the [API page](/api/).

See you at the lighthouse. 🗼

	/- TokenBrice
