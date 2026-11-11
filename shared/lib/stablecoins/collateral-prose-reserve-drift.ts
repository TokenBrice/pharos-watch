import type { StablecoinMeta } from "../../types";

/**
 * Guardrail for one specific curation failure: a `collateral` prose field
 * written from a **governance-approved / eligible** asset list rather than from
 * the **observed** balances the reviewed `reserves` slices record.
 *
 * The archetype is `frxusd-frax`, whose prose named "Superstate USTB ... and
 * USCC, Centrifuge JTRSY, ... Agora AUSD, and Circle USDC" while every observed
 * frxUSD balance sheet held only WTGXX / USTB / BUIDL / USDB / EREBOR_USD. The
 * approved-custodian set had been transcribed as if it were the reserve.
 *
 * This is deliberately a **report, not a gate**. Collateral prose legitimately
 * names non-reserve entities all the time — look-through constituents one level
 * inside a wrapper slice, predecessor tokens, PSM swap counterparties, borrow
 * markets that are not mint collateral. So each finding carries a `tier`:
 *
 * - `tier: 1` — the sentence naming the absent ticker also carries **eligibility
 *   modality** (approved / accepted / eligible / permitted / whitelisted /
 *   supported / can also hold / governance-*). That is the frxUSD signature and
 *   the queue a curator should actually read.
 * - `tier: 2` — the ticker is absent but nothing in the clause claims it is
 *   admissible backing. This is the noise floor the check must tolerate.
 *
 * Nothing here fails a build; `severity` exists so the caller can print tier 1
 * loudly and tier 2 as a single count.
 */

export type CollateralProseReserveDriftTier = 1 | 2;

export interface CollateralProseReserveDriftFinding {
  readonly coinId: string;
  readonly symbol: string;
  readonly tier: CollateralProseReserveDriftTier;
  readonly severity: "warning" | "info";
  /** Tracked symbols/coin IDs named in the prose that appear in no reviewed slice. */
  readonly absentReferences: readonly string[];
  /** The clause that triggered tier 1, when there is one. */
  readonly modalClause: string | null;
  readonly message: string;
}

/**
 * Eligibility modality: wording that presents an asset as admissible backing
 * rather than as observed backing. `supported`/`accepted` catch the CDP and PSM
 * allowlists; `governance-` catches frxUSD's own "governance-approved enshrined
 * custodians".
 */
const ELIGIBILITY_MODALITY_PATTERN =
  /\b(?:governance-approved|governance-set|governance-managed|governance-approval|approve|approved|approves|accept|accepts|accepted|accepting|eligible|eligibility|permitted|permits|whitelisted|allowlisted|supported|supports|admissible|can hold|can also hold)\b/i;

/**
 * Explicit non-holding disclosure. A clause that names an eligible asset *and*
 * says it is not actually held is the corrected form of this defect, not an
 * instance of it — so it must not keep warning after a curator fixes it.
 * This is what separates "governance has approved AUSD; no balance has been
 * observed" from the original prose that simply listed AUSD as a reserve, and
 * it is also why `hbusdt-hyperbeat` ("Direct USDT is not an accepted deposit
 * asset"), `msusd-metronome` ("accepted but currently inactive") and
 * `money-defi-money` ("rather than a fixed USDC reserve portfolio") are not
 * defects.
 */
const NON_HOLDING_DISCLOSURE_PATTERNS = [
  /\bno\b[^.;]{0,48}\b(?:balance|balances|position|positions|holding|holdings|exposure)\b/i,
  /\b(?:not held|not currently held|not an accepted|not accepted|not eligible|not approved|not supported|currently inactive|but inactive|rather than)\b/i,
] as const;

function disclosesNonHolding(clause: string): boolean {
  return NON_HOLDING_DISCLOSURE_PATTERNS.some((pattern) => pattern.test(clause));
}

/**
 * Abbreviations whose internal periods must not end a clause. Missing "U.S."
 * here is not cosmetic: it chops frxUSD's own collateral line into fragments
 * and the modality clause loses every ticker that follows it.
 */
const PROTECTED_ABBREVIATIONS = [
  "U.S.",
  "U.K.",
  "U.A.E.",
  "e.g.",
  "i.e.",
  "etc.",
  "Inc.",
  "Ltd.",
  "Co.",
  "No.",
  "vs.",
  "approx.",
] as const;

const PERIOD_GUARD = "\u0000";

/**
 * Clause split, not sentence split: `;` separates the eligibility clauses these
 * fields are actually written in. `:` is deliberately NOT a delimiter — frxUSD's
 * modality ("held by governance-approved enshrined custodians:") introduces the
 * ticker list that follows it, and splitting there would hide the defect.
 */
function splitClauses(prose: string): string[] {
  let guarded = prose;
  for (const abbreviation of PROTECTED_ABBREVIATIONS) {
    guarded = guarded.split(abbreviation).join(abbreviation.replaceAll(".", PERIOD_GUARD));
  }

  return guarded
    .split(/(?<=[.!?;])\s+/)
    .map((clause) => clause.replaceAll(PERIOD_GUARD, ".").trim())
    .filter((clause) => clause.length > 0);
}

