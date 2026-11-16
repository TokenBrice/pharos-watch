import {
  BACKING_LABELS_SHORT,
  GOVERNANCE_LABELS_SHORT,
  INFRASTRUCTURE_LABELS,
  MECHANISM_ARCHETYPE_SHORT_LABELS,
  PEG_LABELS_SHORT,
  getMechanismExplainerPath,
} from "../../shared/lib/classification";
import { getActiveChainIds } from "../../shared/lib/chains";
import { isDisputedAuditVerdict } from "../../shared/lib/depeg-audit";
import { METHODOLOGY_HISTORY_ARCHIVES } from "../../shared/lib/methodology-versions/archives";
import { METHODOLOGY_CHANGELOG_REGISTRY } from "../../shared/lib/methodology-versions/registry";
import { PUBLIC_DOCS } from "../../shared/lib/public-docs";
import { TRACKED_STABLECOINS, TRACKED_META_BY_ID } from "../../shared/lib/stablecoins/registry";
import { buildStablecoinUrl } from "../../shared/lib/urls";
import { hasStaticYieldWorkbench } from "../../shared/lib/yield-auto-lending";
import { CHAIN_META } from "../../shared/types/chain-identity";
import type { SocialPreviewSpec, SocialPreviewVisual } from "../../shared/lib/social-preview";
import registeredLogos from "../../data/logos.json";
import { BLOG_POSTS } from "../../src/data/blog";
import { CASE_STUDY_CLIENT_LIST, CASE_STUDY_EVENT_WINDOWS } from "../../src/lib/case-study-client-index";
import { CASE_STUDY_OUTCOME_LABELS } from "../../src/lib/case-study-outcomes";
import { CHANGELOG_MONTH_ARCHIVES } from "../../src/lib/changelog-history";
import { STATIC_COMPARE_PAIRS, buildStaticComparisonSlug } from "../../src/lib/compare-links";
import { DEPEG_EVENT_ENTRIES } from "../../src/lib/depeg-event-page-data";
import { getDepegEventClosurePresentation } from "../../src/lib/depeg-event-display";
import { DIGEST_ENTRIES } from "../../src/lib/digest-registry";
import { PEG_HUB_PEGS, PEG_HUB_SLUGS } from "../../src/lib/peg-landing";
import { PUBLIC_ROUTE_PATHS } from "../../src/lib/public-route-inventory";
import { ALL_STABLECOIN_TAXONOMY_PAGES } from "../../src/lib/stablecoin-taxonomy";
import { ARCHETYPE_CONTENT } from "../../src/lib/mechanism-explainers";
import { MECHANISM_ARCHETYPE_VALUES } from "../../shared/types/stablecoin-taxonomy";

type Copy = Omit<SocialPreviewSpec, "path">;
type DiagramKind = Extract<SocialPreviewVisual, { labels: readonly [string, string] }>["kind"];

function signal(subject: string, hook: string, kind: DiagramKind, labels: readonly [string, string], facts: Copy["facts"] = []): Copy {
  return { grammar: "signal", eyebrow: "Stablecoin intelligence", subject, hook, facts, visual: { kind, labels } };
}

function briefing(subject: string, hook: string, labels: readonly [string, string], facts: Copy["facts"] = []): Copy {
  return { grammar: "briefing", eyebrow: "The Pharos briefing", subject, hook, facts, visual: { kind: "document", labels } };
}

