# Safety Alert Volatility Research

Date: 2026-04-22

## Assumptions

- The problem to solve is broader than one user's preferences: safety-grade alerts feel noisy for users who follow many or all stablecoins.
- The goal is to evaluate product, alerting, and scoring options without changing code yet.
- "Safety alert noise" and "grade volatility" are related but distinct:
  - alert noise = too many notifications/messages
  - grade volatility = the underlying score/grade changes too often

## Success Criteria

- Explain what the system does today and where noise enters.
- Quantify recent production behavior where possible.
- Separate low-risk alert-product fixes from higher-risk methodology changes.
- End with a recommendation stack, not just a bug list.

## What The System Does Today

### Alert cadence

- `publish-report-card-cache` republishes the live report-card snapshot every 15 minutes.
- `dispatch-telegram-alerts` runs every 5 minutes.
- Safety alerts are **not** driven only by the daily `safety_grade_history` snapshot anymore.
- Instead, the Telegram dispatcher compares the prior alert snapshot with the current live alert-only safety source cache.

Relevant files:

- `shared/lib/cron-jobs.ts`
- `worker/src/cron/publish-report-card-cache.ts`
- `worker/src/cron/dispatch-telegram-alerts.ts`
- `worker/src/cron/dispatch-telegram-state.ts`
- `worker/src/lib/alert-safety-source-cache.ts`

### Alert trigger rule

- Any safety grade change between the prior alert snapshot and current live snapshot is alertable.
- Methodology-version-only regrades are suppressed.
- There is no additional safety-specific:
  - cooldown
  - minimum score-delta gate
  - hysteresis around grade thresholds
  - "material change only" mode

Relevant files:

- `worker/src/cron/telegram-alert-changes.ts`
- `worker/src/lib/telegram-alerts.ts`

### Current user controls

Existing controls:

- global all-stablecoin safety alerts: on/off
- per-coin safety mode: `all`, `downgrade-only`, `upgrade-only`
- quiet hours
- inline snooze: 1h / 4h / 24h

Important limitation:

- global safety follows do **not** support `downgrade-only` or `upgrade-only`
- that mode exists only per coin

Relevant files:

- `docs/telegram-alerts.md`
- `worker/src/api/telegram-webhook-store.ts`

### Message content

Safety alerts currently show:

- coin symbol
- old grade -> new grade
- old score -> new score

They do **not** show:

- why the score changed
- whether the move was minor vs material
- whether the move is mostly threshold noise
- which dimension moved

Relevant file:

- `worker/src/lib/telegram-alerts.ts`

## Production Evidence

### Subscriber shape

From production D1 on 2026-04-22:

- total Telegram chats: `144`
- safety-enabled chats: `60`
- chats with global all-stablecoin safety alerts: `24`
- chats with quiet hours enabled: `3`
- chats with any `safety_mode` override: `0`

Interpretation:

- a meaningful share of safety users are on the broadest possible subscription
- the existing dampening controls are barely used for safety specifically
- this is partly a discoverability/product-fit problem, not just a user-choice problem

### Recent dispatch behavior

From `cron_runs` for `dispatch-telegram-alerts`:

- 2026-04-22: `52` safety events across `7` separate runs so far
- 2026-04-21: `17` safety events across `1` run
- 2026-04-20: `14` safety events across `1` run
- 2026-04-18: `19` safety events across `1` run

Specific 2026-04-22 runs:

- `2026-04-22 08:52:49 UTC`: `7` safety events
- `2026-04-22 09:22:50 UTC`: `4`
- `2026-04-22 10:22:49 UTC`: `1`
- `2026-04-22 12:52:49 UTC`: `10`
- `2026-04-22 16:22:43 UTC`: `2`
- `2026-04-22 17:52:42 UTC`: `20`
- `2026-04-22 18:52:30 UTC`: `8`

Interpretation:

- the user complaint matches production behavior
- the system can currently generate multiple safety-alert bursts in one day
- the current implementation behaves like a live feed, not like a low-frequency risk alert

### Grade-change distribution

From `safety_grade_history` over the last 30 days:

- total grade transitions: `934`
- average absolute score delta: `5.26`
- transitions with delta `<= 1`: `177`
- transitions with delta `<= 2`: `314`
- transitions with delta `<= 3`: `440`

Boundary sensitivity:

- transitions ending within `1` point of a grade boundary: `602 / 934`
- transitions ending within `2` points of a grade boundary: `888 / 934`

Interpretation:

- a large amount of movement is threshold-sensitive rather than obviously regime-changing
- many alerts are about scores living right on grade edges

### Most common transitions

Top 30-day transitions:

- `C+ -> B-`: `91`
- `C- -> C`: `74`
- `C -> C-`: `69`
- `B- -> C+`: `65`
- `B- -> B`: `59`
- `C -> C+`: `59`
- `B -> B-`: `51`
- `C+ -> C`: `45`
- `C- -> D`: `45`
- `D -> C-`: `40`

Interpretation:

- the noisiest area is the middle of the scale, especially the `55/60/65/70` boundaries
- plus/minus grades create many alertable threshold crossings from small score moves

### Concrete flapping examples

Recent history shows repeated edge-crossing patterns:

- `sbc-brale`: `64 <-> 65` repeatedly (`C+ <-> B-`)
- `cusd-celo`: `59 <-> 60` repeatedly (`C <-> C+`)
- `usdy-ondo-finance`: `59 <-> 60` and `64 <-> 65`
- `usdm-mega`: `54 <-> 56` (`C- <-> C`)
- `susdai-usd-ai`: `64 <-> 66`, `69 <-> 70`
- `usdp-paxos`: historical `64 <-> 65`, `59 <-> 60`, plus some larger swings
- `aeur-anchored-coins`: repeated `D <-> F` reversals

These match the screenshot pattern: many alerts are small moves across a nearby threshold.

### Methodology churn as a separate factor

On 2026-04-22 the safety methodology advanced through versions `7.09` to `7.13`.

Dispatch evidence:

- `2026-04-22 08:02:49 UTC`: `35` suppressed methodology changes
- `2026-04-22 08:37:49 UTC`: `1` suppressed methodology change

Interpretation:

- methodology releases are already mostly suppressed from safety alerts
- but they still contribute to perceived grade instability on the product surface
- repeated same-day scoring-version releases make the whole grade system feel less inertial

## Findings

### 1. The alert product is more sensitive than the grade history surface

The public safety history is daily. The alert product is effectively live.

That is a legitimate design choice, but it means "all safety alerts" behaves like a market-monitoring feed, not like a sparse risk-warning channel.

### 2. The dominant noise source is threshold flapping, not only large score moves

The strongest quantitative signal is boundary sensitivity:

- `602 / 934` recent changes ended within `1` point of a threshold
- `888 / 934` ended within `2` points

That means the grade label is changing more often than the underlying score meaningfully changes.

### 3. Current controls are mismatched to the broad-subscription use case

For a user following all stablecoins, the most natural default is probably not:

- both upgrades and downgrades
- real-time delivery
- every threshold crossing

But that is effectively what the product does today.

The existing controls do not solve this well:

- quiet hours only silence notifications; they do not reduce feed volume
- snooze is reactive, not proactive
- `downgrade-only` exists only per coin, not for global follows

### 4. Message design makes minor and major changes look too similar

A `59 -> 60` and a `69 -> 58` both render as grade changes with score deltas, but without a severity model or cause context.

This makes the stream feel noisier than it is because users cannot quickly separate:

- threshold taps
- genuine deteriorations
- methodology-driven regrades
- parent/variant dependency cascades

### 5. Some recent methodology work likely increased coupling for variant assets

Recent versions `7.09` to `7.12` expanded parent-linked tracked variants and wrapper ceilings/caps.

That is defensible analytically, but it likely increases motion for some wrapper cohorts because parent movement can now propagate more explicitly.

This looks relevant for assets such as `susdai-usd-ai`, which appears in recent flapping examples and was part of the strategy-vault variant rollout.

This is an inference from the changelog plus recent examples, not a direct causal proof from stored per-dimension history.

## Option Space

### Option A: Fix the alert product only

Examples:

- allow `global safety downgrade-only`
- add `global safety material-only`
- add per-coin or per-chat cooldowns for safety alerts
- batch all-stablecoin safety alerts hourly or 4-hourly
- keep per-coin explicit follows more real-time
- show cause/severity context in the alert body

Pros:

- lowest implementation and methodology risk
- preserves raw score transparency on-site
- directly targets the user pain

Cons:

- the underlying grade still moves frequently on-site
- alert semantics become more complex

### Option B: Add inertia to the alert grade, not the public score

Examples:

- alert only when a grade is sustained for `N` publishes
- alert only when the score clears the new boundary by `>= 2` points
- alert on coarse bands instead of full `A+/A/A-...`
- alert on cross-letter moves only

Pros:

