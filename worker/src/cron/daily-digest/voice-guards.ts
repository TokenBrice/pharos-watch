
const OPENING_PSI_VERBS = new Set([
  "sits", "sat", "slipped", "ticked", "held", "holds", "climbed", "climbs",
  "dropped", "drops", "fell", "falls", "reads", "read", "settles", "settled",
  "rises", "rose", "opened", "opens", "landed", "lands", "clawed", "claws",
  "extended", "extends", "hovers", "hovered", "gained", "gains",
  "clung", "clings", "edges", "edged", "tracks", "tracked",
]);

export function openingFingerprint(text: string): string | null {
  const firstSentence = text.trim().split(/[.!?\n]/)[0]?.trim() ?? "";
  if (!firstSentence) return null;
  const tokens = firstSentence.split(/\s+/).slice(0, 4);
  if (tokens.length < 2) return null;
  const head = tokens[0].replace(/[^A-Za-z]/g, "");
  const second = tokens[1].replace(/[^A-Za-z]/g, "").toLowerCase();
  if (head.toUpperCase() === "PSI" && OPENING_PSI_VERBS.has(second)) return "psi-verb";
  if (OPENING_PSI_VERBS.has(second)) return `${head.toUpperCase()}-verb`;
  return `${head.toUpperCase()}-${second}`;
}

const STRUCTURAL_NGRAM_SIZE = 5;

function structuralNgrams(text: string): Set<string> {
  // Removing digits preserves sentence shape without treating a changed date,
  // score, or threshold as fresh prose. Apostrophes intentionally split so
  // "tomorrow's snapshot" and "tomorrow s snapshot" normalize alike.
  const tokens = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const ngrams = new Set<string>();
  for (let index = 0; index <= tokens.length - STRUCTURAL_NGRAM_SIZE; index++) {
    ngrams.add(tokens.slice(index, index + STRUCTURAL_NGRAM_SIZE).join(" "));
  }
  return ngrams;
}

export function findRepeatedStructuralNgrams(
  text: string,
  recentTexts: readonly string[],
  minimumPriorEditions = 2,
): string[] {
  if (minimumPriorEditions < 1) return [];
  const current = structuralNgrams(text);
  if (current.size === 0) return [];
  const prior = recentTexts.map(structuralNgrams);
  return [...current]
    .filter((ngram) => prior.filter((entry) => entry.has(ngram)).length >= minimumPriorEditions)
    .slice(0, 3);
}

const FORWARD_LOOK_CUES: RegExp[] = [
  /\bif\s+[\w$]+\s+(?:happens|holds|fails|breaks|crosses|stays|continues|keeps|slips|rises|falls|passes|drops)\b/i,
  /\bnext (?:session|day|digest|week|cycle|round|24h|48h|month)\b/i,
  /\bcoming (?:days?|week|month|session)\b/i,
  /\bwatch (?:for|the|if|when)\b/i,
  /\bto watch\b/i,
  /\btrigger\b/i,
  /\bthreshold\b/i,
  /\btip(?:s|ping)? over\b/i,
  /\bsnap (?:back|down)\b/i,
  /\b(?:will|could|should) (?:be|look|matter|decide|tell)\b/i,
  /\bnext (?:trigger|milestone|test|move)\b/i,
];

export function hasForwardLook(text: string): boolean {
  return FORWARD_LOOK_CUES.some((re) => re.test(text));
}

export type LeadFamily = "psi" | "depeg" | "dews" | "flow" | "risk" | "macro" | "other";

export function leadFamily(lead: string | undefined): LeadFamily | undefined {
  if (!lead) return undefined;
  if (lead.startsWith("psi-") || lead === "psi") return "psi";
  if (lead.includes("depeg")) return "depeg";
  if (lead.startsWith("dews")) return "dews";
  if (
    lead === "ftq"
    || lead.startsWith("mint-burn")
    || lead.startsWith("gauge-")
    || lead.startsWith("supply-")
    || lead === "chain-migration"
  ) return "flow";
  if (
    lead === "grade-transition"
    || lead === "yield-anomaly"
    || lead === "liquidity-shift"
    || lead === "blacklist-contrast"
    || lead === "reserve-event"
  ) return "risk";
  if (
    lead === "macro-observation"
    || lead === "market-structure"
    || lead === "issuer-concentration"
    || lead === "regime-divergence"
  ) return "macro";
  return "other";
}
