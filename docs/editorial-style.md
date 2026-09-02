# Pharos Editorial Style

> **Agent navigation** — Grep the heading you need instead of reading wholesale: Voice · No machine tells · Neutral but compelling · Pointed only when the evidence closes the case · Clear, informative, descriptive · Claim safety · Banned constructions · Punctuation and labels · Registers by surface · Exemplars · Scope and enforcement · Final edit · Machine-readable policy.

Version 1.2. This is the sole style authority for Pharos-owned prose. Surface prompts, agent skills, and lints derive from it; none may add or relax a voice rule locally. Surface-specific factual and structural rules (lead selection, anti-repetition, length contracts) live in the register table here and in each surface's factual contract.

The fenced `editorial-policy` block at the end of this document is the machine-readable source of truth. `shared/lib/editorial-style.generated.ts` is generated from it; never hand-edit that file, and never maintain a second phrase list.

## Voice

Pharos writes like a Financial Times markets reporter with the tape in front of it: neutral in judgment, precise with numbers, alert to contradictions. The prose gives a financially curious reader the context to understand what changed and why it matters, without teaching stablecoin basics, reciting the dashboard, or performing cleverness. Data leads and interpretation follows. Heat is compression of a closed record, not a tone to select; the default amount is none.

## 1. No machine tells

Machine-sounding prose weakens trust even when the facts are right. Prefer direct assertions, natural sentence shapes, and specific verbs. Do not manufacture drama through punctuation, symmetrical contrasts, stock metaphors, or polished little morals.

**The corrective cleft is an advisory tell; the suspense opener is banned** (`no-corrective-cleft`, `no-corrective-cleft-split`, `no-suspense-opener`). The cleft dismisses a label to install a punchline: "it is not X, it is Y", "this isn't X; it's Y". Ordinary technical distinctions can have the same grammar: "The 72h backstop is not a weaker forecast-readiness score; it is the public accountability deadline." No regex can reliably separate those meanings, so the bounded pronoun-led form and its split-sentence sibling trigger review but never block. A withheld-subject opener at a sentence boundary ("What it doesn't have is users") remains an exact blocking tell.

**Evidenced contrast is legal.** "Reads as repositioning, not growth" and "allocation, not alarm" are fine when both sides are concrete and the evidence is on the page. Ordinary factual negatives ("the report covers cash, not liabilities") and measurable comparisons ("less liquid than USDC") are normal financial prose, not tells.

**No personified metrics** (`no-personified-metric`). Named indexes, gauges, scores, models, and regimes do not nap, shrug, yawn, notice, refuse, or leave the building. State what the number did.

**Vary the machinery.** Do not start consecutive sentences with Name+verb+number. Do not end every paragraph with a verdict. A 7-word sentence is legal. A paragraph that only states a fact is legal. A succession of miniature verdicts sounds generated.

## 2. Neutral but compelling

The FT markets-news register: controlled, economical, skeptical of claims, interested in incentives, power, and consequences. Neutral does not mean bloodless; it means the language never outruns the evidence.

**Do:** use scale and history to make a number meaningful.

> USDC added $518.48M over seven days... by Circle's own history, a trickle: it once minted $6.55B in a single week.

**Don't:** tell the reader how excited to feel (`no-booster-language`).

> "Buckle up, this is the adventure so far."

Attribute claims and separate fact from inference. "The outflow coincided with a lower yield" is a fact. "The lower yield caused the outflow" needs evidence. No shilling, no FUD, no booster language, no false balance, no unsupported claims about motives, character, or intent.

## 3. Pointed only when the evidence closes the case

Some registers (daily, weekly, cemetery) permit one dry line. It is a cap, not a quota: zero is the default, and most pieces should use zero. The line must compress evidence, not substitute for it. If it still works after removing the coin name and figures, it is generic; cut it.

The canonical example is scoped to the cemetery register, where the outcome is settled:

> The magic ran out at nine cents.

MIM traded near $0.09 after seven weeks below peg, after every rescue attempt failed. The epitaph works because the record closes every escape hatch. Do not teach daily or summary copy from epitaph heat.

Never mock holders, founders, or projects without evidence, and never reach for a clever label before establishing the loss, concentration, control, or failure behind it. Heat follows proof. It never creates proof.

## 4. Clear, informative, descriptive

Surface and contextualize the data. Do not narrate the act of looking at it. Lead with the subject, the change, and the consequence (this is structure, not a cadence tic). Explain Pharos-specific terms through what they mean for a holder.

**Do:** connect the metric to the real-world constraint.

> USDS lost 91% of its DEX liquidity in a day... nearly 500 to 1 against the float.

**Don't:** recite adjacent cards or grades without interpreting them.

> "Its A+ overall grade... an A+ peg record... exit pillar scored at the very top..."

Prefer one useful comparison over a fourth statistic. Give the baseline, denominator, time window, or precedent that changes the reading. Spell out an unfamiliar acronym on first use unless the same surface already defines it. Once the evidence and consequence are clear, stop.

## Claim safety

Claim-safety rules for every product surface (profiles, OG cards, SEO metadata, Telegram product copy, UI), extending the existing Selector policy repo-wide. The first two are hard; the last two are advisory, because a scanner cannot judge whether nearby context supplies the qualification:

- No unqualified "safe", "safest", "low-risk", "risk-free", or guarantees (`no-unqualified-safety`).
- No recommendations to buy, hold, sell, or switch (`no-investment-recommendation`).
- Rankings and superlatives should name the metric, scope, and date ("highest liquidity score among tracked USD coins, June 2026"). Bare forms trigger advisory review, in product and editorial registers alike, because a scanner cannot determine whether nearby context supplies the qualification safely enough to block publication.
- Technical risk terms should attribute to a defined methodology or source. Missing attribution is advisory for the same context-dependent reason, in product and editorial registers alike.

`docs/design-context.md` owns product posture; this document owns sentences. On mechanics, this document wins.

## Banned constructions

Two classes. **Hard** rules are exact, scanner-safe, and can block a runtime edition or fail CI. **Advisory** rules are review triggers and prompt guidance; they never block on their own, because they cannot be detected without judgment.

### Hard (exact patterns)