- attacks threshold flapping directly
- avoids changing the visible score methodology immediately
- likely the best signal/noise improvement per unit complexity

Cons:

- alert grade and displayed live grade can temporarily diverge
- requires careful explanation in docs/UI

### Option C: Add inertia to the core safety grade itself

Examples:

- hysteresis: promotions require threshold `+H`, demotions require threshold `-H`
- moving average / EMA on final score before grading
- smoothing only on dynamic dimensions such as liquidity or peg inputs

Pros:

- makes the whole product feel more stable
- removes volatility at the source

Cons:

- methodology change, not just UX polish
- can hide real deterioration if tuned badly
- requires doc/changelog updates and careful backtest review

### Option D: Keep grades live but make alerts coarser than grades

Examples:

- site keeps `A+ ... F`
- alerts use `Strong / Good / Watch / Weak / Fragile`
- or alerts use base letters only (`A/B/C/D/F`) rather than plus/minus

Pros:

- likely major noise reduction
- aligns alerts with user intent better than plus/minus granularity
- avoids rewriting the score engine

Cons:

- two grade vocabularies to explain
- some power users may prefer exact raw-grade alerts

### Option E: Process/rollout change for methodology releases

Examples:

- bundle score-affecting methodology updates into fewer releases
- avoid multiple same-day safety-version bumps unless necessary
- apply a temporary safety-alert mute window after major methodology deploys

Pros:

- improves trust and perceived stability
- reduces deploy-day turbulence

Cons:

- does not solve ordinary non-methodology flapping
- more operational discipline than product design

## Recommendation

### Recommended near-term direction

Do **not** start by changing the core score methodology.

Start by treating "all stablecoins safety alerts" as a different product tier from explicit per-coin safety follows.

Recommended policy:

1. Global all-stablecoin safety follows should default to `downgrade-only`.
2. Global all-stablecoin safety follows should alert only on material changes.
   - strongest candidates:
     - minimum absolute score delta `>= 3`
     - or cross-letter change only
     - or crossing into a worse coarse band
3. Global all-stablecoin safety follows should batch on a slower cadence than 5 minutes.
   - hourly is the simplest starting point
4. Safety alert messages should include cause/severity context.
   - at minimum: score delta magnitude and "minor vs material"
   - ideally: top dimension movers

Why this is the best first move:

- it directly addresses the observed pain
- it preserves the current live score semantics while the team learns what users actually want
- it avoids forcing a scoring-methodology change before proving the alert-product fix is insufficient

### Recommended medium-term direction

If alert-only fixes are not enough, add inertia to the **alert grade** before adding inertia to the core score.

Best candidate:

- keep live score and live site grade unchanged
- require a small hysteresis margin or sustain window before a safety-grade alert fires

This is the cleanest way to suppress `59 <-> 60`, `64 <-> 65`, `69 <-> 70` ping-pong without muting genuine larger deteriorations.

### Recommended long-term direction

Only move to core score hysteresis if the product conclusion is:

- the grade itself is too live for the intended Pharos user mental model
- not just the Telegram alert stream

If that conclusion is reached, prefer **grade hysteresis** over heavy score smoothing. Grade hysteresis is easier to explain, easier to backtest, and less likely to hide real sharp moves.

## What I Would Not Recommend First

- Reverting safety alerts back to the daily history snapshot
  - too stale
  - loses the intentional alignment with the live report-card publication path

- Blanket suppression of all upgrades
  - too blunt
  - some upgrades are meaningful

- Heavy EMA-style smoothing across the whole score engine
  - methodology risk is too high for a first response

## Open Questions For The Next Step

- Should "all stablecoins safety" behave like a watchtower feed or like a sparse risk-warning product?
- Is the right severity gate `delta >= 3`, cross-letter only, base-letter only, or a coarse-band model?
- Should per-coin explicit follows stay real-time while global follows become slower/coarser?
- Do we want the alert body to explain *why* the score changed before changing the trigger semantics?
- Should methodology release policy itself become stricter for score-affecting changes?

## Bottom Line

The current pain is real and is not just user over-subscription.

The strongest evidence points to this combination:

1. safety alerts now run off a live 15-minute score surface
2. many scores sit directly on grade boundaries
3. tiny threshold moves are alertable
4. the global all-stablecoin safety mode has no global downgrade-only/material-only control
5. the alert message does not distinguish minor threshold taps from meaningful re-rates

The most pragmatic next move is:

- keep the score engine as-is for now
- make global safety alerts materially coarser and more downgrade-focused
- then reassess whether grade-level hysteresis is still needed
