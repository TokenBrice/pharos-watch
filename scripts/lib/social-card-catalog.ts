/**
 * What every canonical destination's social card says and shows (the lens
 * redesign). Coverage keeps the old catalog's guarantee: every public
 * destination (route inventory, page tree, registry-derived routes) gets a card
 * or an authored entry, and a missing one throws.
 *
 * Drawn text is fitted to its template budget by choosing a shorter rule, never
 * by truncation; only `copy` is cut, at a word boundary. Cards carry no live
 * number (grade, price, market cap, count, APY); fixed history is allowed.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BACKING_LABELS,
  CAUSE_META,
  DEPEG_AUDIT_DISPUTED_BADGE,
  GOVERNANCE_PROSE_LABELS,
  INFRASTRUCTURE_LABELS,
  MECHANISM_ARCHETYPE_LABELS,
  MECHANISM_ARCHETYPE_SHORT_LABELS,
  PEG_DEVIATION_LEVEL_LABELS,
  PEG_LABELS_SHORT,
  STABLECOIN_STATUS_LABELS,
  getMechanismExplainerPath,
  getPegDeviationLevel,
  resolveMechanismArchetype,
} from "../../shared/lib/classification";
import { getActiveChainIds } from "../../shared/lib/chains";
import { isDisputedAuditVerdict } from "../../shared/lib/depeg-audit";
import { formatDeviationBps } from "../../shared/lib/format";
import {
  getListingStatusCategory,
  hasRedundantName,
  hasVolatileAmount,
  normalizeWhitespace,
  trimTextAtWordBoundary,
} from "../../shared/lib/metadata-copy";
import { METHODOLOGY_HISTORY_ARCHIVES } from "../../shared/lib/methodology-versions/archives";
import { METHODOLOGY_CHANGELOG_REGISTRY } from "../../shared/lib/methodology-versions/registry";
import { PUBLIC_DOCS } from "../../shared/lib/public-docs";
import { formatApproxDurationSeconds } from "../../shared/lib/relative-time";
import type {
  SocialCardAuthored,
  SocialCardCatalog,
  SocialCardCopy,
  SocialCardHubSubject,
  SocialCardIdentity,
  SocialCardLifecycle,
  SocialCardRecord,
  SocialCardSpec,
} from "../../shared/lib/social-card/spec";
import { ACTIVE_STABLECOINS, PRE_LAUNCH_STABLECOINS, TRACKED_META_BY_ID, TRACKED_STABLECOINS } from "../../shared/lib/stablecoins/registry";
import { buildStablecoinUrl } from "../../shared/lib/urls";
import { getVariantDisplay } from "../../shared/lib/variant-display";
import { hasStaticYieldWorkbench } from "../../shared/lib/yield-auto-lending";
import { CHAIN_META } from "../../shared/types/chain-identity";
import type { PegCurrency } from "../../shared/types/core";
import type { StablecoinAiSummariesById } from "../../shared/types/editorial";
import type { DepegEventEntry } from "../../shared/types/peg";
import type { StablecoinMeta } from "../../shared/types/stablecoin-meta-schemas";
import { MECHANISM_ARCHETYPE_VALUES } from "../../shared/types/stablecoin-taxonomy";
import deadStablecoins from "../../shared/data/dead-stablecoins.json";
import aiSummaries from "../../data/ai-summaries.json";
import registeredLogos from "../../data/logos.json";
import { BLOG_POSTS } from "../../src/data/blog";
import { CASE_STUDY_LIST } from "../../src/lib/case-studies";
import { CASE_STUDY_OUTCOME_LABELS } from "../../src/lib/case-study-outcomes";
import { CHANGELOG_MONTH_ARCHIVES } from "../../src/lib/changelog-history";
import { STATIC_COMPARE_PAIRS, buildStaticComparisonSlug } from "../../src/lib/compare-links";
import {
  buildDepegEventDescription,
  buildDepegEventTitle,
  depegDirectionLabel,
  formatEventPrice,
  getDepegEventOnset,
  formatEventUtcTime,
  getDepegEventClosurePresentation,
} from "../../src/lib/depeg-event-display";
import { hasUnverifiedDepegPeak } from "../../src/lib/depeg-event-config";
import { COLLIDING_DEPEG_EVENT_SLUGS, DEPEG_EVENT_ENTRIES } from "../../src/lib/depeg-event-page-data";
import { readDepegEventSnapshot } from "../../src/lib/depeg-event-snapshot";
import { PROTOCOL_LOGOS, prettifyProtocol } from "../../src/lib/dex-display-constants";
import { DIGEST_CORRECTIONS, DIGEST_ENTRIES } from "../../src/lib/digest-registry";
import { ARCHETYPE_CONTENT } from "../../src/lib/mechanism-explainers";
import { PEG_HUB_PEGS, PEG_HUB_SLUGS } from "../../src/lib/peg-landing";
import { PUBLIC_ROUTE_PATHS } from "../../src/lib/public-route-inventory";
import { ALL_STABLECOIN_TAXONOMY_PAGES, STABLECOIN_TAXONOMY_HUB_ROUTES } from "../../src/lib/stablecoin-taxonomy";
import { stripTermMarkup } from "../../src/lib/term-markup";

/** Character budgets the renderer fits; drawn text never exceeds them. */
export const SOCIAL_CARD_BUDGETS = {
  label: 28,
  hub: { headline: 40, deck: 90 },
  dossier: { headline: 60, subline: 48, hook: 64, chip: 18, chips: 2 },
  versus: { symbol: 12, detail: 32, hook: 48 },
  record: { title: 90, dek: 150, dateline: 32, fact: 40, facts: 3, pill: 16 },
  copy: { title: 70, description: 200, alt: 250 },
} as const;
const B = SOCIAL_CARD_BUDGETS;

/**
 * Real, closed, undisputed USD lows on the /depeg/ hub ruler (curated history).
 * The catalog verifies each against the event shards and throws on drift.
 */
export const DEPEG_HUB_LOWS: readonly { slug: string; name?: string; logoId?: string }[] = [
  { slug: "usdc-2023-03-11" },
  { slug: "susd-2025-03-20" },
  { slug: "ust-2022-05-09", name: "TerraUSD", logoId: "ust-terra" },
];

// ---------------------------------------------------------------------------
// Text rules
// ---------------------------------------------------------------------------

/** Glyphs the subset card fonts draw: ASCII, Latin-1 and – ‘ ’ “ ” … (· is Latin-1). */
const DRAWABLE = /^[\u0020-\u007E\u00A0-\u00FF\u2013\u2018\u2019\u201C\u201D\u2026]*$/u;
/** Clause dashes are banned by the editorial style guide on every surface. */
const CLAUSE_DASH = /[\u2012-\u2015]/u;
const isDrawable = (text: string) => DRAWABLE.test(text) && !CLAUSE_DASH.test(text);
/** Ticker glyphs outside the card fonts, drawn as their plain letters ("aUSD₮" → "aUSDT"). */
const GLYPH_FALLBACKS: Readonly<Record<string, string>> = { "₮": "T", "ł": "l", "Ł": "L" };
const drawableName = (text: string) => text.replace(/[₮łŁ]/gu, (glyph) => GLYPH_FALLBACKS[glyph]);

type Candidate = string | null | undefined | false;

/** The first candidate that fits the budget and the card fonts: a shorter rule, never a cut. */
function fit(max: number, ...candidates: readonly Candidate[]): string | undefined {
  return candidates.find((text): text is string => !!text && text.length <= max && isDrawable(text));
}

function mustFit(field: string, max: number, ...candidates: readonly Candidate[]): string {
  const text = fit(max, ...candidates);
  if (text === undefined) throw new Error(`No ${field} rule fits ${max} characters: ${candidates.filter(Boolean).join(" | ")}`);
  return text;
}

/** Metadata may be cut, at a word boundary, after the shorter rules are exhausted. */
function clip(max: number, ...candidates: readonly Candidate[]): string {
  const options = candidates.filter((text): text is string => !!text).map(normalizeWhitespace);
  return options.find((text) => text.length <= max) ?? trimTextAtWordBoundary(options[0] ?? "", max);
}

const sentence = (text: string) => (/[.!?…]$/u.test(text) ? text : `${text}.`);
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Classification labels are Title Case; card chips and long labels read in sentence case. */
function sentenceCase(label: string): string {
  return label.replace(/(?<=[\s/-])[A-Z][a-z]+\b/g, (word) => (/^Treasur(?:y|ies)$/.test(word) ? word : word.toLowerCase()));
}