- Clause dashes: em, en, figure, and horizontal-bar dashes (U+2012 through U+2015) in prose (`no-clause-dash`). Hyphens stay valid in compounds and compact ranges.
- The mathematical minus (U+2212) used as a clause dash (`no-minus-as-dash`). A signed numeric value is exempt: `−5%` and `−0.3bps` are correct data and never trip this rule; only a minus separating words does.
- The suspense opener, anchored to a sentence boundary (`no-suspense-opener`).
- Context-independent stale phrases (`no-stale-phrase`): "testament to", "time will tell", "it remains to be seen", "in a world where", "game-changing", "cutting-edge", "needless to say", "it's worth noting" and "it is worth noting", and the sentence-opening boilerplate transitions "In summary," and "In conclusion,".
- Closer position only (`no-hedged-closer`): "worth watching", "worth monitoring", "bears watching", "for now", "the question is whether". Say what to watch, when, and what it would mean.
- Decorative dead metaphors in editorial registers (`no-dead-metaphor`): "beneath the calm", "surface calm", "restless depths", "something moving underneath". Literal physical descriptions and ordinary verbs such as "belies" are not in the hard set.
- Claim-safety patterns above, in product scopes.

### Advisory (review triggers)

- Repeated rule-of-three cadence: the abstract-noun triad plus verdict. Factual enumeration of N evidenced items is legal; N=3 is not a smell.
- Corrective clefts, including the bounded within-sentence and split-sentence forms, because necessary technical distinctions share their grammar.
- Ambiguous stale lexemes (`no-ambiguous-stale-phrase`): "at its core", "delve", lowercase "revolutionary", bare "worth noting", and the sentence-opening "Overall,". They are prompts to rewrite where practical, not blocking findings; "worth noting" and "Overall," stay advisory because both have live legitimate uses.
- Fashionable tells (`no-fashionable-tell`): "underscores the", "poised to", "stark reminder", "marks a significant". Current-generation model idiom; state the consequence and let the size of the number carry the significance.
- Broader rhetorical flips beyond the bounded cleft; "not merely X", "isn't just X" used as recategorization rather than fact.
- Personification of named metrics (regex-detected for the known verb set, advisory because the general case needs judgment).
- Hedge stacks: two or more qualifiers on one claim ("could potentially", "might arguably"). One warranted "may" is required honesty, not a tell; technical and notice registers must keep it.
- Empty intensifiers, clickbait questions, nickname titles, slogan closers.
- Scoped words, advisory in editorial registers and unrestricted elsewhere: "quietly" (for unannounced or gradual change), "meanwhile" (as throat-clearing; legal for real simultaneity), "landscape" (as decoration; "regulatory landscape" in analysis is ordinary diction), "plumbing" (as garnish; literal settlement-infrastructure use is fine).
- "Obituary", "post-mortem", "carcass", "furniture" as casual market metaphors. Literal cemetery fields, actual obituaries, and published incident post-mortems are exempt by surface.
- A spaced hyphen used as a clause dash (advisory: it collides with tables, ranges, and arithmetic).

## Punctuation and labels

- Prose: do not use the em, en, figure, or horizontal-bar dash (U+2012 through U+2015), or a mathematical minus, between clauses in any register. Other Unicode dash-like glyphs are not scanner-enforced. This ban is anti-tell, not anti-journalism: the FT allows the dash; our generators were trained to overuse it as a signature.
- The ban must not mint a replacement tic. Answering every removed dash with a semicolon is the same signature in new punctuation, exactly as a uniform colon habit is in labels. Most clause dashes split into two sentences; reach for a colon or semicolon only where the logic calls for one.
- Signed values and arithmetic keep their correct glyphs. A style rule never rewrites a number.
- Ranges in running prose: "0 to 100". Compact UI ranges, compounds, identifiers: hyphen (`0-100`).
- Structured labels migrate off the " — " delimiter deterministically: source references become `Publisher: external title`; field/value controls become `Label: value`; annotation titles drop the delimiter, taking a comma for a simple apposition ("AUSD native launch on Sui, the first institutional USD stablecoin there") and a colon only when the gloss is a finite clause. Do not convert every dash to a colon: a uniform colon habit is the same tic wearing different punctuation. Right-hand sides that already contain a colon go to human review. Quoted external titles keep their original punctuation, always; a label that is a verbatim external headline is skipped and recorded, never rewritten.
- Label provenance is recorded in the data, not in a reviewer's memory. A label that is a verbatim external title carries `quoted: true` (`StablecoinLinkSchema`, `GeniusReferenceSchema`, `ChartAnnotation`), which the corpus gate reads as `ownership: "quoted"` and skips, and which every punctuation migration must leave untouched. Setting the flag is the prerequisite for migrating a label corpus: a skipped label with no flag is an undocumented decision, and the next migration would not know to skip it again.
- A label that is used as an identity reference is a key, not prose, and is permanently out of scope. Mint-authority control labels are the known case: `controlRef` may name a control by id, label, or `chain:address`, so rewriting such a label silently orphans the pointer and fails sidecar validation. Before migrating any label corpus, check whether the field is referenced elsewhere; if it is, leave it byte-identical and record it with reason `identity-reference`.

## Registers by surface

The voice stays fixed. Length, temperature, and job change. The enforcement registry maps each inventoried surface family to exactly one register.

