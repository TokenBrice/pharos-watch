/**
 * Contract between the social-card catalog (what each canonical destination
 * says) and the renderers (how a template draws it).
 *
 * Canonical cards are evergreen: they carry identity, an honest reason to open
 * and a relevant visual, never a live number. Fixed history is allowed: closed
 * depeg lows, death dates, case outcomes, dated edition titles.
 */

/** A registered local image under public/: `/logos/*`, `/chains/*` or `/dexes/*`. */
export interface SocialCardIdentity {
  /** Ticker or short code, printed verbatim ("USDT", "USDe", "ETH"). */
  symbol: string;
  /** Full display name ("Tether", "Ethereum"). */
  name: string;
  /** Absent when no logo is registered: the renderer draws a monogram from `symbol`. */
  logoPath?: string;
}

/** Emitted as og:title / og:description / og:image:alt; never drawn on the image. */
export interface SocialCardCopy {
  title: string;
  description: string;
  alt: string;
}

/** Lifecycle presentation of a dossier; drives the stamp and logo treatment. */
export type SocialCardLifecycle =
  | "active"
  /** Frozen: a Stablecoin Cemetery record. */
  | "historical"
  /** Delisted or quarantined: a listing decision. */
  | "review"
  /** Announced, not launched. */
  | "pre-launch"
  /** Launched, tracking pending. */
  | "launched-untracked";

/** One real, closed historical low drawn on a peg ruler. Fixed history only. */
export interface SocialCardPegLow {
  identity: SocialCardIdentity;
  /** Short date label, e.g. "Mar 2023". */
  when: string;
  /** Lowest observed price in the peg currency, e.g. 0.879. */
  price: number;
}

/** Line glyphs for hubs whose subject has no identity to show. */
export type SocialCardGlyph =
  | "mark"
  | "lock"
  | "gauge"
  | "graph"
  | "flows"
  | "timeline"
  | "filter"
  | "portfolio"
  | "code"
  | "telegram";

export type SocialCardHubSubject =
  /** Registry-selected identities drawn inside the lens, most important first (1–10). */
  | { kind: "cluster"; members: readonly SocialCardIdentity[] }
  /** A centre identity (e.g. a chain) orbited by members (e.g. its stablecoins, 0–8). */
  | { kind: "orbit"; center: SocialCardIdentity; members: readonly SocialCardIdentity[] }
  /** Shield with "?" and the A–F grade-family legend (Safety Scores). */
  | { kind: "grade-shield" }
  /** Real closed lows on one shared price scale from `floor` up to `peg`. */
  | { kind: "peg-ruler"; peg: number; floor: number; currencySymbol: string; lows: readonly SocialCardPegLow[] }
  | { kind: "glyph"; glyph: SocialCardGlyph };

interface SocialCardBase {
  /** Canonical destination path, trailing slash ("/stablecoin/usdt-tether/"). */
  path: string;
  /** Kind label printed beside the Pharos lockup ("Stablecoin dossier"). */
  label: string;
  copy: SocialCardCopy;
}

/** Analytics hubs, tools, cohorts and chains: headline + deck, subject in the lens. */
export interface SocialCardHub extends SocialCardBase {
  template: "hub";
  headline: string;
  deck: string;
  subject: SocialCardHubSubject;
}

/** One instrument: identity in the lens, editorial hook beside it. */
export interface SocialCardDossier extends SocialCardBase {
  template: "dossier";
  identity: SocialCardIdentity;
  /** Usually the ticker; the full name when the ticker is too long to headline. */
  headline: string;
  /** Second line, e.g. "Tether · since 2014", or the ticker when the name headlines. */
  subline: string;
  /** Editorial hook, already screened for volatile wording. */
  hook: string;
  /** At most two short facts ("USD peg", "Custodial cash"). */
  chips: readonly string[];
  lifecycle: SocialCardLifecycle;
  /** Stamp over the lens for non-active lifecycles ("HISTORICAL RECORD"). */
  stamp?: string;
}

/** A named comparison pair. */
export interface SocialCardVersus extends SocialCardBase {
  template: "versus";
  left: SocialCardIdentity & { detail: string };
  right: SocialCardIdentity & { detail: string };
  hook: string;
}

/** Editorial and reference destinations on paper: events, studies, editions, docs. */
export interface SocialCardRecord extends SocialCardBase {
  template: "record";
  /** Left accent bar: severity for incidents, ink for history and reference, frost for product notes. */
  accent: "severity" | "ink" | "frost";
  /** Subject row (logo + symbol) when the record is about one instrument. */
  identity?: SocialCardIdentity;
  /** Top-right mono line, the only place a date is printed ("No. 235 · 17 Oct 2026"). */
  dateline?: string;
  title: string;
  dek?: string;
  /** Outcome or status pill ("Recovered", "Collapsed"). */
  pill?: { text: string; tone: "severity" | "neutral" | "positive" };
  /** At most three short mono lines of fixed facts. */
  facts?: readonly string[];
  /** Depeg records: the fixed low on a ruler from `floor` to `peg`. */
  ruler?: { peg: number; floor: number; low: number; currencySymbol: string };
  /** Digest editions: newspaper masthead rules under the lockup. */
  masthead?: boolean;
}

export type SocialCardSpec = SocialCardHub | SocialCardDossier | SocialCardVersus | SocialCardRecord;

/** An authored image retained as-is (blog covers, the Cemetery scene). */
export interface SocialCardAuthored {
  path: string;
  /** Public path of the authored PNG ("/blog/x-cover.png"). */
  sourcePath: string;
  copy: SocialCardCopy;
}

export interface SocialCardCatalog {
  cards: readonly SocialCardSpec[];
  authored: readonly SocialCardAuthored[];
}

/** The dated scorecard (Worker-rendered share image). The only card that shows a grade. */
export interface SocialScorecardCard {
  identity: SocialCardIdentity;
  grade: string;
  score: number;
  pillars: readonly { name: string; score: number; grade: string }[];
  /** "17 Nov 2026": printed as "As of {asOf}". */
  asOf: string;
}
