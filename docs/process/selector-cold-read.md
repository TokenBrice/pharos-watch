# Stablecoin Selector — Cold-Read Manual Gate

A pre-ship calibration test for Selector editorial copy. Confirms the surface reads as a **profile-matched shortlist with hedged framing**, not as a recommendation. Manual, not CI. Block ship if it fails.

Reference: design §9.1 item 6 (Skeptic / R2), implementation plan §6 (pre-ship checklist), `agents/screener-selector/03-editorial.md` §4 (worked examples scanned).

---

## Why this exists

The Selector ranks named issuers under per-profile constraints. The editorial intent is *"X fits this profile because of [live anchor]; here is the watchout"* — not *"X is the best stablecoin"*. The two read very differently to engineers; they collapse the same way to non-Pharos readers under load.

The cold-read test stress-tests the calibration *with readers who have no prior context*. If three or more of five unfamiliar readers describe the headline as *"USDC is the best Treasury stablecoin"*, the editorial framing has failed regardless of how the engineering team reads the same page. The shortlist may still be the right output; the prose has to do the calibration work, and at that result we know it isn't.

The test runs across all three profiles. Treasury is the load-bearing case (highest-stakes claim, most recognizable name) but Yield and Active Trading also gate.

---

## Procedure

### 1. Recruit five readers per profile run

Screening criteria:

- No prior contact with Pharos. Recruit from outside the project — DAO operators, on-chain treasurers, stablecoin-adjacent ops contacts in DeFi communities. Not crypto-Twitter respondents (they have priors). Not engineers who already saw an internal preview.
- Comfortable reading technical financial copy in English (no localization gate here; French port has its own calibration per `03-editorial.md` §9).
- Anonymized — record only a stable identifier (R1..R5) and the profile run.

Each profile (Treasury, Yield, Active Trading) needs its own five readers. The five may be reused across profiles only if at least 48 hours pass between sessions and the reader is not told the second profile is being tested (mention reframes priors).

### 2. Present the worked example, nothing else

For each reader:

- Show the rendered output for the matching worked example from `agents/screener-selector/03-editorial.md` §4. Static HTML or a screenshot is fine; do not run the full wizard.
- Do **not** show the wizard, the methodology page, the framing intro paragraph, or any other Pharos copy. The output has to stand on its own — if it requires the surrounding scaffolding to read correctly, the calibration has failed.
- Allow as much time as the reader wants. Do not prompt.

### 3. Ask the convergence question, verbatim

Treasury profile:

> "What did this surface tell you about USDC?"

Yield profile:

> "What did this surface tell you about USDS?"

Active Trading profile:

> "What did this surface tell you about USDC?"

Use the exact phrasing. Do not rephrase, soften, or expand. Variations contaminate the result.

### 4. Record the response

For each reader, capture:

- Verbatim quote (or near-verbatim with minor cleanups).
- Whether the response is one of:
  - **(a) Headline-collapse**: equivalent to *"X is the best stablecoin for [profile]"*, *"Pharos picked X"*, *"this is the recommended choice"*, or any framing that treats the shortlist position as an absolute endorsement.
  - **(b) Profile-conditional**: equivalent to *"X fits [profile] under these constraints"*, *"the shortlist is the survivor set after filtering"*, or any framing that surfaces the profile-conditioning.
  - **(c) Ambiguous**: response does not clearly fit either pattern.
- The reader's one-sentence summary of what *would change* if you ran the same form with different inputs. (Spot-check for whether they grasped the profile dependency.)

### 5. Apply the convergence criterion

**Pass:** ≤2 of 5 readers fall into (a) Headline-collapse.

**Fail:** 3 or more of 5 fall into (a).

The criterion is intentionally tight. The Selector ships only when ≤40% of unfamiliar readers collapse to absolute-endorsement framing.

Each profile (Treasury, Yield, Active Trading) must pass independently. A Treasury pass does not certify Yield or Active Trading.

### 6. Recovery loop on fail

If any profile fails:

1. **Document** which phrases / structural elements pulled readers toward headline-collapse. Common culprits: *"Best fit"*, an evidence-chip ordering that puts grade-letters first, scoring numbers without their dimensional context.
2. **Revise** the editorial templates and worked examples to restore the profile-conditioning. Banned-phrase lint must still pass after revision.
3. **Wait at least 1 week** before retesting, and recruit **five new readers** for that profile run. Repeated readers carry priors from the first session.
4. **Retest** the revised surface against the same convergence criterion. Continue the loop until pass.

Do not ship a failed profile under any timeline pressure. The editorial calibration is the load-bearing variable for the surface's legal posture (design §9.1 — MiCA / Advisers Act exposure).

---

## Artifact storage

Save each session's anonymized transcript to:

```
docs/process/cold-read-results/<YYYY-MM-DD>-<profile>.md
```

Format (one file per profile run):

```
# Cold-read — <Profile> — <YYYY-MM-DD>

Output shown: agents/screener-selector/03-editorial.md §<n.n>
Build / methodology stamp: selector-v<N>, Safety Score v<N>

## R1
Verbatim: "..."
Classification: headline-collapse | profile-conditional | ambiguous
Profile-dependency check: <one-sentence summary>

## R2
...

## Convergence
- Headline-collapse: X / 5
- Profile-conditional: X / 5
- Ambiguous: X / 5

## Decision
Pass | Fail — <one-sentence reason>

## Follow-up
<if Fail: which phrases pulled readers; planned revisions; retest date>
```

The transcripts are the durable evidence that the gate ran. They live in-repo for audit traceability and for cross-reference if the same calibration question recurs on adjacent surfaces.

---

## Release-manager checklist

A release manager owns the gate. Before any Selector merge to `main` that ships to production:

- [ ] Treasury cold-read run — 5 readers — convergence ≤2/5.
- [ ] Yield cold-read run — 5 readers — convergence ≤2/5.
- [ ] Active Trading cold-read run — 5 readers — convergence ≤2/5.
- [ ] All three transcripts saved to `docs/process/cold-read-results/`.
- [ ] PR description references the three transcript files by path.

If any profile is in a recovery loop, the release manager blocks the merge until the loop completes.

---

## When to re-run

- Before MVP ship (gate).
- After any structural change to the result-page editorial template (new evidence-chip slot, reordered "Why this fits" body, removed "What to watch" line, etc.).
- After any weight-vector change that materially changes which coin appears as the shortlist headline for a profile. The point of the gate is to certify reader interpretation of the headline; if the headline shifts, the calibration has to be re-confirmed.
- Annually as a calibration spot-check, independent of structural changes. Drift in reader expectations (stablecoin market context, regulatory news cycle) can change what a "Best fit for Treasury" header reads as without any editorial change on our side.

A weight change that does not affect any profile's headline coin does not require a re-run. A copy edit that does not change the structural elements (chip count, slot ordering, mandatory lines) does not require a re-run.

---

## Out of scope for this gate

- Quantitative scoring of the convergence question (no inter-rater reliability metric; the binary classification is enough at this sample size).
- A/B framing tests across editorial variants (separate workstream; design §9.1 item 2 if explored).
- Translation calibration for the French port (separate workstream; `03-editorial.md` §9 documents the gates that port needs).