| Register | Surfaces | Prescription |
| --- | --- | --- |
| Daily editorial | Daily digest | Lead with the highest-impact fact, numbers and historical context, 150 to 280 words plus a compact hook. Zero sharp lines is the default; one is the cap; sardonic stays available as a rare tone, never the default and never in consecutive editions (rotation-enforced). No manufactured menace on calm days. When the evidence contains a material observable trigger, name it; do not force a threshold ending onto every edition or into the final sentence. Anti-repetition rules (lead family, opening shape, tone rotation) are register rules and survive prompt composition. |
| Weekly synthesis | Weekly recap | The strictest temperature, not the loosest: it synthesizes a week and is the corpus most prone to performance. Causal arc from daily evidence, persistent moves vs reversals, honest scoring of prior expectations. No personified indexes. |
| Coin summary | AI summaries, `oneLiner` | 120 to 180 words as guidance, 250 as the hard ceiling; shorter is legal when the evidence is complete, and length above the band must be carried by evidence, not narration. One main claim per sentence. Title is a plain descriptor ("ETH-only immutable dollar") or a characterization this coin's own record supports ("Latency Ate the Backing", when it did); puns, mascots, rhymes, and generic slogans are banned, and the test is the same names-and-figures test as everywhere else: a title that would fit any other coin is generic, cut it. What the asset is, the central trade-off, what Pharos data reveals that a listing page would miss. Close on the durable constraint; no punch required. |
| Profile reference | `collateral`, `pegMechanism`, link labels | Compressed reference copy. Specific, factual, no wit, no marketing. Terms of art (PSM, CDP, attestation) allowed. |
| Pre-launch record | `launchPhaseDetail`, milestones, featured content | Dated factual record: what was announced, by whom, with what commitment. No predictions, no launch-copy excitement, no dash-glossed titles. |
| Notice | Exploit and incident notices | Urgent register: the event, the effect on holders, the source. Direct, calm, complete. No wit. |
| Lifecycle reason | Listing reviews, coverage notes, archive reasons | Operational register: event, effective date, concise rationale within field limits. Administrative, not urgent, unless the underlying event is. |
| Release note | Product changelog | Material change and its consequence for readers or operators. Wit is not available here. The headline names the moves the week actually had; a three-item shape is banned as a template. Descriptions stay literal and searchable. |
| Technical release note | Methodology changelogs | Technical register: precise deltas, version references, no editorial framing. |
| Long-form | Blog, case studies | Room for narrative and first person where they add provenance. All universal rules apply. Claims need dates, scope, receipts. Case studies teach sequence and mechanism before any moral. |
| Reference teaching | Learn hub, glossary, mechanism explainers | Definitions and mechanisms for a reader who wants to understand, with defined terms and no performance. Teaching basics is this register's job. |
| Page description | SEO and OG metadata, page leads | One or two plain sentences on what the page contains and why it is useful. No jokes, suspense, slogans, or unsupported uniqueness claims. |
| Cemetery | `obituary`, `epitaph` | Obituary: chronological, sober, complete; what failed, when, at what scale, what recovery attempts did not work. Epitaph: short; one evidence-backed barb permitted because the outcome is settled; no animal or mascot nicknames. |
| Technical evidence | Compliance, reserves, mint-authority, and risk-review sidecars | Accuracy, uncertainty, defined terms, and source fidelity outrank any flourish. Legal and protocol terminology required where exact. Completeness beats concision. |
| Analytical explanation | Selector and picker templates, deterministic risk explanations | Claim-safety rules in full: no recommendations, no unqualified safety or convenience claims, qualified comparisons only. |
| Product utility | UI labels, empty states, errors, CTAs, forms, transactional email, API copy | Direct and calm. No wit where a reader needs an instruction or warning. Error copy states what happened and what to do. |
| Brand | About, principles, funding narrative | The universal rules apply without exemption. Aphoristic "X, not Y" contrast is not a house voice; state the commitment and the evidence for it. |
| Alert | Telegram alerts, watchlist recaps, command replies | Fast, factual, scannable. Registered data-tied glyphs are a functional affordance, not decorative emoji. |
| Delivery wrapper | Telegram and X digest framing, footers, appendix copy | Utility register, not editorial; wrapper-owned strings pass the same scanner as the copy they frame. Scoped exemption: the cemetery-appendix footer rotation keeps its dark register as data-tied flavor, under a named allow. |

## Exemplars

Surface prompts carry full structural skeletons. Two compact calibration exemplars in the house voice, both fictional:

**Neutral daily paragraph, no sharp line:**

> EXAUSD's supply crossed $12.3B on Tuesday while $45.6M left its main Curve pool, the largest single-day outflow since March. The two moves point the same direction: minting concentrated in two addresses linked to the issuer's treasury, while third-party liquidity thinned. Redemption volume stayed ordinary. If the pool loses another $30M this week, exit depth drops below the coin's 30-day average redemption size.

**Neutral summary close, no punch:**

> The design has not changed since launch: spot BTC under institutional custody, hedged with COIN-M shorts. What has changed is the share of collateral at a single custodian, up from a third to over half in six months. The durable constraint is that redemption speed depends on one firm's operations desk.

**Daily paragraph at the ceiling, one earned dry line.** This is the cap, not the target; most editions use none:

> EXAUSD's issuer bought back $198M of its own coin across three venues on Tuesday, then described the week's 2.1% supply decline as organic rotation. The buyback wallet has carried the issuer's treasury tag since January and accounts for all but $26M of the $224M in net outflows. Redemptions at the official window stayed near zero. On this tape, the organic share of the rotation is $26M.

The closing line is legal because it is arithmetic against the issuer's own claim. Remove the figures and the claim, and the line has nothing left to say; that is the test every sharp line must pass.

## Scope and enforcement

- Only rules marked `hard` can block publication or fail CI; advisory findings feed prompts and review queues and never block on their own.
- Severity is declared per rule and register in the policy block; a word banned in editorial registers can be unrestricted in technical ones.
- The corrective cleft stays advisory, with a measured promotion path: cleft emission is read from the per-edition `editorialStyleGate` telemetry, and if clefts keep appearing in editorial registers across a full shadow window (more than one edition in 30), the rule is promoted to hard in daily, weekly, and coin-summary, where the one-retry contract bounds a false positive to a single regeneration rather than a blocked document.
- The advisory lexeme set is reviewed at each minor version against a sample of recent generated editions. Banned-phrase lists are a snapshot of model idiom and fossilize without re-examination.
- Applies to Pharos-owned prose on surfaces registered for corpus or runtime scanning. The registry is the operational scope; unregistered documentation and source families are not implicitly covered. Out of scope: quoted source text and external titles, user-submitted content, donor messages, issuer-provided text, code, identifiers, formulas, JSON keys, URLs, version strings.
- Runtime LLM surfaces: hard findings on model-owned fields get one corrective retry naming rule, field, and excerpt; unresolved hard findings block the edition. No silent punctuation repair. Wrapper-owned failures are channel-local: skip and alert that channel, never respend the model.
- Published editions carry the style version and policy hash that produced them. Editions authored before this policy carry no version and are surfaced as `pre-policy` at read time; archives are never edited or retroactively tagged.

## Final edit