/** Authored copy, not a route roster: membership comes from the site's inventory and page tree. */
const STATIC_COPY: Readonly<Record<string, Copy>> = {
  "/": signal("Stablecoins, under the lens.", "See the peg. Trace the backing. Know the exit.", "lighthouse", ["Peg behavior", "Backing & exits"]),
  "/stablecoins/": signal("The stablecoin field guide", "Look past the ticker. Compare what holds it together.", "reserves", ["Backing models", "Control & exits"]),
  "/chains/": signal("Where stablecoins live", "Follow stablecoin supply across chains.", "chain", ["Networks", "Stablecoin deployments"]),
  "/dependency-map/": signal("Follow the dependencies", "One stablecoin's backing can be another's risk.", "network", ["Stablecoins", "Upstream collateral"]),
  "/timeline/": signal("The stablecoin event tape", "Depegs, freezes and methodology changes, in order.", "flows", ["Events", "Context"]),
  "/flows/": signal("Follow the mint. Follow the burn.", "Read issuer activity from both sides of the supply.", "flows", ["Mint", "Burn"]),
  "/freezewatch/": signal("Who can freeze the money?", "Trace issuer controls and upstream freeze exposure.", "control", ["Issuer controls", "Upstream exposure"]),
  "/liquidity/": signal("How deep is the exit?", "Explore DEX liquidity beyond the headline pool size.", "liquidity", ["Market depth", "Exit routes"]),
  "/yield/": signal("Yield has a source. And a risk.", "Compare how stablecoins earn, not just what they pay.", "yield", ["Yield sources", "Risk context"]),
  "/alt-pegs/": signal("Beyond the dollar peg", "Explore stablecoins tied to currencies and commodities.", "peg", ["Currencies", "Commodities"]),
  "/coverage/": briefing("What Pharos watches", "See the scope, the sources and the blind spots.", ["Coverage", "Limitations"]),
  "/upcoming/": briefing("Before the stablecoin launches", "Follow issuer plans, milestones and the missing pieces.", ["Milestones", "Launch evidence"]),
  "/compare/": { ...signal("Same peg. Different design.", "Compare backing, control and the way out.", "liquidity", ["Two designs", "One peg"]), eyebrow: "Side by side" },
  "/screener/": signal("Find your stablecoin criteria", "Filter the field by backing, governance and risk.", "filter", ["Set criteria", "Explore the field"]),
  "/screener/picker/": signal("Start with how you'll use it", "Explore a profile-fit shortlist. Verify the trade-offs.", "filter", ["Use-case profiles", "Not financial advice"]),
  "/portfolio/": signal("Look through your portfolio", "Explore stablecoin risk and shared dependencies.", "portfolio", ["Portfolio tools", "Inputs stay private"]),
  "/funding/": briefing("Independent intelligence needs backing", "See how Pharos is funded—and help keep it independent.", ["Public funding record", "Support Pharos"]),
  "/pharoswatchbot/": signal("The lighthouse, in Telegram", "Choose stablecoin alerts without watching every screen.", "code", ["Stablecoin alerts", "Telegram"]),
  "/depeg/": signal("When the peg stops holding", "Investigate deviations, confirmed incidents and recovery.", "peg", ["Peg deviations", "Incident evidence"]),
  "/depeg/archive/": briefing("The depeg record", "Explore confirmed incidents, with dates and source context.", ["Incident history", "Source evidence"]),
  "/safety-scores/": signal("What's behind the grade?", "Backing. Control. Exit. A stablecoin risk framework.", "reserves", ["Structural risk", "Evidence & methodology"]),
  "/safety-scores/map/": signal("A map of stablecoin risk", "Explore the field through Backing, Control and Exit.", "network", ["Safety Score map", "Methodology context"]),
  "/stability-index/": signal("Read the pressure on the peg", "A system-wide lens on stablecoin stress.", "peg", ["Pharos Stability Index", "Stress methodology"]),
  "/compliance/": briefing("Stablecoins meet the rulebook", "Inspect GENIUS Act and MiCA evidence, issuer by issuer.", ["GENIUS Act", "MiCA"]),
  "/status/": briefing("Inside the watchtower", "Inspect data freshness, pipeline coverage and service status.", ["Data freshness", "Service diagnostics"]),
  "/digest/": briefing("The stablecoin field report", "Daily briefings and weekly recaps, with the context intact.", ["Daily digest", "Weekly recap"]),
  "/methodology/": briefing("Show your working", "How Pharos turns stablecoin evidence into useful signals.", ["Methods", "Evidence & limits"]),
  "/changelog/": briefing("The watchtower's logbook", "What changed on Pharos, and why it matters.", ["Product changes", "Weekly field notes"]),
  "/blog/": briefing("Notes from the lighthouse", "The ideas, design choices and research behind Pharos.", ["Research", "Building in public"]),
  "/about/": briefing("A lighthouse for stablecoins", "Independent intelligence for money that promises stability.", ["The project", "The approach"]),
  "/privacy/": briefing("Your data, in plain sight", "What Pharos collects, what stays local and what sharing means.", ["Data practices", "Privacy boundaries"]),
  "/api/": signal("Build with stablecoin intelligence", "Bring Pharos evidence into your own tools.", "code", ["API access", "Stablecoin data"]),
  "/api/reference/": briefing("The Pharos API, documented", "Inspect endpoints, response contracts and access rules.", ["Response contracts", "Access rules"]),
  "/docs/": briefing("Read the evidence rules", "The methods, definitions and limits behind the dashboard.", ["Public documentation", "Methodology"]),
  "/stablecoins/backing/": signal("What backs the promise?", "Compare real-world assets, crypto collateral and algorithms.", "reserves", ["Backing models", "Collateral design"]),
  "/stablecoins/governance/": signal("Who holds the controls?", "Explore stablecoin governance and centralized dependencies.", "network", ["Governance", "Control dependencies"]),
  "/stablecoins/infrastructure/": signal("Shared code. Shared questions.", "Explore stablecoins built on common infrastructure.", "network", ["Infrastructure families", "Design dependencies"]),
  "/learn/mechanisms/": briefing("How stablecoins work", "From cash reserves to synthetic hedges: follow the mechanism.", ["Designs", "Trade-offs"]),
  "/learn/case-studies/": briefing("When stablecoins met the stress test", "Read the incidents, the mechanisms and what happened next.", ["Historical case studies", "Source-led analysis"]),
};

