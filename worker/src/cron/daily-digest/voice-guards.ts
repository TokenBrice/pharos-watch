/** Tics banned anywhere in the output. */
const FORBIDDEN_TICS_ANYWHERE: { pattern: RegExp; label: string }[] = [
  { pattern: /\bplumbing\b/i, label: "plumbing" },
  { pattern: /\bbeneath the (?:calm|bedrock|surface|placid)\b/i, label: "beneath the calm" },
  { pattern: /\brestless (?:depths|plumbing|surface|currents?)\b/i, label: "restless depths" },
  { pattern: /\bcalm surface[s]?,/i, label: "calm surfaces," },
  { pattern: /\bsurface calm\b/i, label: "surface calm" },
  { pattern: /\b(?:something|someone) (?:is )?moving (?:under|beneath)(?:neath)?\b/i, label: "moving underneath" },
  { pattern: /\bthe plumbing (?:flinched|said|is)\b/i, label: "the plumbing flinched" },
  { pattern: /\bserene\b/i, label: "serene" },
  { pattern: /\btime will tell\b/i, label: "time will tell" },
  { pattern: /\bthe question is whether\b/i, label: "the question is whether" },
  { pattern: /\bit is worth asking whether\b/i, label: "it is worth asking whether" },
];

/** Tics banned only in terminal-sentence / closer position.
 *  The regex does NOT anchor to end-of-string. `findForbiddenTics` already
 *  scopes the haystack to the last sentence of the last paragraph and the
 *  text-hook's last sentence, so re-anchoring here would miss phrases
 *  followed by a short tail like "into next week." */
const FORBIDDEN_TICS_CLOSER: { pattern: RegExp; label: string }[] = [
  { pattern: /\b(?:worth watching|worth monitoring|bears? watching)\b/i, label: "worth watching/monitoring (closer)" },
];

function getLastSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const sentences = trimmed.split(/(?<=[.!?])\s+/);
  return sentences[sentences.length - 1] ?? "";
}

function getLastParagraph(text: string): string {
  const paragraphs = text.split(/\r?\n\s*\r?\n/).filter(Boolean);
  return paragraphs[paragraphs.length - 1] ?? "";
}

export function findForbiddenTics(digestText: string, digestExtended: string): string[] {
  const hits: string[] = [];
  const haystack = `${digestText}\n${digestExtended}`;
  for (const { pattern, label } of FORBIDDEN_TICS_ANYWHERE) {
    if (pattern.test(haystack)) hits.push(label);
  }
  const lastSentence = getLastSentence(getLastParagraph(digestExtended));
  const hookSentence = getLastSentence(digestText);
  for (const { pattern, label } of FORBIDDEN_TICS_CLOSER) {
    if (pattern.test(lastSentence) || pattern.test(hookSentence)) hits.push(label);
  }
  return hits;
}

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

export function leadFamily(lead: string | undefined): string | undefined {
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