1. What is the strongest fact, and does it appear early?
2. Does every conclusion have a visible number, source, mechanism, or precedent behind it?
3. Have I explained what the data means instead of repeating what the interface shows?
4. Can I remove a metaphor, contrast flip, hedge, or closing slogan without losing information? If the last sentence is removable, remove it.
5. Do the sentence lengths and openings vary when read aloud?
6. Did I nickname the asset? Did a metric act like a person?
7. Would the sharpest line survive a skeptical fact-check, and does it still work with the names and figures removed? If it does, it is generic; cut it.

## Machine-readable policy

Generated consumers read this block only. Editing it requires a monotonic `version` bump; prose-only edits above leave `version` and the policy hash unchanged.

```json editorial-policy
{
  "version": "1.2",
  "oneLineDirective": "Write like an FT markets reporter with the tape in front of you: strongest verified fact first, distinguish observation from inference, explain the consequence plainly, no clause dashes, no corrective \"this is not X, it is Y\", no personified metrics, no nickname titles, no slogan closers. Wit only if deleting the names and figures kills the line; the default is none.",
  "registers": [
    { "id": "daily", "label": "Daily editorial", "group": "editorial", "promptLine": "Lead with the highest-impact verified fact in 150 to 280 words plus a compact hook. Zero sharp lines is the default and one is the cap; sardonic is rare, never consecutive, and rotation-enforced. Preserve lead-family, opening-shape, and tone anti-repetition rules. Name a material observable trigger when the evidence contains one; never force a threshold ending." },
    { "id": "weekly", "label": "Weekly synthesis", "group": "editorial", "promptLine": "Build the week's causal arc from daily evidence, separate persistent moves from reversals, and score prior expectations honestly. This is the strictest temperature, not the loosest; never personify indexes." },
    { "id": "coin-summary", "label": "Coin summary", "group": "editorial", "promptLine": "120 to 180 words as guidance with a hard ceiling of 250; shorter is legal when the evidence is complete, and length above the band must be carried by evidence, not narration. One main claim per sentence. The title is a plain descriptor or a characterization this coin's own record supports; puns, mascots, rhymes, and generic slogans are banned, and a title that would fit any other coin is generic. Explain what the asset is, its central trade-off, and what Pharos data reveals that a listing page would miss. Close on the durable constraint; no punch required." },
    { "id": "cemetery", "label": "Cemetery", "group": "editorial", "promptLine": "Obituary: chronological, sober, complete. Epitaph: short, with one evidence-backed barb permitted because the outcome is settled. No animal or mascot nicknames." },
    { "id": "long-form", "label": "Long-form", "group": "editorial", "promptLine": "Narrative and first person are allowed where they add provenance. Claims need dates, scope, and receipts." },
    { "id": "profile-reference", "label": "Profile reference", "group": "technical", "promptLine": "Compressed reference copy: specific, factual, no wit, no marketing. Terms of art are allowed." },
    { "id": "pre-launch", "label": "Pre-launch record", "group": "technical", "promptLine": "Dated factual record: what was announced, by whom, with what commitment. No predictions, launch copy, or dash-glossed titles." },
    { "id": "notice", "label": "Notice", "group": "technical", "promptLine": "Urgent register: the event, the effect on holders, the source. Direct, calm, complete. No wit." },
    { "id": "lifecycle", "label": "Lifecycle reason", "group": "technical", "promptLine": "Operational register: event, effective date, concise rationale. Administrative unless the underlying event is urgent." },
    { "id": "release-note", "label": "Release note", "group": "technical", "promptLine": "Material change and its consequence for readers or operators. Wit is unavailable. Name the moves the period actually had; a three-item headline shape is banned as a template." },
    { "id": "technical-release-note", "label": "Technical release note", "group": "technical", "promptLine": "Precise deltas and version references, no editorial framing." },
    { "id": "reference-teaching", "label": "Reference teaching", "group": "technical", "promptLine": "Definitions and mechanisms with defined terms and no performance. Teaching basics is this register's job." },
    { "id": "technical-evidence", "label": "Technical evidence", "group": "technical", "promptLine": "Accuracy, uncertainty, defined terms, and source fidelity outrank flourish. Completeness beats concision." },
    { "id": "page-description", "label": "Page description", "group": "product", "promptLine": "One or two plain sentences on what the page contains and why it is useful. No jokes, suspense, slogans, or unsupported uniqueness claims." },
    { "id": "analytical-explanation", "label": "Analytical explanation", "group": "product", "promptLine": "Claim-safety rules in full: no recommendations, no unqualified safety or convenience claims, qualified comparisons only." },
    { "id": "product-utility", "label": "Product utility", "group": "product", "promptLine": "Direct and calm. No wit where a reader needs an instruction or warning. Error copy states what happened and what to do." },
    { "id": "brand", "label": "Brand", "group": "product", "promptLine": "Universal rules without exemption. State the commitment and the evidence for it; aphoristic contrast is not a house voice." },
    { "id": "alert", "label": "Alert", "group": "product", "promptLine": "Fast, factual, scannable. Registered data-tied glyphs are functional, not decorative." },
    { "id": "delivery-wrapper", "label": "Delivery wrapper", "group": "product", "promptLine": "Utility register, not editorial. Wrapper strings pass the same scanner as the copy they frame. The cemetery-appendix footer rotation alone keeps its dark data-tied flavor under a named exemption." }
  ],
  "rules": [
    {
      "id": "no-clause-dash",
      "promptLabel": "Never use em, en, figure, or horizontal-bar dashes. Use a period, comma, colon, or semicolon.",
      "patterns": [{ "source": "[\\u2012\\u2013\\u2014\\u2015]", "flags": "gu" }],
      "severity": { "default": "hard" },
      "exceptions": ["quoted-source", "external-title", "code", "identifier"],
      "replacementAdvice": "Most clause dashes split into two sentences; use a colon, comma, or semicolon only where the logic calls for one, and never answer every dash with the same mark.",
      "introducedIn": "1.0",
      "examples": {
        "violating": ["Supply fell — the peg held."],
        "clean": ["Scores run 0-100.", "The reserve holds 1-3 month Treasury bills.", "Keep the answer to 45-80 words."]
      }
    },
    {
      "id": "no-minus-as-dash",
      "promptLabel": "Never use a mathematical minus as a clause dash. Signed numbers keep their minus.",
      "patterns": [{ "source": "\\u2212(?![\\d.,])", "flags": "gu" }],
      "severity": { "default": "hard" },
      "exceptions": ["quoted-source", "code", "identifier", "numeric-sign"],
      "replacementAdvice": "A style rule never rewrites a number. If this is a clause break, use punctuation; if it is a signed value, keep it.",
      "introducedIn": "1.0",
      "examples": {
        "violating": ["Supply fell − the peg held."],
        "clean": ["PSI moved −5% on the day.", "Deviation was −0.3bps against the peg."]
      }
    },
    {
      "id": "no-corrective-cleft",
      "promptLabel": "Review pronoun-led corrective clefts such as \"this is not A, it is B\"; necessary technical distinctions can share this grammar.",
      "patterns": [
        { "source": "\\b(?:it|this|that|they)\\s+(?:is|was|are|were)\\s+not\\s+[^.,;:!?]{1,60}[,;]\\s+(?:it|this|that|they)\\s+(?:is|was|are|were)\\b", "flags": "giu" },
        { "source": "\\b(?:it|this|that|they)\\s+(?:is|was|are|were)n['\\u2019]t\\s+[^.,;:!?]{1,60}[,;]\\s+(?:it|this|that|they)\\s*(?:is|was|are|were|['\\u2019]s)\\b", "flags": "giu" }
      ],
      "severity": { "default": "advisory" },
      "exceptions": ["quoted-source"],
      "replacementAdvice": "Check whether this is a rhetorical flip. If so, state the fact and consequence directly; preserve necessary technical distinctions.",
      "introducedIn": "1.0",
      "examples": {
        "violating": ["This isn't a tweak; it's a rebuild."],
        "clean": ["The 72h backstop is not a weaker forecast-readiness score; it is the public accountability deadline.", "The $0.87 floor was not a loss of backing; it was the issuer codifying the redemption discount."]
      }
    },
    {
      "id": "no-corrective-cleft-split",
      "promptLabel": "Do not split a corrective cleft across two sentences (\"X is not A. It is B.\").",
      "patterns": [
        { "source": "\\b(?:It|This|That|They)\\s+(?:is|was|are|were)\\s+not\\s+[^.,;:!?]{1,60}\\.\\s+(?:It|This|That|They)\\s+(?:is|was|are|were)\\b", "flags": "gu" },
        { "source": "\\b(?:It|This|That|They)\\s+(?:is|was|are|were)n['\\u2019]t\\s+[^.,;:!?]{1,60}\\.\\s+(?:It|This|That|They)\\s*(?:is|was|are|were|['\\u2019]s)\\b", "flags": "gu" }
      ],
      "severity": { "default": "advisory" },
      "exceptions": ["quoted-source"],
      "replacementAdvice": "Advisory because a sentence boundary often separates two unrelated facts; a reviewer decides whether this is a rhetorical flip.",
      "introducedIn": "1.0",
      "examples": {
        "violating": ["This is not a coincidence. It is a preference."],
        "clean": ["Its timelock semantics were not resolved. It is retained as an evidence gap."]
      }
    },
    {
      "id": "no-suspense-opener",
      "promptLabel": "Never open with withheld-subject suspense (\"What it doesn't have is ...\").",
      "patterns": [{ "source": "(?:^|[.!?]\\s+)What\\s+(?:(?:it|this|that|they|[A-Z][A-Za-z0-9'\\u2019-]*(?:\\s+[A-Z][A-Za-z0-9'\\u2019-]*){0,3})\\s+(?:(?:does|do|did)\\s+(?:not|n['\\u2019]?t)\\s+(?:have|do|show)|lacks?))\\s+is\\b", "flags": "gmu" }],
      "severity": { "default": "hard" },
      "exceptions": ["quoted-source"],
      "replacementAdvice": "Put the substantive fact first.",
      "introducedIn": "1.0",
      "examples": {
        "violating": ["What it does not have is liquidity.", "What USDC lacks is users."],
        "clean": ["The guide quotes \"What it doesn't have is users\" as an anti-example."]
      }
    },
    {
      "id": "no-stale-phrase",
      "promptLabel": "Never use context-independent boilerplate: testament to, time will tell, it remains to be seen, in a world where, game-changing, cutting-edge, needless to say, it's worth noting or it is worth noting, or a sentence opened with In summary, or In conclusion,.",
      "patterns": [
        { "source": "\\btestament to\\b", "flags": "giu" },
        { "source": "\\btime will tell\\b", "flags": "giu" },
        { "source": "\\bit remains to be seen\\b", "flags": "giu" },
        { "source": "\\bin a world where\\b", "flags": "giu" },
        { "source": "\\bgame[- ]changing\\b", "flags": "giu" },
        { "source": "\\bcutting[- ]edge\\b", "flags": "giu" },
        { "source": "\\bneedless to say\\b", "flags": "giu" },
        { "source": "\\bit(?:['\\u2019]s|\\s+is)\\s+worth noting\\b", "flags": "giu" },
        { "source": "(?:^|[.!?]\\s+)In (?:summary|conclusion),", "flags": "gmu" }
      ],
      "severity": { "default": "hard" },
      "exceptions": ["quoted-source", "external-title"],
      "replacementAdvice": "Delete the phrase and state the fact.",
      "introducedIn": "1.0",
      "examples": {
        "violating": ["The growth is a testament to demand.", "It is worth noting that supply fell.", "In conclusion, the peg held."],
        "clean": ["The testamentary trust holds the shares.", "The conclusion of the audit is dated June 2026."]
      }
    },
    {
      "id": "no-ambiguous-stale-phrase",
      "promptLabel": "Avoid ambiguous stale phrasing where context permits: at its core, delve, lowercase revolutionary, bare worth noting, and a sentence opened with Overall,.",
      "patterns": [
        { "source": "\\bat its core\\b", "flags": "giu" },
        { "source": "\\bdelv(?:e|es|ed|ing)\\b", "flags": "giu" },
        { "source": "\\brevolutionary\\b", "flags": "gu" },
        { "source": "\\bworth noting\\b", "flags": "giu" },
        { "source": "(?:^|[.!?]\\s+)Overall,", "flags": "gmu" }
      ],
      "severity": { "default": "advisory" },
      "exceptions": ["quoted-source", "external-title"],
      "replacementAdvice": "Prefer the specific mechanism; preserve legitimate historical or proper-name use.",
      "introducedIn": "1.1",
      "examples": {
        "violating": ["At its core, the protocol is a CDP.", "We delve into the reserve report.", "The design is revolutionary.", "Overall, the design held up.", "The reserve mix is worth noting."],
        "clean": ["Revolutionary Finance Ltd. issued the token.", "The overall grade stayed at B+."]
      }
    },
    {
      "id": "no-fashionable-tell",
      "promptLabel": "Avoid the fashionable tells: underscores the, poised to, stark reminder, marks a significant. State the consequence and let the size of the number carry the significance.",
      "patterns": [
        { "source": "\\bunderscor(?:es|ed|ing)\\s+(?:the|its|their|how|that|why|a|an)\\b", "flags": "giu" },
        { "source": "\\bpoised to\\b", "flags": "giu" },
        { "source": "\\bstark reminder\\b", "flags": "giu" },
        { "source": "\\bmark(?:s|ed)? a significant\\b", "flags": "giu" }
      ],
      "severity": { "default": "advisory" },
      "exceptions": ["quoted-source", "external-title"],
      "replacementAdvice": "Name the consequence directly; a number that matters does not need to be told it is significant.",
      "introducedIn": "1.2",
      "examples": {
        "violating": ["The freeze underscores the custodian's control.", "The issuer is poised to expand.", "The outage is a stark reminder of oracle dependence.", "The vote marks a significant shift."],
        "clean": ["Provider ids with underscores are normalized before matching.", "The freeze shows the custodian can halt transfers unilaterally."]
      }
    },
    {
      "id": "no-hedged-closer",
      "promptLabel": "Never close on: worth watching, worth monitoring, bears watching, for now, the question is whether. Name the next observable threshold instead.",
      "patterns": [
        { "source": "\\b(?:worth|bears?)\\s+(?:watching|monitoring)[.!?]?\\s*$", "flags": "giu" },
        { "source": "\\bfor now[.!?]?\\s*$", "flags": "giu" },
        { "source": "\\bthe (?:real )?question is whether\\b[^.!?]*[.!?]?\\s*$", "flags": "giu" }
      ],
      "closerOnly": true,
      "severity": { "default": "hard" },
      "exceptions": ["quoted-source"],
      "replacementAdvice": "Say what to watch, when, and what it would mean.",
      "introducedIn": "1.0",
      "examples": {
        "violating": ["Supply fell 4%. The pool is worth watching. (Source: issuer report)"],
        "clean": ["The cap stays unchanged for now because no vote has passed."]
      }
    },
    {
      "id": "no-dead-metaphor",
      "promptLabel": "In editorial registers never use: beneath the calm, surface calm, restless depths, or something moving underneath.",
      "patterns": [
        { "source": "\\bbeneath the calm\\b", "flags": "giu" },
        { "source": "\\bsurface calm\\b", "flags": "giu" },
        { "source": "\\brestless depths\\b", "flags": "giu" },
        { "source": "\\bsomething (?:is )?moving underneath\\b", "flags": "giu" }
      ],
      "severity": { "default": "advisory", "byRegister": { "daily": "hard", "weekly": "hard", "coin-summary": "hard", "cemetery": "hard", "long-form": "hard" } },
      "exceptions": ["quoted-source"],
      "replacementAdvice": "Describe the mechanism instead of the weather.",
      "introducedIn": "1.0",
      "examples": {
        "violating": ["Beneath the calm, redemptions accelerated."],
        "clean": ["The headline figure belies a change in reserve composition.", "The cable remains below the waterline."]
      }
    },
    {
      "id": "no-unqualified-safety",
      "promptLabel": "Never make unqualified safety claims: safe, safest, risk-free, low-risk, guaranteed. Rankings name metric, scope, and date.",
      "patterns": [
        { "source": "(?<![A-Za-z-])safe(?!\\s+harbou?r\\b)(?![A-Za-z-])", "flags": "gu" },
        { "source": "(?<![A-Za-z-])safest(?![A-Za-z-])", "flags": "giu" },
        { "source": "\\brisk[- ]free\\b", "flags": "giu" },
        { "source": "\\blow[- ]risk\\b", "flags": "giu" },
        { "source": "(?<!no )\\bguarantee(?:d|s)?\\b(?!\\s+(?:schemes?|funds?)\\b)(?!\\s+by\\s+(?:the\\s+)?issuer\\b)", "flags": "giu" }
      ],
      "severity": { "default": "advisory", "byRegister": { "profile-reference": "hard", "page-description": "hard", "analytical-explanation": "hard", "product-utility": "hard", "brand": "hard", "alert": "hard", "delivery-wrapper": "hard" } },
      "exceptions": ["quoted-source", "external-title", "legal-term"],
      "replacementAdvice": "Name the metric, scope, and date, or drop the claim.",
      "introducedIn": "1.0",
      "examples": {
        "violating": ["USDC is a low-risk place to park dollars."],
        "clean": ["MiCA safe harbor", "There is no guarantee", "deposit guarantee scheme", "deposit guarantee schemes", "guaranteed by the issuer", "guarantee fund", "Control sits with a 3-of-5 Safe.", "The asset is not a safe-haven trade."]
      }
    },
    {
      "id": "no-investment-recommendation",
      "promptLabel": "Never recommend buying, holding, selling, or switching.",
      "patterns": [
        { "source": "\\bwe recommend(?:\\s+(?:you\\s+)?(?:buy|hold|sell|switch|move|use))?\\b", "flags": "giu" },
        { "source": "\\byou should (?:buy|hold|sell|switch|move)\\b", "flags": "giu" },
        { "source": "\\bPharos recommends?\\b", "flags": "giu" },
        { "source": "(?:^|[.!?]\\s+)(?:Buy|Hold|Sell)\\s+(?:[A-Z][A-Z0-9]{1,9}|the\\s+(?:asset|coin|token)|this\\s+(?:asset|coin|token))\\b", "flags": "gmu" },
        { "source": "(?:^|[.!?]\\s+)Use\\s+[A-Z][A-Z0-9]{1,9}\\s+for\\s+(?:venue access|custody|yield|trading)\\b", "flags": "gmu" },
        { "source": "\\b(?:investors?|holders?|users?)\\s+should\\s+(?:consider\\s+)?(?:buying|holding|selling|switching|moving|using)\\b", "flags": "giu" },
        { "source": "\\b(?:our|the)\\s+top\\s+recommendation\\s+is\\s+to\\s+(?:buy|hold|sell|switch|move|use)\\b", "flags": "giu" },
        { "source": "\\b[A-Z][A-Z0-9]{1,9}\\s+is\\s+(?:the\\s+)?best\\s+buy\\b", "flags": "gu" },
        { "source": "\\b(?:our|Pharos['\\u2019]s)\\s+top pick\\b", "flags": "giu" },
        { "source": "\\bhold safely\\b", "flags": "giu" }
      ],
      "severity": { "default": "hard" },
      "exceptions": ["quoted-source"],
      "replacementAdvice": "Describe the trade-off and let the reader decide.",
      "introducedIn": "1.0",
      "examples": {
        "violating": ["Buy USDC.", "Investors should consider switching to USDC.", "Our top recommendation is to hold USDC.", "USDC is the best buy."],
        "clean": ["The policy bans the phrase top pick.", "The issuer called USDC its top pick."]
      }
    },
    {
      "id": "no-unqualified-convenience",
      "promptLabel": "Do not claim an asset or route is easy, simple, or convenient without naming the concrete operational property.",
      "patterns": [
        { "source": "\\b(?:easy|simple|convenient)\\s+(?:way|option|choice|asset|coin|stablecoin|route|solution|tool)\\b", "flags": "giu" },
        { "source": "\\b(?:easy|simple|convenient)\\s+(?:to|for)\\b", "flags": "giu" },
        { "source": "\\b(?:is|are|was|were)\\s+(?:easy|simple|convenient)\\b", "flags": "giu" }
      ],
      "severity": { "default": "off", "byRegister": { "analytical-explanation": "hard" } },
      "exceptions": ["quoted-source", "external-title"],
      "replacementAdvice": "Name the steps, access constraint, cost, or venue coverage that makes the route convenient.",
      "introducedIn": "1.1",
      "examples": {
        "violating": ["USDC is easy to use.", "This is a convenient option for custody."],
        "clean": ["The calculation uses a simple moving average."]
      }
    },
    {
      "id": "review-unsupported-reliability",
      "promptLabel": "Review probably, likely, and reliably in deterministic risk explanations; attach evidence or state the uncertainty directly.",
      "patterns": [{ "source": "\\b(?:probably|likely|reliably)\\b", "flags": "giu" }],
      "severity": { "default": "off", "byRegister": { "analytical-explanation": "advisory" } },
      "exceptions": ["quoted-source", "external-title"],
      "replacementAdvice": "Attach the probability, evidence, or mechanism behind the reliability claim.",
      "introducedIn": "1.1",
      "examples": {
        "violating": ["Redemptions will probably remain open."],
        "clean": []
      }
    },
    {
      "id": "no-marketing-social-proof",
      "promptLabel": "Do not use trusted by or battle-tested as unsupported social proof in analytical explanations.",
      "patterns": [
        { "source": "\\btrusted by\\b", "flags": "giu" },
        { "source": "\\bbattle[- ]tested\\b", "flags": "giu" }
      ],
      "severity": { "default": "off", "byRegister": { "analytical-explanation": "hard" } },
      "exceptions": ["quoted-source", "external-title"],
      "replacementAdvice": "Replace social proof with dated usage, incident, or operational evidence.",
      "introducedIn": "1.1",
      "examples": {
        "violating": ["The route is battle-tested.", "The coin is trusted by institutions."],
        "clean": []
      }
    },
    {
      "id": "review-unqualified-superlative",
      "promptLabel": "Review bare rankings and superlatives; name the metric, scope, and date.",
      "patterns": [
        { "source": "(?:^|[.!?]\\s+)(?=[^.!?]{0,180}\\b(?:largest|strongest|highest[- ]quality|best)\\b)(?![^.!?]{0,180}\\b(?:among|within|as of|liquidity score|market cap(?:italization)?|circulating supply|redemption depth|yield|20\\d{2})\\b)[^.!?]{0,180}(?:[.!?]|$)", "flags": "gimu" }
      ],
      "severity": { "default": "off", "byRegister": { "daily": "advisory", "weekly": "advisory", "coin-summary": "advisory", "profile-reference": "advisory", "page-description": "advisory", "analytical-explanation": "advisory", "product-utility": "advisory", "brand": "advisory", "alert": "advisory", "delivery-wrapper": "advisory" } },
      "exceptions": ["quoted-source", "external-title"],
      "replacementAdvice": "Add the metric, comparison universe, and date, or remove the ranking.",
      "introducedIn": "1.1",
      "examples": {
        "violating": ["USDC is the largest stablecoin.", "This is the strongest design.", "The highest-quality reserve is here."],
        "clean": ["USDC had the highest liquidity score among tracked USD coins in June 2026."]
      }
    },
    {
      "id": "review-unattributed-technical-risk",
      "promptLabel": "Review technical risk labels that do not name a methodology or source.",
      "patterns": [
        { "source": "(?:^|[.!?]\\s+)(?=[^.!?]{0,180}\\b(?:high|medium|low)[- ]risk\\b)(?![^.!?]{0,180}\\b(?:according to|under|rated|methodology|score|audit|report|source|Pharos V\\d+)\\b)[^.!?]{0,180}(?:[.!?]|$)", "flags": "gimu" }
      ],
      "severity": { "default": "off", "byRegister": { "daily": "advisory", "weekly": "advisory", "coin-summary": "advisory", "profile-reference": "advisory", "page-description": "advisory", "analytical-explanation": "advisory", "product-utility": "advisory", "brand": "advisory", "alert": "advisory", "delivery-wrapper": "advisory" } },
      "exceptions": ["quoted-source", "external-title"],
      "replacementAdvice": "Name the methodology, rating, audit, or source behind the risk label.",
      "introducedIn": "1.1",
      "examples": {
        "violating": ["This is a high-risk redemption route."],
        "clean": ["Pharos V9 rates the route high-risk under the exit methodology."]
      }
    },
    {
      "id": "no-booster-language",
      "promptLabel": "No booster language, empty intensifiers, exclamation marks, or clickbait questions.",
      "patterns": [
        { "source": "\\bbuckle up\\b", "flags": "giu" },
        { "source": "\\b(?:truly|incredibly|massively|hugely) (?:remarkable|impressive|significant)\\b", "flags": "giu" },
        { "source": "!", "flags": "gu" },
        { "source": "(?:^|[.!?]\\s+)(?:Can you believe|Guess what|What happens next|Ready to|Want to know)[^?]*\\?", "flags": "gimu" }
      ],
      "severity": { "default": "advisory", "byRegister": { "daily": "hard", "weekly": "hard", "coin-summary": "hard" } },
      "exceptions": ["quoted-source"],
      "replacementAdvice": "Let the number carry the emphasis.",
      "introducedIn": "1.0",
      "examples": {
        "violating": ["Supply jumped 40%!", "Buckle up, the peg moved."],
        "clean": ["Supply increased 40% after the vote."]
      }
    },
    {
      "id": "no-personified-metric",
      "promptLabel": "Named indexes, scores, gauges, and regimes do not nap, shrug, yawn, notice, refuse, or applaud. State what the number did.",
      "patterns": [
        { "source": "\\b(?:PSI|DEWS|the index|the score|the gauge|the model|the market|the tape|the regime)\\s+(?:napp?ed|naps|shrugg?ed|shrugs|yawn(?:ed|s)?|notic(?:ed|es)|refus(?:ed|es)|applaud(?:ed|s)|sleeps|slept)\\b", "flags": "giu" },
        { "source": "\\bleft the building\\b", "flags": "giu" }
      ],
      "severity": { "default": "advisory" },
      "exceptions": ["quoted-source"],
      "replacementAdvice": "Name the movement and its size.",
      "introducedIn": "1.0",
      "examples": {
        "violating": ["The model shrugged at the outflow."],
        "clean": ["The model score fell by four points."]
      }
    },
    {
      "id": "no-hedge-stack",
      "promptLabel": "Do not stack qualifiers. One warranted qualifier is honesty; three is mush.",
      "patterns": [
        { "source": "\\bcould potentially\\b", "flags": "giu" },
        { "source": "\\bmight arguably\\b", "flags": "giu" },
        { "source": "\\bmay possibly\\b", "flags": "giu" },
        { "source": "\\bsomewhat (?:arguably|possibly|potentially)\\b", "flags": "giu" }
      ],
      "severity": { "default": "advisory" },
      "exceptions": ["quoted-source"],
      "replacementAdvice": "Keep one qualifier or state the uncertainty directly.",
      "introducedIn": "1.0",
      "examples": {
        "violating": ["Redemptions could potentially slow."],
        "clean": ["Redemptions may slow while the pause remains active."]
      }
    },
    {
      "id": "no-recategorizing-flip",
      "promptLabel": "Avoid \"not merely X\" and \"isn't just X\" used to recategorize rather than to state a fact.",
      "patterns": [
        { "source": "\\bnot (?:merely|simply)\\b", "flags": "giu" },
        { "source": "\\b(?:is|are|was|were)n['\\u2019]t just\\b", "flags": "giu" },
        { "source": "\\b(?:is|are|was|were) not just\\b", "flags": "giu" }
      ],
      "severity": { "default": "advisory" },
      "exceptions": ["quoted-source"],
      "replacementAdvice": "Say what it is, with the evidence.",
      "introducedIn": "1.0",
      "examples": {
        "violating": ["This is not merely a reserve change."],
        "clean": ["The report covers cash, not liabilities."]
      }
    },
    {
      "id": "scoped-decorative-word",
      "promptLabel": "In editorial registers avoid decorative uses of: quietly, meanwhile, landscape, plumbing.",
      "patterns": [
        { "source": "\\bquietly\\b", "flags": "giu" },
        { "source": "\\bmeanwhile\\b", "flags": "giu" },
        { "source": "\\blandscape\\b", "flags": "giu" },
        { "source": "\\bplumbing\\b", "flags": "giu" }
      ],
      "severity": { "default": "off", "byRegister": { "daily": "advisory", "weekly": "advisory", "coin-summary": "advisory", "cemetery": "advisory", "long-form": "advisory" } },
      "exceptions": ["quoted-source", "external-title"],
      "replacementAdvice": "Describe the timing, visibility, or mechanism instead.",
      "introducedIn": "1.0",
      "examples": {
        "violating": ["Meanwhile, liquidity fell."],
        "clean": ["The regulatory framework changed in June."]
      }
    },
    {
      "id": "scoped-market-metaphor",
      "promptLabel": "Do not use obituary, post-mortem, carcass, or furniture as casual market metaphors.",
      "patterns": [
        { "source": "\\bobituar(?:y|ies)\\b", "flags": "giu" },
        { "source": "\\bpost[- ]?mortem\\b", "flags": "giu" },
        { "source": "\\bcarcass\\b", "flags": "giu" },
        { "source": "\\bfurniture\\b", "flags": "giu" }
      ],
      "severity": { "default": "off", "byRegister": { "daily": "advisory", "weekly": "advisory", "coin-summary": "advisory" } },
      "exceptions": ["quoted-source", "external-title", "literal-cemetery"],
      "replacementAdvice": "Use the literal event or outcome.",
      "introducedIn": "1.0",
      "examples": {
        "violating": ["The token became market furniture."],
        "clean": []
      }
    },
    {
      "id": "spaced-hyphen-clause-dash",
      "promptLabel": "Do not use a spaced hyphen as a clause dash.",
      "patterns": [{ "source": "(?<=\\S) - (?=\\S)", "flags": "gu" }],
      "severity": { "default": "advisory" },
      "exceptions": ["quoted-source", "code", "identifier", "numeric-sign", "table"],
      "replacementAdvice": "Use a colon, comma, semicolon, or period.",
      "introducedIn": "1.0",
      "examples": {
        "violating": ["Supply fell - the peg held."],
        "clean": ["Scores run 0-100.", "The reserve holds 1-3 month Treasury bills.", "Keep the answer to 45-80 words."]
      }
    }
  ]
}
```