export interface PreservedSocialPreview {
  path: string;
  url: string;
  alt: string;
  title: string;
  description: string;
}

export interface SocialPreviewCatalog {
  specs: readonly SocialPreviewSpec[];
  preserved: readonly PreservedSocialPreview[];
}

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
function day(value: string | number): string {
  return DATE.format(new Date(typeof value === "number" ? value * 1000 : `${value.slice(0, 10)}T00:00:00Z`));
}

function logoPath(id: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(registeredLogos, id)
    ? (registeredLogos as Readonly<Record<string, string>>)[id]
    : undefined;
}

/** Every registry-owned public page, including the public noindex analytical tools. */
export function buildSocialPreviewCatalog(staticPublicPaths: readonly string[] = []): SocialPreviewCatalog {
  const candidates = new Map<string, Copy>(Object.entries(STATIC_COPY));
  const paths = new Set([...PUBLIC_ROUTE_PATHS, ...staticPublicPaths]);
  const preserved: PreservedSocialPreview[] = [{
    path: "/cemetery/", url: "/og-cemetery.png", title: "Stablecoin Cemetery", description: "The stablecoins that didn't make it, with causes, dates and obituaries.",
    alt: "The Pharos Stablecoin Cemetery: a surveyed plot map of failed stablecoins.",
  }];

  for (const coin of TRACKED_STABLECOINS) {
    const path = buildStablecoinUrl(coin.id);
    paths.add(path);
    const backing = BACKING_LABELS_SHORT[coin.flags.backing];
    const peg = `${PEG_LABELS_SHORT[coin.flags.pegCurrency]} reference`;
    const frozen = coin.status === "frozen";
    const delisted = coin.status === "delisted";
    const held = coin.status === "quarantined";
    const upcoming = coin.status === "pre-launch";
    if (frozen && !coin.frozenAt) throw new Error(`Historical social preview is missing its freeze date: ${coin.id}`);
    if ((delisted || held) && !coin.listingStatusReview) throw new Error(`Social listing review is missing its decision: ${coin.id}`);
    candidates.set(path, {
      grammar: "dossier",
      eyebrow: frozen ? "Historical stablecoin dossier" : delisted ? "Instrument listing review" : held ? "Listing review · data on hold" : upcoming ? "Upcoming instrument" : "Stablecoin dossier",
      subject: coin.name,
      hook: frozen ? `The ${coin.symbol} record: legacy design and preserved history.`
        : delisted ? `Why ${coin.symbol} is out of scope: the listing decision and its evidence.`
          : held ? `${coin.symbol}: the listing review behind the data hold.`
            : upcoming ? `${coin.symbol}: launch plans, milestones and missing evidence.`
              : `Inside ${coin.symbol}: backing, controls and exits.`,
      facts: frozen ? [`Frozen ${day(coin.frozenAt!)}`, "Historical record"]
        : delisted ? [`Reviewed ${day(coin.listingStatusReview!.changedAt)}`, "Not actively tracked"]
          : held ? [`Reviewed ${day(coin.listingStatusReview!.changedAt)}`, "Data on hold"]
            : upcoming ? ["Launch evidence", "Not yet active"] : [backing, peg],
      visual: { kind: "identity", symbol: coin.symbol, name: coin.name, logoPath: logoPath(coin.id), facets: [backing, peg] },
    });
    if (hasStaticYieldWorkbench(coin)) {
      const yieldPath = buildStablecoinUrl(coin.id, "yield/");
      paths.add(yieldPath);
      candidates.set(yieldPath, { ...signal(`${coin.symbol}: ${frozen || delisted || held ? "the yield record" : "inside the yield"}`, frozen || delisted || held ? "Read the retained source history and listing context." : "Trace the sources, warnings and source-switch history.", "yield", [coin.symbol, frozen || delisted || held ? "Retained history" : "Yield sources"]), eyebrow: frozen || delisted || held ? "Historical yield record" : "Yield analysis" });
    }
  }

  for (const chainId of getActiveChainIds()) {
    const path = `/chains/${chainId}/`;
    paths.add(path);
    candidates.set(path, { ...signal(`Stablecoins on ${CHAIN_META[chainId].name}`, "Explore the network's stablecoin supply and liquidity.", "chain", [CHAIN_META[chainId].name, "Stablecoins"]), eyebrow: "Chain dossier" });
  }

  for (const [leftId, rightId] of STATIC_COMPARE_PAIRS) {
    const left = TRACKED_META_BY_ID.get(leftId);
    const right = TRACKED_META_BY_ID.get(rightId);
    if (!left || !right) throw new Error(`Unknown comparison identity: ${leftId} / ${rightId}`);
    candidates.set(`/compare/${buildStaticComparisonSlug(leftId, rightId)}/`, {
      grammar: "dossier", eyebrow: "Stablecoin comparison", subject: `${left.symbol} vs ${right.symbol}`,
      hook: "Compare the backing, the controls and the exit.", facts: [],
      visual: { kind: "contrast", left: { symbol: left.symbol, label: BACKING_LABELS_SHORT[left.flags.backing], logoPath: logoPath(left.id) }, right: { symbol: right.symbol, label: BACKING_LABELS_SHORT[right.flags.backing], logoPath: logoPath(right.id) } },
    });
  }

  for (const peg of PEG_HUB_PEGS) {
    candidates.set(`/stablecoins/${PEG_HUB_SLUGS[peg]}/`, {
      ...signal(`${PEG_LABELS_SHORT[peg]} stablecoins`, "One reference. Different backing, controls and exits.", "peg", [PEG_LABELS_SHORT[peg], "Stablecoin designs"]), eyebrow: "Peg field guide",
    });
  }
  for (const page of ALL_STABLECOIN_TAXONOMY_PAGES) {
    const label = page.kind === "backing" ? BACKING_LABELS_SHORT[page.value as keyof typeof BACKING_LABELS_SHORT]
      : page.kind === "governance" ? GOVERNANCE_LABELS_SHORT[page.value as keyof typeof GOVERNANCE_LABELS_SHORT]
        : INFRASTRUCTURE_LABELS[page.value as keyof typeof INFRASTRUCTURE_LABELS];
    candidates.set(page.href, {
      ...signal(`${label} stablecoins`, page.kind === "backing" ? "Follow the collateral behind the promise." : page.kind === "governance" ? "Compare who controls the money—and who it depends on." : "Shared infrastructure. Compare the design trade-offs.", page.kind === "backing" ? "reserves" : "network", [label, page.kind === "backing" ? "Backing design" : page.kind === "governance" ? "Governance design" : "Shared infrastructure"]),
      eyebrow: "Stablecoin field guide",
    });
  }

  for (const archetype of MECHANISM_ARCHETYPE_VALUES) {
    const label = MECHANISM_ARCHETYPE_SHORT_LABELS[archetype];
    candidates.set(getMechanismExplainerPath(archetype), {
      ...briefing(`${label} stablecoins`, ARCHETYPE_CONTENT[archetype].headline, [label, "Design & failure modes"]), eyebrow: "Mechanism explained",
    });
  }
  for (const study of CASE_STUDY_CLIENT_LIST) {
    const window = CASE_STUDY_EVENT_WINDOWS.find((entry) => entry.slug === study.slug);
    if (!window) throw new Error(`Missing case-study event window: ${study.slug}`);
    candidates.set(`/learn/case-studies/${study.slug}/`, {
      grammar: "briefing", eyebrow: "Historical case study", subject: study.title,
      hook: "What happened, why it mattered, and what the evidence shows.",
      facts: [day(window.startISO), `Outcome: ${CASE_STUDY_OUTCOME_LABELS[study.outcome]}`],
      visual: { kind: "edition", date: window.startISO.slice(0, 10), label: CASE_STUDY_OUTCOME_LABELS[study.outcome] },
    });
  }

  for (const digest of DIGEST_ENTRIES) {
    const path = `/digest/${digest.date}/`;
    paths.add(path);
    candidates.set(path, {
      grammar: "briefing", eyebrow: digest.digestType === "weekly" ? "Weekly stablecoin recap" : "Daily stablecoin digest",
      subject: digest.title, hook: "A dated field report from the stablecoin watchtower.", facts: [day(digest.date)],
      visual: { kind: "edition", date: digest.date.slice(0, 10), label: digest.digestType === "weekly" ? "Weekly recap" : "Daily digest" },
    });
  }
  for (const event of DEPEG_EVENT_ENTRIES) {
    const path = `/depeg/${event.slug}/`;
    paths.add(path);
    const disputed = isDisputedAuditVerdict(event.provenance?.auditVerdict);
    const closure = event.endedAt === null || disputed ? null : getDepegEventClosurePresentation(event);
    candidates.set(path, {
      grammar: "briefing", eyebrow: disputed ? "Disputed event record" : "Confirmed depeg record", subject: `${event.symbol}: the ${day(event.startedAt)} depeg`,
      hook: disputed ? "Read the incident record and its disputed source evidence." : "Trace the incident, the reference and the source evidence.",
      facts: closure && event.endedAt !== null ? [closure.label, `Ended ${day(event.endedAt)}`] : [event.direction === "above" ? "Traded above reference" : "Traded below reference"],
      visual: { kind: "edition", date: new Date(event.startedAt * 1000).toISOString().slice(0, 10), label: "Incident record" },
    });
  }

  for (const lane of METHODOLOGY_CHANGELOG_REGISTRY) {
    candidates.set(lane.publicPath, {
      ...briefing(`${lane.feedLabel}: the methodology log`, "Follow the rule changes and the reasoning behind them.", ["Methodology history", lane.feedLabel]), eyebrow: "Methods, with a paper trail",
    });
  }
  for (const archive of METHODOLOGY_HISTORY_ARCHIVES) {
    candidates.set(archive.path, {
      ...briefing(`${archive.changelog.feedLabel}: ${archive.archive.toUpperCase()} archive`, "The original methodology changes, retained in context.", ["Historical methodology", archive.archive.toUpperCase()]), eyebrow: "Methodology archive",
    });
  }
  for (const archive of CHANGELOG_MONTH_ARCHIVES) {
    candidates.set(archive.path, {
      ...briefing(`Pharos, ${archive.label}`, "The product changes and field notes from this month.", [archive.label, "Changelog archive"]), eyebrow: "The watchtower's logbook",
    });
  }
  for (const doc of PUBLIC_DOCS) {
    candidates.set(`/docs/${doc.slug}/`, {
      ...briefing(doc.title, "Read the definitions, evidence rules and limitations.", ["Reference guide", "Evidence & limits"]), eyebrow: "Inside the methodology",
    });
  }
  for (const post of BLOG_POSTS) {
    const path = `/blog/${post.slug}/`;
    if (post.coverImage) {
      if (!post.coverAlt) throw new Error(`Authored cover is missing alt text: ${path}`);
      preserved.push({ path, url: post.coverImage, alt: post.coverAlt, title: post.title, description: `Published ${day(post.datePublished)}. ${post.description}` });
    } else {
      candidates.set(path, {
        grammar: "briefing", eyebrow: "Notes from the lighthouse", subject: post.title, hook: post.description,
        facts: [day(post.datePublished)], visual: { kind: "edition", date: post.datePublished, label: "Pharos blog" },
      });
    }
  }

  const preservedPaths = new Set(preserved.map((entry) => entry.path));
  const specs = [...paths].filter((path) => !preservedPaths.has(path)).sort().map((path) => {
    const copy = candidates.get(path);
    if (!copy) throw new Error(`Public destination has no authored social preview: ${path}`);
    return { path, ...copy };
  });
  return { specs, preserved: preserved.filter((entry) => paths.has(entry.path)).sort((a, b) => a.path.localeCompare(b.path)) };
}