/**
 * Ticker-shaped words only. Requiring the word to be all-caps is what keeps
 * "Money", "Honey", "Aid" and "Cash" out of a symbol table that contains
 * MONEY, HONEY, AID and CASH, and requiring an exact match keeps "USDC.e"
 * from reading as USDC (only a trailing sentence period is trimmed).
 */
const WORD_PATTERN = /[A-Za-z][A-Za-z0-9.]*/g;

/**
 * Tracked symbols that collide with generic prose acronyms. `CDP` is a tracked
 * symbol (`cdp-enosys`) and also the ordinary noun every CDP stablecoin's
 * collateral line uses; matching it produces only false positives. Keep this
 * list minimal and justified — it is a suppression, not a policy.
 */
const AMBIGUOUS_TICKER_WORDS = new Set(["CDP"]);

function tickerWords(text: string): string[] {
  return (text.match(WORD_PATTERN) ?? [])
    .map((word) => word.replace(/\.+$/, ""))
    .filter((word) => word.length >= 2 && word === word.toUpperCase() && /[A-Z]/.test(word));
}

function buildReviewedSliceVocabulary(coin: StablecoinMeta, symbolByCoinId: ReadonlyMap<string, string>): Set<string> {
  const vocabulary = new Set<string>();
  for (const slice of coin.reserves ?? []) {
    for (const word of tickerWords(`${slice.name} ${slice.issuerOrObligor ?? ""}`)) {
      vocabulary.add(word);
    }
    if (slice.coinId) {
      vocabulary.add(slice.coinId.toLowerCase());
      const sliceSymbol = symbolByCoinId.get(slice.coinId);
      if (sliceSymbol) vocabulary.add(sliceSymbol.toUpperCase());
    }
  }
  return vocabulary;
}

function hasReviewedComposition(coin: StablecoinMeta): boolean {
  return (coin.reserves?.length ?? 0) > 0 && coin.reserveReview != null;
}

/**
 * @param coins the full merged catalog — the tracked-symbol table is built from
 *   it, so pass every readable coin, not a filtered subset.
 */
export function findCollateralProseReserveDriftFindings(
  coins: readonly StablecoinMeta[],
): CollateralProseReserveDriftFinding[] {
  const symbolByCoinId = new Map(coins.map((coin) => [coin.id, coin.symbol] as const));
  const trackedSymbols = new Set(coins.map((coin) => coin.symbol.toUpperCase()));
  const trackedCoinIds = coins.map((coin) => coin.id.toLowerCase());

  const findings: CollateralProseReserveDriftFinding[] = [];

  for (const coin of coins) {
    const prose = coin.collateral?.trim();
    if (!prose || !hasReviewedComposition(coin)) continue;

    const vocabulary = buildReviewedSliceVocabulary(coin, symbolByCoinId);
    const ownSymbol = coin.symbol.toUpperCase();
    const ownId = coin.id.toLowerCase();

    // reference -> the eligibility clause it appeared in, or null.
    const absent = new Map<string, string | null>();
    const record = (reference: string, modalClause: string | null): void => {
      // A modal clause wins: the same reference may appear in several clauses
      // and only the eligibility one is the frxUSD signature.
      if (!absent.has(reference) || (modalClause !== null && absent.get(reference) === null)) {
        absent.set(reference, modalClause);
      }
    };

    for (const clause of splitClauses(prose)) {
      const modalClause =
        ELIGIBILITY_MODALITY_PATTERN.test(clause) && !disclosesNonHolding(clause) ? clause : null;
      const lowerClause = clause.toLowerCase();

      for (const word of tickerWords(clause)) {
        if (word === ownSymbol) continue;
        if (AMBIGUOUS_TICKER_WORDS.has(word)) continue;
        if (!trackedSymbols.has(word)) continue;
        if (vocabulary.has(word)) continue;
        record(word, modalClause);
      }

      for (const coinId of trackedCoinIds) {
        if (coinId === ownId) continue;
        if (!lowerClause.includes(coinId)) continue;
        if (vocabulary.has(coinId)) continue;
        record(coinId, modalClause);
      }
    }

    if (absent.size === 0) continue;

    const absentReferences = [...absent.keys()].sort();
    const modalClause = [...absent.values()].find((clause): clause is string => clause !== null) ?? null;
    const tier: CollateralProseReserveDriftTier = modalClause === null ? 2 : 1;

    findings.push({
      coinId: coin.id,
      symbol: coin.symbol,
      tier,
      severity: tier === 1 ? "warning" : "info",
      absentReferences,
      modalClause,
      message:
        `collateral prose names ${absentReferences.join(", ")}, absent from every reviewed reserve slice` +
        (modalClause === null
          ? " (no eligibility modality; likely look-through or taxonomy naming)"
          : ` in an eligibility clause: "${modalClause}"`),
    });
  }

  return findings.sort((a, b) => a.tier - b.tier || a.coinId.localeCompare(b.coinId));
}