/** The first sentence of prose, skipping abbreviations ("U.S.") and a leading title paragraph. */
function firstSentence(text: string): string {
  const flat = normalizeWhitespace(stripTermMarkup(text));
  for (const match of flat.matchAll(/[.!?](?=\s+["“‘(]?[A-Z0-9$])/g)) {
    const end = (match.index ?? 0) + 1;
    const word = /\S+$/.exec(flat.slice(0, end))?.[0] ?? "";
    if (/^(?:[A-Z]\.)+$|^(?:vs|No|Inc|Ltd|Co|Corp|Mr|Ms|Dr|St|e\.g|i\.e)\.$/.test(word)) continue;
    return flat.slice(0, end);
  }
  return flat;
}

/**
 * D2 volatility screen for AI-summary titles: drop digits, currency amounts
 * and the words now/still/currently/new. Judgement words stay. Returns the
 * reason a title is dropped, or null when it can be printed.
 */
export function volatileTitleReason(title: string): string | null {
  if (/\d/.test(title)) return "digit";
  if (/[$€£¥₮]|\b(?:cents?|thousand|million|billion|trillion)\b/i.test(title)) return "currency amount";
  const word = /\b(now|still|currently|new)\b/i.exec(title);
  return word ? `word "${word[1].toLowerCase()}"` : null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-17" → "17 Oct 2026" (fixed month names, independent of ICU data). */
function dayLabel(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}
/** Fuzzy dates: "2026-10-17" or "2026-10" → "Oct 2026", "2026-Q3" → "Q3 2026", "2026" → "2026". */
function monthLabel(fuzzy: string): string {
  const [year, part] = fuzzy.split("-");
  if (!/^\d{4}$/.test(year) || (part !== undefined && !/^(?:\d{2}|Q[1-4]|H[12])$/.test(part))) throw new Error(`Unrecognised date: ${fuzzy}`);
  if (part === undefined) return year;
  return /^\d/.test(part) ? `${MONTHS[Number(part) - 1]} ${year}` : `${part} ${year}`;
}
const isoDay = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Identities and registered logos
// ---------------------------------------------------------------------------

const PUBLIC_DIR = fileURLToPath(new URL("../../public", import.meta.url));
const LOGOS = registeredLogos as Readonly<Record<string, string>>;
const AI = aiSummaries as StablecoinAiSummariesById;
const DEAD_BY_ID = new Map((deadStablecoins as readonly { id: string; symbol: string; name: string }[]).map((entry) => [entry.id, entry]));

/** A registered image that exists under public/ (`/logos/`, `/chains/` or `/dexes/`). */
function publicImage(path: string | undefined, prefix: "/logos/" | "/chains/" | "/dexes/"): string | undefined {
  return path && path.startsWith(prefix) && existsSync(`${PUBLIC_DIR}${path}`) ? path : undefined;
}
const coinLogo = (id: string) => publicImage(Object.prototype.hasOwnProperty.call(LOGOS, id) ? LOGOS[id] : undefined, "/logos/");

function identity(symbol: string, name: string, logoPath: string | undefined): SocialCardIdentity {
  return { symbol: drawableName(symbol), name: drawableName(name), ...(logoPath ? { logoPath } : {}) };
}
const coinIdentity = (coin: StablecoinMeta) => identity(coin.symbol, coin.name, coinLogo(coin.id));
/** "Tether (USDT)", or the name alone when it only repeats the ticker ("KlarnaUSD"). */
const coinTitle = (coin: StablecoinMeta) => (hasRedundantName(coin) ? coin.name : `${coin.name} (${coin.symbol})`);
/** The shortest standalone reference: the ticker, or the name when the ticker is too long to headline. */
const coinShort = (coin: StablecoinMeta) => (coin.symbol.length > 8 ? coin.name : coin.symbol);
const archetypeOf = (coin: StablecoinMeta) => resolveMechanismArchetype(coin, TRACKED_META_BY_ID);

/** "USD peg", "Gold peg", "CPI peg": the ISO code for currencies, the label otherwise. */
function pegChip(peg: PegCurrency): string | undefined {
  if (peg === "OTHER") return undefined;
  return `${peg !== "VAR" && /^[A-Z]{3}$/.test(peg) ? peg : PEG_LABELS_SHORT[peg]} peg`;
}
/** Sentence-case label inside prose: "crypto CDP", "custodial cash", "UCITS / TRS fund". */
const inProse = (label: string) => (/^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label);
function mechanismChip(coin: StablecoinMeta): string | undefined {
  const archetype = archetypeOf(coin);
  return archetype ? sentenceCase(MECHANISM_ARCHETYPE_SHORT_LABELS[archetype]) : undefined;
}
const chips = (...candidates: readonly Candidate[]) =>
  candidates.filter((chip): chip is string => fit(B.dossier.chip, chip) !== undefined).slice(0, B.dossier.chips);

/** Registry selections for the lens: logo-bearing identities with distinct logos, most important first. */
function logoMembers(identities: Iterable<SocialCardIdentity>, size: number): SocialCardIdentity[] {
  const seen = new Set<string>();
  const members: SocialCardIdentity[] = [];
  for (const member of identities) {
    if (!member.logoPath || seen.has(member.logoPath)) continue;
    seen.add(member.logoPath);
    members.push(member);
    if (members.length === size) break;
  }
  return members;
}
const cluster = (identities: Iterable<SocialCardIdentity>, size = 8): SocialCardHubSubject => ({ kind: "cluster", members: logoMembers(identities, size) });
/** The first logo-bearing coin per key, in canonical order. */
function firstPer<K>(coins: readonly StablecoinMeta[], key: (coin: StablecoinMeta) => K | null): StablecoinMeta[] {
  const seen = new Set<K>();
  return coins.filter((coin) => {
    const value = key(coin);
    if (value === null || seen.has(value) || !coinLogo(coin.id)) return false;
    seen.add(value);
    return true;
  });
}
const primaryFirst = (coins: readonly StablecoinMeta[]) => [...coins.filter((coin) => !coin.variantOf), ...coins.filter((coin) => coin.variantOf)];

// ---------------------------------------------------------------------------
// Hand-authored destinations (core hubs, editorial and reference pages)
// ---------------------------------------------------------------------------

type HubEntry = { label: string; headline: string; deck: string; description: string; subject: () => SocialCardHubSubject };
type RecordEntry = { label: string; title: string; dek: string; description: string; accent: SocialCardRecord["accent"]; masthead?: true };
const glyph = (name: Extract<SocialCardHubSubject, { kind: "glyph" }>["glyph"]) => () => ({ kind: "glyph" as const, glyph: name });

function chainIdentity(chainId: string): SocialCardIdentity {
  const meta = CHAIN_META[chainId];
  // Chains have no ticker; the symbol is only drawn as a monogram, so use the name's first word ("Bifrost Network" → "Bifrost").
  return identity(meta.name.split(" ")[0].slice(0, 12), meta.name, publicImage(meta.logoPath, "/chains/"));
}
function chainsByDeployments(): string[] {
  const counts = new Map<string, number>();
  for (const coin of ACTIVE_STABLECOINS) {
    for (const chain of new Set((coin.contracts ?? []).map((contract) => contract.chain))) counts.set(chain, (counts.get(chain) ?? 0) + 1);
  }
  return getActiveChainIds().sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || (a < b ? -1 : 1));
}
function dexIdentities(): SocialCardIdentity[] {
  const brands = new Set<string>();
  return Object.entries(PROTOCOL_LOGOS).flatMap(([key, path]) => {
    const brand = prettifyProtocol(key).replace(/ V\d+$/, "");
    if (brands.has(brand)) return [];
    brands.add(brand);
    return [identity(brand, brand, publicImage(path, "/dexes/"))];
  });
}
/** One coin from each cohort in turn, so a group hub shows every cohort. */
function roundRobin(groups: readonly (readonly StablecoinMeta[])[]): StablecoinMeta[] {
  const queues = groups.map((coins) => primaryFirst(coins));
  const out: StablecoinMeta[] = [];
  for (let index = 0; queues.some((queue) => index < queue.length); index++) {
    for (const queue of queues) if (index < queue.length) out.push(queue[index]);
  }
  return out;
}
const taxonomyHub = (kind: keyof typeof STABLECOIN_TAXONOMY_HUB_ROUTES) => () =>
  cluster(roundRobin(STABLECOIN_TAXONOMY_HUB_ROUTES[kind].pages.map((page) => page.coins)).map(coinIdentity));

const HUBS: Readonly<Record<string, HubEntry>> = {
  "/": {
    label: "Stablecoin intelligence", headline: "Stablecoins, under the lens.",
    deck: "Peg history, reserve backing, issuer controls and exit liquidity, coin by coin.",
    description: "Independent stablecoin analytics: peg history, reserve backing, issuer controls and exit liquidity for every tracked stablecoin.",
    subject: () => cluster(primaryFirst(ACTIVE_STABLECOINS).map(coinIdentity), 10),
  },
  "/stablecoins/": {
    label: "Stablecoin directory", headline: "The stablecoin field guide",
    deck: "Compare what holds each stablecoin together: backing, controls and exits.",
    description: "Browse tracked stablecoins by peg, backing model and governance, with each coin's reserves, issuer controls and peg record.",
    subject: () => cluster(firstPer(primaryFirst(ACTIVE_STABLECOINS), archetypeOf).map(coinIdentity), 10),
  },
  "/alt-pegs/": {
    label: "Alternative pegs", headline: "Beyond the dollar peg",
    deck: "Stablecoins tied to the euro, other currencies, gold and silver.",
    description: "Stablecoins pegged to currencies other than the US dollar, and to gold and silver, with their peg history and backing.",
    subject: () => cluster(firstPer(primaryFirst(ACTIVE_STABLECOINS.filter((coin) => coin.flags.pegCurrency !== "USD")), (coin) => coin.flags.pegCurrency).map(coinIdentity)),
  },
  "/yield/": {
    label: "Yield intelligence", headline: "Where does the yield come from?",
    deck: "How yield-bearing stablecoins earn, and the risk behind each source.",
    description: "Yield-bearing stablecoins compared by where the yield comes from, the risks behind each source and how the rate is verified.",
    // One yield-bearing coin per family: wrappers of one parent are not distinct sources.
    subject: () => cluster(firstPer(ACTIVE_STABLECOINS.filter((coin) => coin.flags.yieldBearing), (coin) => coin.variantOf ?? coin.id).map(coinIdentity)),
  },
  "/upcoming/": {
    label: "Upcoming stablecoins", headline: "Before the stablecoin launches",
    deck: "Announced stablecoins, their dated milestones and the evidence still missing.",
    description: "Stablecoins announced but not yet tracked: who is issuing them, their dated milestones and the launch evidence still missing.",
    subject: () => cluster(PRE_LAUNCH_STABLECOINS.map(coinIdentity)),
  },
  "/compare/": {
    label: "Stablecoin comparison", headline: "Two stablecoins, side by side",
    deck: "Compare backing, issuer controls and exit routes head to head.",
    description: "Put two stablecoins side by side and compare their backing, issuer controls, peg history and exit liquidity.",
    subject: () => cluster([...new Set(STATIC_COMPARE_PAIRS.flat())].flatMap((id) => {
      const coin = TRACKED_META_BY_ID.get(id);
      return coin ? [coinIdentity(coin)] : [];
    })),
  },
  "/chains/": {
    label: "Chains", headline: "Where stablecoins live",
    deck: "Stablecoin deployments across blockchains, chain by chain.",
    description: "Which stablecoins are deployed on each blockchain, with chain-level supply, concentration and exit liquidity.",
    subject: () => cluster(chainsByDeployments().map(chainIdentity)),
  },
  "/liquidity/": {
    label: "DEX liquidity", headline: "How deep is the exit?",
    deck: "Stablecoin liquidity on decentralized exchanges, beyond the headline pool size.",
    description: "DEX liquidity for tracked stablecoins: pool depth, venue concentration and how much can exit near the peg.",
    subject: () => cluster(dexIdentities()),
  },
  "/stablecoins/backing/": {
    label: "Stablecoins by backing", headline: "What backs the promise?",
    deck: "Real-world assets, crypto collateral and algorithmic designs, compared.",
    description: "Stablecoins grouped by backing model: real-world asset reserves, crypto collateral and algorithmic designs.",
    subject: taxonomyHub("backing"),
  },
  "/stablecoins/governance/": {
    label: "Stablecoins by governance", headline: "Who holds the controls?",
    deck: "Centralized, CeFi-dependent and decentralized stablecoins, compared.",
    description: "Stablecoins grouped by governance: centralized issuers, CeFi-dependent designs and decentralized protocols.",
    subject: taxonomyHub("governance"),
  },
  "/stablecoins/infrastructure/": {
    label: "Shared infrastructure", headline: "Built on shared infrastructure",
    deck: "Stablecoins that share contracts or an issuance platform, and the risk that comes with it.",
    description: "Stablecoins built on common infrastructure such as Liquity and M0, where shared code and governance correlate risk.",
    subject: taxonomyHub("infrastructure"),
  },
  "/safety-scores/": {
    label: "Safety Scores", headline: "What’s behind the grade?",
    deck: "Backing, control and exit, scored from public evidence.",
    description: "Pharos Safety Scores grade stablecoins on backing, economic control and exit, with the evidence and methodology behind each grade.",
    subject: () => ({ kind: "grade-shield" }),
  },
  "/safety-scores/map/": {
    label: "Safety Score map", headline: "A map of stablecoin risk",
    deck: "Graded stablecoins placed by their backing, control and exit pillars.",
    description: "An interactive map that places graded stablecoins by their Safety Score pillars: backing, economic control and exit.",
    subject: () => ({ kind: "grade-shield" }),
  },
  "/depeg/": {
    label: "Peg tracker", headline: "When the peg stops holding",
    deck: "Confirmed depegs: how far each coin fell, how long it lasted and the evidence.",
    description: "Peg monitoring for tracked stablecoins and the record of confirmed depegs, with depth, duration and source evidence for each.",
    subject: depegHubRuler,
  },
  "/freezewatch/": {
    label: "FreezeWatch", headline: "Who can freeze the money?",
    deck: "Issuer freeze powers, recorded freeze events and inherited exposure.",
    description: "Which stablecoins can freeze or seize balances, the freeze events on record, and the exposure inherited through collateral.",
    subject: glyph("lock"),
  },
  "/stability-index/": {
    label: "Stability Index", headline: "Read the pressure on the peg",
    deck: "The Pharos Stability Index measures system-wide stablecoin stress.",
    description: "The Pharos Stability Index (PSI) measures system-wide stablecoin stress from the depth, severity and breadth of peg deviations.",
    subject: glyph("gauge"),
  },
  "/dependency-map/": {
    label: "Dependency Map", headline: "Follow the dependencies",
    deck: "One stablecoin's collateral can be another stablecoin's risk.",
    description: "How stablecoins depend on each other through collateral, custody and redemption routes, mapped from the Pharos registry.",
    subject: glyph("graph"),
  },
  "/flows/": {
    label: "Mint and burn flows", headline: "Who is minting and who is redeeming?",
    deck: "Issuer mint and burn activity, read from both sides of the supply.",
    description: "Stablecoin mint and burn flows by issuer and chain, with the Bank Run Gauge reading of redemption pressure.",
    subject: glyph("flows"),
  },
  "/timeline/": {
    label: "Event timeline", headline: "The stablecoin event tape",
    deck: "Depegs, freezes, launches and methodology changes, in order.",
    description: "A chronological record of stablecoin depegs, freezes, launches and Pharos methodology changes.",
    subject: glyph("timeline"),
  },
  "/screener/": {
    label: "Stablecoin screener", headline: "Screen stablecoins by design",
    deck: "Filter tracked stablecoins by peg, backing, governance and risk.",
    description: "Filter and sort tracked stablecoins by peg, backing model, governance, chain and Safety Score pillars.",
    subject: glyph("filter"),
  },
  "/screener/picker/": {
    label: "Stablecoin picker", headline: "Start with how you'll use it",
    deck: "A shortlist that fits your use case, with the trade-offs left visible.",
    description: "Choose a use-case profile and explore a shortlist of stablecoins that fit it, with the trade-offs shown. Not financial advice.",
    subject: glyph("filter"),
  },
  "/portfolio/": {
    label: "Portfolio lens", headline: "Look through your portfolio",
    deck: "Stablecoin risk and shared dependencies across the coins you hold.",
    description: "Explore stablecoin risk and shared dependencies across a portfolio of stablecoins you enter yourself.",
    subject: glyph("portfolio"),
  },
  "/api/": {
    label: "Pharos API", headline: "Stablecoin data for your own tools",
    deck: "Pharos evidence and analytics through a documented API.",
    description: "Pharos stablecoin data through the API: pegs, supply, reserves and risk evidence, with documented access rules.",
    subject: glyph("code"),
  },
  "/pharoswatchbot/": {
    label: "PharosWatchBot", headline: "Stablecoin alerts in Telegram",
    deck: "Choose the depegs, freezes and supply moves you want to hear about.",
    description: "PharosWatchBot sends Telegram alerts for the stablecoin depegs, freezes and supply moves you choose to follow.",
    subject: glyph("telegram"),
  },
  "/about/": {
    label: "About Pharos", headline: "A lighthouse for stablecoins",
    deck: "Independent analytics for money that promises stability.",
    description: "Who builds Pharos, how it is funded and the principles behind its independent stablecoin analytics.",
    subject: glyph("mark"),
  },
};

const RECORDS: Readonly<Record<string, RecordEntry>> = {
  "/coverage/": {
    label: "Coverage", accent: "frost", title: "What Pharos watches, and what it misses",
    dek: "The assets, chains and sources in scope, and the known blind spots.",
    description: "The scope of Pharos coverage: which assets, chains and data sources are tracked, and the known blind spots.",
  },
  "/status/": {
    label: "Service status", accent: "frost", title: "Pharos data and service status",
    dek: "Data freshness, pipeline coverage and service health for each feed.",
    description: "Data freshness, pipeline coverage and service health for the feeds behind Pharos.",
  },
  "/changelog/": {
    label: "Product changelog", accent: "frost", title: "What changed on Pharos",
    dek: "Weekly release notes and field notes, with the reasoning behind each change.",
    description: "Weekly Pharos release notes: what changed on the site and in the data, and why it matters to readers.",
  },
  "/privacy/": {
    label: "Privacy", accent: "ink", title: "Your data on Pharos",
    dek: "What Pharos collects, what stays local and what sharing means.",
    description: "How Pharos handles data: what it collects, what stays local and what sharing a page means.",
  },
  "/methodology/": {
    label: "Methodology", accent: "ink", title: "How Pharos turns evidence into signals",
    dek: "The methods, definitions and limits behind every score and signal.",
    description: "The methodology behind Pharos scores and signals: definitions, data sources, formulas and known limits.",
  },
  "/docs/": {
    label: "Documentation", accent: "ink", title: "Pharos methodology documentation",
    dek: "The methods, definitions and limits behind the dashboard.",
    description: "Reference documentation for Pharos methodology: classification, pricing, depeg detection, scoring and their limits.",
  },
  "/compliance/": {
    label: "Compliance", accent: "ink", title: "Stablecoin compliance, issuer by issuer",
    dek: "Evidence for the US GENIUS Act and the EU Markets in Crypto-Assets rules (MiCA).",
    description: "Issuer-by-issuer evidence on how stablecoins line up with the US GENIUS Act and the EU Markets in Crypto-Assets Regulation (MiCA).",
  },
  "/funding/": {
    label: "Funding", accent: "ink", title: "How Pharos is funded",
    dek: "The public record of the donations and sponsorships behind Pharos.",
    description: "The public record of the donations and in-kind sponsorships that fund Pharos, and how to support it.",
  },
  "/api/reference/": {
    label: "API reference", accent: "ink", title: "The Pharos API reference",
    dek: "Endpoints, response contracts and access rules for the Pharos API.",
    description: "Reference documentation for the Pharos API: endpoints, authentication, response contracts and access rules.",
  },
  "/blog/": {
    label: "Pharos blog", accent: "ink", title: "The Pharos blog",
    dek: "Research, design notes and the decisions behind Pharos.",
    description: "Long-form posts on Pharos research, methodology changes and the decisions behind the dashboard.",
  },
  "/digest/": {
    label: "Stablecoin digest", accent: "ink", masthead: true, title: "The stablecoin digest",
    dek: "Daily briefings and weekly recaps on supply, pegs and flows.",
    description: "Daily stablecoin briefings and weekly recaps on supply, peg and flow moves, kept in a dated archive.",
  },
  "/depeg/archive/": {
    label: "Depeg archive", accent: "severity", title: "The depeg archive",
    dek: "Confirmed depeg incidents with dates, depth, duration and source evidence.",
    description: "Every confirmed depeg incident Pharos has recorded, with dates, depth, duration and source evidence.",
  },
  "/learn/mechanisms/": {
    label: "Mechanisms", accent: "ink", title: "How stablecoins work",
    dek: "From cash reserves to hedged synthetics: each design and how it can fail.",
    description: "Explainers for each stablecoin mechanism, from custodial cash and tokenized Treasuries to CDPs and hedged synthetics, and how each can fail.",
  },
  "/learn/case-studies/": {
    label: "Case studies", accent: "ink", title: "When stablecoins met the stress test",
    dek: "Historical incidents: the mechanism, the sequence and what happened next.",
    description: "Case studies of stablecoin depegs and failures: what happened, why it mattered and what the evidence shows.",
  },
};

/** Acronyms spelled out in reference titles. */
const ACRONYMS: Readonly<Record<string, string>> = {
  DEWS: "Depeg Early Warning System (DEWS)",
  PSI: "Pharos Stability Index (PSI)",
};
const spellOut = (title: string) => title.replace(/\b[A-Z]{3,5}\b/g, (word) => ACRONYMS[word] ?? word);

// ---------------------------------------------------------------------------
// Card assembly
// ---------------------------------------------------------------------------

/** A card before its alt text is written (distributes over the template union). */
type Draft<T extends SocialCardSpec = SocialCardSpec> = T extends SocialCardSpec ? Omit<T, "copy"> & { copy: Omit<SocialCardCopy, "alt"> } : never;

function list(members: readonly SocialCardIdentity[]): string {
  const names = members.slice(0, 5).map((member) => member.symbol);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names.join("");
}

/** Alt text describes what is drawn. */
function describe(card: Draft<SocialCardSpec>): string {
  switch (card.template) {
    case "hub": {
      const subject = card.subject;
      const art = subject.kind === "cluster" ? `Logos of ${list(subject.members)}.`
        : subject.kind === "orbit" ? `The ${subject.center.name} logo${subject.members.length ? ` ringed by ${list(subject.members)}` : ""}.`
          : subject.kind === "grade-shield" ? "A shield with a question mark above the A to F grade scale."
            : subject.kind === "peg-ruler" ? `A peg ruler marking closed lows: ${subject.lows.map((low) => `${low.identity.symbol} at $${low.price} in ${low.when}`).join(", ")}.`
              : "";
      return `${card.label}: ${sentence(card.headline)} ${sentence(card.deck)} ${art}`;
    }
    case "dossier":
      return `${card.label}: ${card.headline}, ${card.subline}. ${sentence(card.hook)}${card.chips.length ? ` ${card.chips.join(", ")}.` : ""}${card.stamp ? ` Stamp: ${card.stamp}.` : ""}`;
    case "versus":
      return `${card.label}: ${card.left.symbol} (${card.left.detail}) and ${card.right.symbol} (${card.right.detail}). ${sentence(card.hook)}`;
    case "record":
      return [
        `${card.label}: ${sentence(card.title)}`, card.dek && sentence(card.dek), card.dateline && sentence(card.dateline),
        card.pill && sentence(card.pill.text), ...(card.facts ?? []).map(sentence),
      ].filter(Boolean).join(" ");
  }
}

function finish(draft: Draft): SocialCardSpec {
  return { ...draft, copy: { ...draft.copy, alt: clip(B.copy.alt, describe(draft)) } };
}

function hub(path: string, entry: Omit<HubEntry, "subject"> & { subject: SocialCardHubSubject }) {
  return finish({
    path, template: "hub", label: entry.label, headline: entry.headline, deck: entry.deck, subject: entry.subject,
    copy: { title: clip(B.copy.title, entry.headline), description: clip(B.copy.description, entry.description) },
  });
}

function record(path: string, fields: Omit<Draft<SocialCardRecord>, "path" | "template" | "copy">, copy: { title: string; description: string }) {
  return finish({
    path, template: "record", ...fields,
    copy: { title: clip(B.copy.title, copy.title), description: clip(B.copy.description, copy.description) },
  });
}

// ---------------------------------------------------------------------------
// Coins: active, frozen, review, pre-launch, yield
// ---------------------------------------------------------------------------

function aiTitle(coin: StablecoinMeta): string | undefined {
  const title = AI[coin.id]?.title;
  return title ? normalizeWhitespace(stripTermMarkup(title)) : undefined;
}

/** Screened AI title (D2), else the mechanism headline, else a structural descriptor. */
function coinHook(coin: StablecoinMeta): string {
  const title = aiTitle(coin);
  const archetype = archetypeOf(coin);
  return mustFit(`hook for ${coin.id}`, B.dossier.hook,
    title && !volatileTitleReason(title) && title,
    archetype && ARCHETYPE_CONTENT[archetype].headline,
    `${sentenceCase(BACKING_LABELS[coin.flags.backing])} ${PEG_LABELS_SHORT[coin.flags.pegCurrency]} stablecoin`);
}

/** The curated one-liner, unless it carries an amount that would go stale in a cached preview. */
function oneLiner(coin: StablecoinMeta): string | undefined {
  const text = coin.oneLiner ? normalizeWhitespace(stripTermMarkup(coin.oneLiner)) : "";
  return text && !hasVolatileAmount(text) ? text : undefined;
}

/** Ticker headline with a name line; the name headlines when the ticker is too long or no name line fits. */
function nameLines(coin: StablecoinMeta, withSince: boolean): { headline: string; subline: string } {
  const { symbol, name } = coinIdentity(coin);
  const brand = coin.brand ? drawableName(coin.brand) : undefined;
  const year = withSince && coin.launchDate ? coin.launchDate.slice(0, 4) : undefined;
  // Compared as drawn: "USA₮" over "USAT" repeats the ticker once the glyph falls back.
  const redundant = hasRedundantName({ name, symbol });
  const fallback = `${PEG_LABELS_SHORT[coin.flags.pegCurrency]} stablecoin`;
  // A short ticker always headlines; a long legal name (fund share classes) never does, it cannot fit three lines.
  if (symbol.length <= 8 || name.length > 40) {
    const subline = fit(B.dossier.subline,
      !redundant && year && `${name} · since ${year}`, !redundant && name,
      brand && year && `${brand} · since ${year}`, brand, fallback);
    if (subline) return { headline: symbol, subline };
  }
  return {
    headline: mustFit(`headline for ${coin.id}`, B.dossier.headline, name, symbol),
    subline: mustFit(`subline for ${coin.id}`, B.dossier.subline, !redundant && symbol, brand, fallback),
  };
}

function coinCard(coin: StablecoinMeta): SocialCardSpec {
  const path = buildStablecoinUrl(coin.id);
  const id = coinIdentity(coin);
  const description = oneLiner(coin) ?? `${coinTitle(coin)} on Pharos: peg history, backing, issuer controls and exit liquidity.`;
  const dossier = (fields: {
    label: string; lifecycle: SocialCardLifecycle; stamp?: string; hook: string; chips: readonly string[];
    lines: { headline: string; subline: string }; title: readonly Candidate[]; description: string;
  }) => finish({
    path, template: "dossier", label: fields.label, identity: id, ...fields.lines, hook: fields.hook, chips: fields.chips,
    lifecycle: fields.lifecycle, ...(fields.stamp ? { stamp: fields.stamp } : {}),
    copy: { title: clip(B.copy.title, ...fields.title), description: clip(B.copy.description, fields.description) },
  });

  if (coin.status === "frozen") {
    const obituary = coin.obituary;
    if (!obituary) throw new Error(`Historical social card is missing its obituary: ${coin.id}`);
    const cause = sentenceCase(CAUSE_META[obituary.causeOfDeath].label);
    const died = monthLabel(obituary.deathDate);
    const epitaph = normalizeWhitespace(obituary.epitaph);
    const opening = firstSentence(obituary.obituary);
    return dossier({
      label: "Stablecoin Cemetery", lifecycle: "historical", stamp: "HISTORICAL RECORD",
      hook: mustFit(`epitaph for ${coin.id}`, B.dossier.hook, epitaph, `${cause} in ${died}`),
      chips: chips(`Died ${died}`, fit(B.dossier.chip, cause, CAUSE_META[obituary.causeOfDeath].shortLabel) ?? mechanismChip(coin)), lines: nameLines(coin, false),
      title: [`${coinTitle(coin)}: ${epitaph}`, `${coinShort(coin)}: ${epitaph}`],
      description: clip(B.copy.description, `${opening} Cause of death: ${inProse(cause)}, ${died}.`, opening,
        `${coinTitle(coin)} died in ${died} (${inProse(cause)}). ${sentence(epitaph)}`),
    });
  }
  if (coin.status === "delisted" || coin.status === "quarantined") {
    const review = coin.listingStatusReview;
    if (!review) throw new Error(`Social listing review is missing its decision: ${coin.id}`);
    const category = getListingStatusCategory(coin);
    // The review's opening sentence, unless it quotes a supply or market figure that would read as current.
    const opening = firstSentence(review.reason);
    return dossier({
      label: "Listing review", lifecycle: "review", stamp: "LISTING REVIEW",
      hook: mustFit(`review hook for ${coin.id}`, B.dossier.hook, capitalize(category)),
      chips: chips(STABLECOIN_STATUS_LABELS[coin.status], `Reviewed ${monthLabel(review.changedAt)}`), lines: nameLines(coin, false),
      title: [`${coinTitle(coin)}: listing review`, `${coinShort(coin)}: listing review`, `${coin.symbol}: listing review`],
      description: clip(B.copy.description, !hasVolatileAmount(opening) && opening, `${coinTitle(coin)} is not currently scored by Pharos: ${category}.`),
    });
  }
  if (coin.status === "pre-launch") {
    const launched = coin.launchPhase === "launched";
    const milestone = launched
      ? (coin.launchDate ? `Launched ${monthLabel(coin.launchDate)}` : "Launched")
      : coin.announcedDate && `Announced ${monthLabel(coin.announcedDate)}`;
    return dossier({
      label: launched ? "Launched, not yet tracked" : "Upcoming stablecoin", lifecycle: launched ? "launched-untracked" : "pre-launch",
      stamp: launched ? "NOT YET TRACKED" : "PRE-LAUNCH", hook: coinHook(coin), chips: chips(pegChip(coin.flags.pegCurrency), milestone),
      lines: nameLines(coin, false), title: [coinTitle(coin), coinShort(coin)], description,
    });
  }
  const hook = coinHook(coin);
  return dossier({
    label: "Stablecoin dossier", lifecycle: "active", hook, chips: chips(pegChip(coin.flags.pegCurrency), mechanismChip(coin)),
    lines: nameLines(coin, true), title: [`${coinTitle(coin)}: ${hook}`, `${coinShort(coin)}: ${hook}`, coinTitle(coin)], description,
  });
}

function yieldCard(coin: StablecoinMeta): SocialCardSpec {
  const id = coinIdentity(coin);
  const source = coin.yieldConfig?.yieldSource ? normalizeWhitespace(coin.yieldConfig.yieldSource) : undefined;
  // A long camel-case ticker cannot break across lines, so it moves to the name line instead.
  const longTicker = id.symbol.length > 12;
  const headline = longTicker ? "Where the yield comes from" : `Where ${id.symbol}'s yield comes from`;
  const kind = coin.variantKind ? sentenceCase(getVariantDisplay(coin.variantKind).fullLabel.replace(/ variant$/, "")) : mechanismChip(coin);
  return finish({
    path: buildStablecoinUrl(coin.id, "yield/"), template: "dossier", label: "Yield source", identity: id,
    headline: mustFit(`yield headline for ${coin.id}`, B.dossier.headline, headline, id.symbol),
    subline: mustFit(`yield subline for ${coin.id}`, B.dossier.subline, longTicker && id.symbol, !hasRedundantName(id) && id.name, coin.brand,
      `${PEG_LABELS_SHORT[coin.flags.pegCurrency]} stablecoin`),
    hook: mustFit(`yield hook for ${coin.id}`, B.dossier.hook, source, "Lending-market yield on deposits"),
    chips: chips(kind, pegChip(coin.flags.pegCurrency)), lifecycle: "active",
    copy: {
      title: clip(B.copy.title, `Where ${coin.symbol}'s yield comes from`),
      description: source
        ? clip(B.copy.description, ...[coinTitle(coin), coin.symbol].map((who) => `${who} yield source: ${sentence(source)} Track the source history, warnings and switches behind the rate.`))
        : clip(B.copy.description, `${coinTitle(coin)} lending yield: the markets that pay it, their warnings and their source history.`),
    },
  });
}

// ---------------------------------------------------------------------------
// Chains, comparisons, peg and taxonomy hubs
// ---------------------------------------------------------------------------

function chainCard(chainId: string): SocialCardSpec {
  const center = chainIdentity(chainId);
  const onChain = ACTIVE_STABLECOINS.filter((coin) => (coin.contracts ?? []).some((contract) => contract.chain === chainId));
  const members = logoMembers(primaryFirst(onChain).map(coinIdentity), 6);
  return hub(`/chains/${chainId}/`, {
    label: "Chain profile",
    headline: mustFit(`chain headline for ${chainId}`, B.hub.headline, `Stablecoins on ${center.name}`, center.name),
    deck: mustFit(`chain deck for ${chainId}`, B.hub.deck,
      `Which stablecoins run on ${center.name}, who issues them and how deep the exits are.`,
      "Which stablecoins run here, who issues them and how deep the exits are."),
    description: `The stablecoins deployed on ${CHAIN_META[chainId].name}, with each issuer, its backing and the exit liquidity on the chain.`,
    subject: { kind: "orbit", center, members },
  });
}

function compareCard(leftId: string, rightId: string): SocialCardSpec {
  const left = TRACKED_META_BY_ID.get(leftId);
  const right = TRACKED_META_BY_ID.get(rightId);
  if (!left || !right) throw new Error(`Unknown comparison identity: ${leftId} / ${rightId}`);
  const [leftMechanism, rightMechanism] = [mechanismChip(left), mechanismChip(right)];
  const contrast = leftMechanism && rightMechanism && leftMechanism !== rightMechanism ? [leftMechanism, rightMechanism] as const : null;
  const samePeg = left.flags.pegCurrency === right.flags.pegCurrency;
  const detail = (coin: StablecoinMeta, mechanism: string | undefined) => {
    const issuer = coin.brand ?? (hasRedundantName(coin) ? undefined : coin.name);
    const country = coin.jurisdiction?.country;
    return mustFit(`comparison detail for ${coin.id}`, B.versus.detail,
      contrast !== null && mechanism, issuer && country && `${issuer} · ${country}`,
      issuer && coin.launchDate && `${issuer} · since ${coin.launchDate.slice(0, 4)}`, issuer, mechanism, coin.symbol);
  };
  const side = (coin: StablecoinMeta, mechanism: string | undefined) => ({ ...coinIdentity(coin), detail: detail(coin, mechanism) });
  const hook = !samePeg ? "Different pegs, side by side" : contrast ? "Same peg. Different mechanisms." : "Same peg. Different promises.";
  const description = contrast
    ? `${left.symbol} (${inProse(contrast[0])}) and ${right.symbol} (${inProse(contrast[1])}), side by side: backing, issuer controls, peg history and exit liquidity.`
    : `${left.symbol} and ${right.symbol} share the ${leftMechanism ? inProse(leftMechanism) : "same"} design. Compare their issuers, reserves, controls and exit liquidity side by side.`;
  return finish({
    path: `/compare/${buildStaticComparisonSlug(leftId, rightId)}/`, template: "versus", label: "Stablecoin comparison",
    left: side(left, leftMechanism), right: side(right, rightMechanism), hook,
    copy: { title: clip(B.copy.title, `${left.symbol} vs ${right.symbol}`), description: clip(B.copy.description, description) },
  });
}

function pegHubCard(peg: PegCurrency): SocialCardSpec {
  const label = PEG_LABELS_SHORT[peg];
  const members = ACTIVE_STABLECOINS.filter((coin) => coin.flags.pegCurrency === peg);
  const upcoming = PRE_LAUNCH_STABLECOINS.filter((coin) => coin.flags.pegCurrency === peg);
  return hub(`/stablecoins/${PEG_HUB_SLUGS[peg]}/`, {
    label: "Stablecoins by peg",
    headline: mustFit(`peg hub headline for ${peg}`, B.hub.headline, `${label} stablecoins`),
    deck: mustFit(`peg hub deck for ${peg}`, B.hub.deck, `Compare ${label} stablecoins by backing, issuer control and exit route.`, "Compare backing, issuer control and exit route on one peg."),
    description: `The ${label} stablecoins Pharos tracks, with each coin's backing, issuer controls, peg record and exit liquidity.`,
    subject: cluster(primaryFirst(members.length ? members : upcoming).map(coinIdentity)),
  });
}

function taxonomyCard(page: (typeof ALL_STABLECOIN_TAXONOMY_PAGES)[number]): SocialCardSpec {
  const headline = page.kind === "governance" ? `${capitalize(GOVERNANCE_PROSE_LABELS[page.value as keyof typeof GOVERNANCE_PROSE_LABELS])} stablecoins`
    : page.kind === "backing" ? `${sentenceCase(BACKING_LABELS[page.value as keyof typeof BACKING_LABELS])} stablecoins`
      : `Stablecoins built on ${INFRASTRUCTURE_LABELS[page.value as keyof typeof INFRASTRUCTURE_LABELS]}`;
  // The description's first sentence carries a live count; the rest is authored, count-free copy.
  const authored = page.description.replace(/^[^.]*\.\s*/, "");
  return hub(page.href, {
    label: page.kind === "infrastructure" ? "Shared infrastructure" : `Stablecoins by ${page.kind}`,
    headline: mustFit(`taxonomy headline for ${page.href}`, B.hub.headline, headline),
    deck: mustFit(`taxonomy deck for ${page.href}`, B.hub.deck, authored, "Compare designs, controls and exit routes across the cohort."),
    description: firstSentence(page.intro),
    subject: cluster(primaryFirst(page.coins).map(coinIdentity)),
  });
}

// ---------------------------------------------------------------------------
// Records: mechanisms, case studies, depegs, digests, methodology, docs, blog
// ---------------------------------------------------------------------------

function mechanismCard(archetype: (typeof MECHANISM_ARCHETYPE_VALUES)[number]): SocialCardSpec {
  const content = ARCHETYPE_CONTENT[archetype];
  const tickers: string[] = [];
  for (const { coinId } of content.representativeCoins) {
    const coin = TRACKED_META_BY_ID.get(coinId);
    if (coin && [...tickers, coin.symbol].join(" · ").length <= B.record.fact) tickers.push(drawableName(coin.symbol));
  }
  return record(getMechanismExplainerPath(archetype), {
    label: "Mechanism explained", accent: "ink", title: mustFit(`mechanism title for ${archetype}`, B.record.title, content.headline),
    // The archetype label is a fact only when the headline does not already say it.
    facts: [content.headline.toLowerCase().includes(MECHANISM_ARCHETYPE_LABELS[archetype].toLowerCase()) ? undefined : fit(B.record.fact, sentenceCase(MECHANISM_ARCHETYPE_LABELS[archetype])), tickers.join(" · ")]
      .filter((fact): fact is string => !!fact),
  }, { title: content.headline, description: clip(B.copy.description, content.subtitle, firstSentence(content.subtitle)) });
}

function caseStudyCard(study: (typeof CASE_STUDY_LIST)[number]): SocialCardSpec {
  const coin = study.primaryCoinId ? TRACKED_META_BY_ID.get(study.primaryCoinId) : undefined;
  const dead = study.cemeteryId ? DEAD_BY_ID.get(study.cemeteryId) : undefined;
  const subject = coin ? coinIdentity(coin) : dead ? identity(dead.symbol, dead.name, undefined) : undefined;
  const ongoing = /\(ongoing\)/i.test(study.eventDateLabel);
  const tone = study.outcome === "survived" ? "positive" : study.outcome === "died" ? "severity" : "neutral";
  const low = study.eventWindow.lowPrice;
  return record(`/learn/case-studies/${study.slug}/`, {
    label: "Historical case study", accent: "ink", ...(subject ? { identity: subject } : {}),
    dateline: mustFit(`case-study dateline for ${study.slug}`, B.record.dateline, study.eventDateLabel.replace(/\s*\(ongoing\)/i, "")),
    title: mustFit(`case-study title for ${study.slug}`, B.record.title, study.title),
    dek: fit(B.record.dek, study.eyebrow),
    pill: ongoing ? { text: "Ongoing", tone: "neutral" } : { text: CASE_STUDY_OUTCOME_LABELS[study.outcome], tone },
    facts: [!ongoing && low !== undefined && low < 1 && fit(B.record.fact,
      study.eventWindow.metricScope ? `Low $${low} · ${study.eventWindow.metricScope}` : `Low $${low}`)].filter((fact): fact is string => !!fact),
  }, { title: study.title, description: study.metaDescription });
}

const rulerFloor = (low: number) => Math.max(0, Math.floor(low * 10 - 0.5) / 10);
const isPlausible = (event: Pick<DepegEventEntry, "peakDeviationBps">) => event.peakDeviationBps !== 0 && Math.abs(event.peakDeviationBps) <= 10_000;

function depegCard(event: DepegEventEntry): SocialCardSpec {
  const coin = TRACKED_META_BY_ID.get(event.stablecoinId);
  const id = identity(coin?.symbol ?? event.symbol, coin?.name ?? event.symbol, coinLogo(event.stablecoinId));
  const disputed = isDisputedAuditVerdict(event.provenance?.auditVerdict);
  const open = event.endedAt === null;
  const unverified = hasUnverifiedDepegPeak(event);
  const figure = !open && !disputed && !unverified && isPlausible(event);
  const collision = COLLIDING_DEPEG_EVENT_SLUGS.has(event.slug);
  const closure = getDepegEventClosurePresentation(event);
  const level = getPegDeviationLevel(Math.abs(event.peakDeviationBps));
  const peak = figure ? formatEventPrice(event.peakPrice, event, "peak") : null;
  const duration = event.endedAt !== null ? formatApproxDurationSeconds((event.analyticRecoveryAt ?? event.endedAt) - event.startedAt, { style: "long" }) : "";
  const direction = depegDirectionLabel(event.direction, event.peakBasis);
  const title = figure ? `${id.symbol}: ${formatDeviationBps(event.peakDeviationBps)} ${direction}`
    : unverified ? `${id.symbol}: peak unverified` : disputed ? `${id.symbol}: disputed depeg record` : open ? `${id.symbol}: open depeg ${direction}` : `${id.symbol}: depeg ${direction}`;
  const pill = open ? { text: "Ongoing", tone: "severity" as const }
    : disputed ? { text: DEPEG_AUDIT_DISPUTED_BADGE.label, tone: "neutral" as const }
      : figure && level !== "healthy" ? { text: PEG_DEVIATION_LEVEL_LABELS[level], tone: "severity" as const } : undefined;
  const rulerLow = figure && !event.peakBasis && event.direction === "below" && event.pegType === "peggedUSD"
    && event.peakPrice !== null && event.peakPrice > 0 && event.peakPrice < 1 ? event.peakPrice : null;
  // Open, disputed and implausible records publish no figure: the SEO helpers drop it at zero deviation.
  const copyEvent = figure ? event : { ...event, peakDeviationBps: 0 };
  return record(`/depeg/${event.slug}/`, {
    label: "Depeg record", accent: "severity", identity: id,
    dateline: mustFit(`depeg dateline for ${event.slug}`, B.record.dateline,
      collision ? `${dayLabel(isoDay(event.startedAt))} · ${formatEventUtcTime(event.startedAt)}` : dayLabel(isoDay(event.startedAt))),
    title: mustFit(`depeg title for ${event.slug}`, B.record.title, title),
    ...(pill ? { pill } : {}),
    facts: figure ? [
      fit(B.record.fact, peak && `${event.direction === "below" ? "Low" : "High"} ${peak}`),
      event.peakBasis ? "Lower confidence" : undefined,
      fit(B.record.fact, closure.isRecovery && !getDepegEventOnset(event).qualified ? `Recovered after ${duration}` : closure.label),
    ].filter((fact): fact is string => !!fact) : [],
    ...(rulerLow !== null ? { ruler: { peg: 1, floor: rulerFloor(rulerLow), low: rulerLow < 0.01 ? rulerLow : Math.round(rulerLow * 10_000) / 10_000, currencySymbol: "$" } } : {}),
  }, {
    title: buildDepegEventTitle(copyEvent, collision),
    description: buildDepegEventDescription(copyEvent, collision, coin?.name ?? null),
  });
}

function depegHubRuler(): SocialCardHubSubject {
  const bySlug = new Map(readDepegEventSnapshot({ missing: "throw" }).map((event) => [event.slug, event]));
  const lows = DEPEG_HUB_LOWS.map(({ slug, name, logoId }) => {
    const event = bySlug.get(slug);
    if (!event || event.endedAt === null || event.peakBasis || hasUnverifiedDepegPeak(event) || isDisputedAuditVerdict(event.provenance?.auditVerdict) || !isPlausible(event)
      || event.pegType !== "peggedUSD" || event.direction !== "below" || event.peakPrice === null || !(event.peakPrice > 0 && event.peakPrice < 1)) {
      throw new Error(`Depeg hub low must be a closed, undisputed, plausible USD low: ${slug}`);
    }
    const coin = TRACKED_META_BY_ID.get(event.stablecoinId);
    return {
      identity: identity(coin?.symbol ?? event.symbol, name ?? coin?.name ?? event.symbol, coinLogo(logoId ?? event.stablecoinId)),
      when: monthLabel(isoDay(event.startedAt)),
      price: Math.round(event.peakPrice * 1000) / 1000,
    };
  });
  return { kind: "peg-ruler", peg: 1, floor: rulerFloor(Math.min(...lows.map((low) => low.price))), currencySymbol: "$", lows };
}

function digestCard(digest: (typeof DIGEST_ENTRIES)[number]): SocialCardSpec {
  const day = dayLabel(digest.date);
  const weekly = digest.digestType === "weekly";
  const correctionExcerpt = DIGEST_CORRECTIONS.get(digest.date)?.excerpt;
  // Early editions repeat the title as the text's first paragraph.
  const lead = correctionExcerpt ?? firstSentence(digest.text.startsWith(digest.title) ? digest.text.slice(digest.title.length) : digest.text);
  return record(`/digest/${digest.date}/`, {
    label: weekly ? "Weekly recap" : "Daily digest", accent: "ink", masthead: true,
    dateline: digest.editionNumber > 0 ? `No. ${digest.editionNumber} · ${day}` : day,
    title: mustFit(`digest title for ${digest.date}`, B.record.title, digest.title),
    dek: fit(B.record.dek, lead),
  }, {
    title: digest.title,
    description: correctionExcerpt ?? (CLAUSE_DASH.test(lead) ? `${weekly ? "Weekly recap" : "Daily digest"} for ${day}.` : `${day}: ${lead}`),
  });
}

function methodologyLaneCard(lane: (typeof METHODOLOGY_CHANGELOG_REGISTRY)[number]): SocialCardSpec {
  const first = lane.entries[lane.entries.length - 1];
  return record(lane.publicPath, {
    label: "Methodology log", accent: "ink",
    title: mustFit(`methodology title for ${lane.publicPath}`, B.record.title, lane.markdownTitle),
    dek: fit(B.record.dek, lane.llmsDescription), dateline: `Since ${monthLabel(first.date)}`,
  }, { title: lane.markdownTitle, description: `${sentence(lane.llmsDescription)} Each dated release records what changed and why.` });
}

/** A version line's archive, led by the major release that opened it (the x.0 entry). */
function methodologyArchiveCard(archive: (typeof METHODOLOGY_HISTORY_ARCHIVES)[number]): SocialCardSpec {
  const newest = archive.entries[0];
  const major = archive.entries[archive.entries.length - 1];
  const version = archive.archive.toUpperCase();
  const name = `${archive.changelog.feedLabel} ${version}`;
  const [from, to] = [monthLabel(major.date), monthLabel(newest.date)];
  // The major release title often names its own version ("V10: curation…", "Safety Score V9 becomes…").
  const lead = major.title.toUpperCase().startsWith(`${version}:`) ? major.title.slice(version.length + 1).trim() : major.title;
  const title = mustFit(`archive title for ${archive.path}`, B.record.title,
    lead.toUpperCase().includes(name.toUpperCase()) ? lead : `${name}: ${lead}`, `${name} methodology archive`);
  return record(archive.path, {
    label: "Methodology archive", accent: "ink", title, dateline: from === to ? from : `${from} to ${to}`,
    facts: [major.version === newest.version ? `v${major.version}` : `v${major.version} to v${newest.version}`],
  }, {
    title: clip(B.copy.title, title, `${name} methodology archive`),
    description: clip(B.copy.description, major.summary, firstSentence(major.summary)),
  });
}

/** A month of weekly release notes: the month is the dateline, the lead weekly headline the dek. */
function changelogMonthCard(archive: (typeof CHANGELOG_MONTH_ARCHIVES)[number]): SocialCardSpec {
  const headlines = archive.entries.flatMap((entry) => (entry.headline ? [normalizeWhitespace(entry.headline)] : []));
  return record(archive.path, {
    label: "Product changelog", accent: "frost", dateline: archive.label, title: "Pharos release notes", dek: fit(B.record.dek, ...headlines),
  }, { title: `Pharos changelog: ${archive.label}`, description: headlines[0] ?? `Release notes and field notes from ${archive.label}.` });
}

function docCard(doc: (typeof PUBLIC_DOCS)[number]): SocialCardSpec {
  const title = spellOut(doc.title);
  return record(`/docs/${doc.slug}/`, {
    label: "Pharos docs", accent: "ink", title: mustFit(`doc title for ${doc.slug}`, B.record.title, title, doc.title), dek: fit(B.record.dek, doc.summary),
  }, { title: doc.seoTitle ?? `${title} methodology`, description: doc.summary });
}

// ---------------------------------------------------------------------------
// Validation and the catalog
// ---------------------------------------------------------------------------

/** Every budget, charset and shape rule a card must meet; an empty list means the renderer can fit it. */
export function socialCardViolations(card: SocialCardSpec): string[] {
  const issues: string[] = [];
  const drawn = (field: string, text: string | undefined, max = Infinity) => {
    if (text === undefined) return;
    if (!text.trim()) issues.push(`${field} is empty`);
    if (text.length > max) issues.push(`${field} exceeds ${max} characters`);
    if (!isDrawable(text)) issues.push(`${field} has a glyph outside the card fonts or a clause dash`);
  };
  const meta = (field: string, text: string, max: number) => {
    if (!text.trim() || text.length > max || CLAUSE_DASH.test(text)) issues.push(`${field} is empty, over ${max} characters or has a clause dash`);
  };
  const who = (field: string, member: SocialCardIdentity) => {
    drawn(`${field}.symbol`, member.symbol);
    drawn(`${field}.name`, member.name);
  };
  drawn("label", card.label, B.label);
  meta("copy.title", card.copy.title, B.copy.title);
  meta("copy.description", card.copy.description, B.copy.description);
  meta("copy.alt", card.copy.alt, B.copy.alt);
  switch (card.template) {
    case "hub": {
      drawn("headline", card.headline, B.hub.headline);
      drawn("deck", card.deck, B.hub.deck);
      const subject = card.subject;
      if (subject.kind === "cluster") {
        if (subject.members.length < 1 || subject.members.length > 10) issues.push("cluster needs 1 to 10 members");
        subject.members.forEach((member, index) => who(`cluster[${index}]`, member));
      } else if (subject.kind === "orbit") {
        if (subject.members.length > 8) issues.push("orbit takes at most 8 members");
        [subject.center, ...subject.members].forEach((member, index) => who(`orbit[${index}]`, member));
      } else if (subject.kind === "peg-ruler") {
        if (!subject.lows.length || subject.lows.some((low) => !(low.price > subject.floor && low.price < subject.peg))) issues.push("peg ruler lows must sit between floor and peg");
        subject.lows.forEach((low, index) => { who(`lows[${index}]`, low.identity); drawn(`lows[${index}].when`, low.when); });
      }
      break;
    }
    case "dossier":
      who("identity", card.identity);
      drawn("headline", card.headline, B.dossier.headline);
      drawn("subline", card.subline, B.dossier.subline);
      drawn("hook", card.hook, B.dossier.hook);
      if (card.chips.length > B.dossier.chips) issues.push(`more than ${B.dossier.chips} chips`);
      card.chips.forEach((chip, index) => drawn(`chips[${index}]`, chip, B.dossier.chip));
      drawn("stamp", card.stamp);
      break;
    case "versus":
      for (const [field, side] of [["left", card.left], ["right", card.right]] as const) {
        who(field, side);
        drawn(`${field}.symbol`, side.symbol, B.versus.symbol);
        drawn(`${field}.detail`, side.detail, B.versus.detail);
      }
      drawn("hook", card.hook, B.versus.hook);
      break;
    case "record":
      if (card.identity) who("identity", card.identity);
      drawn("title", card.title, B.record.title);
      drawn("dek", card.dek, B.record.dek);
      drawn("dateline", card.dateline, B.record.dateline);
      drawn("pill", card.pill?.text, B.record.pill);
      if ((card.facts?.length ?? 0) > B.record.facts) issues.push(`more than ${B.record.facts} facts`);
      card.facts?.forEach((fact, index) => drawn(`facts[${index}]`, fact, B.record.fact));
      if (card.ruler && !(card.ruler.low > card.ruler.floor && card.ruler.low < card.ruler.peg)) issues.push("ruler low must sit between floor and peg");
      break;
  }
  return issues;
}

/** Every registry-owned public destination, including the public noindex analytical tools. */
export function buildSocialCardCatalog(staticPublicPaths: readonly string[]): SocialCardCatalog {
  const paths = new Set([...PUBLIC_ROUTE_PATHS, ...staticPublicPaths]);
  const cards = new Map<string, SocialCardSpec>();
  const add = (card: SocialCardSpec, registryRoute = false) => {
    cards.set(card.path, card);
    if (registryRoute) paths.add(card.path);
  };

  for (const [path, entry] of Object.entries(HUBS)) add(hub(path, { ...entry, subject: entry.subject() }));
  for (const [path, entry] of Object.entries(RECORDS)) {
    add(record(path, { label: entry.label, accent: entry.accent, title: entry.title, dek: entry.dek, ...(entry.masthead ? { masthead: true } : {}) },
      { title: entry.title, description: entry.description }));
  }
  for (const coin of TRACKED_STABLECOINS) {
    add(coinCard(coin), true);
    if (hasStaticYieldWorkbench(coin)) add(yieldCard(coin), true);
  }
  for (const chainId of getActiveChainIds()) add(chainCard(chainId), true);
  for (const [leftId, rightId] of STATIC_COMPARE_PAIRS) add(compareCard(leftId, rightId));
  for (const peg of PEG_HUB_PEGS) add(pegHubCard(peg));
  for (const page of ALL_STABLECOIN_TAXONOMY_PAGES) add(taxonomyCard(page));
  for (const archetype of MECHANISM_ARCHETYPE_VALUES) add(mechanismCard(archetype));
  for (const study of CASE_STUDY_LIST) add(caseStudyCard(study));
  for (const event of DEPEG_EVENT_ENTRIES) add(depegCard(event), true);
  for (const digest of DIGEST_ENTRIES) add(digestCard(digest), true);
  for (const lane of METHODOLOGY_CHANGELOG_REGISTRY) add(methodologyLaneCard(lane));
  for (const archive of METHODOLOGY_HISTORY_ARCHIVES) add(methodologyArchiveCard(archive));
  for (const archive of CHANGELOG_MONTH_ARCHIVES) add(changelogMonthCard(archive));
  for (const doc of PUBLIC_DOCS) add(docCard(doc));

  const authored = new Map<string, SocialCardAuthored>([["/cemetery/", {
    path: "/cemetery/", sourcePath: "/og-cemetery.png",
    copy: {
      title: "Stablecoin Cemetery", description: "The stablecoins that didn't make it, with causes, dates and obituaries.",
      alt: "The Pharos Stablecoin Cemetery: a surveyed plot map of failed stablecoins.",
    },
  }]]);
  for (const post of BLOG_POSTS) {
    const path = `/blog/${post.slug}/`;
    if (post.coverImage) {
      if (!post.coverAlt) throw new Error(`Authored cover is missing alt text: ${path}`);
      authored.set(path, {
        path, sourcePath: post.coverImage,
        copy: {
          title: clip(B.copy.title, post.title),
          description: clip(B.copy.description, `Published ${dayLabel(post.datePublished)}. ${post.description}`),
          alt: clip(B.copy.alt, post.coverAlt),
        },
      });
    } else {
      add(record(path, {
        label: "Pharos blog", accent: "ink", dateline: dayLabel(post.datePublished),
        title: mustFit(`blog title for ${path}`, B.record.title, post.title), dek: fit(B.record.dek, post.description),
      }, { title: post.title, description: post.description }));
    }
  }

  const out = [...paths].sort().filter((path) => !authored.has(path)).map((path) => {
    const card = cards.get(path);
    if (!card) throw new Error(`Public destination has no authored social preview: ${path}`);
    const issues = socialCardViolations(card);
    if (issues.length) throw new Error(`Social card for ${path} breaks its budget: ${issues.join("; ")}`);
    return card;
  });
  return { cards: out, authored: [...authored.values()].filter((entry) => paths.has(entry.path)).sort((a, b) => (a.path < b.path ? -1 : 1)) };
}
