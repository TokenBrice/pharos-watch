import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as classification from "../classification";
import {
  BACKING_BADGE_STYLES,
  BACKING_LABELS,
  BACKING_LABELS_SHORT,
  BACKING_PROSE_LABELS,
  BACKING_SENTENCE_LABELS,
  GOVERNANCE_BADGE_STYLES,
  GOVERNANCE_LABELS,
  GOVERNANCE_LABELS_SHORT,
  GOVERNANCE_PROSE_LABELS,
  THREAT_BAND_HEX,
  THREAT_BAND_LABELS,
  THREAT_BAND_ORDER,
  THREAT_BAND_STYLES,
} from "../classification";
import {
  GENIUS_AUTHORIZATION_STATUS_BADGE_STYLES,
  GENIUS_AUTHORIZATION_STATUS_DESCRIPTIONS,
  GENIUS_STATUS_SHORT_LABELS,
  GENIUS_STATUS_TEXT_CLS,
} from "../genius";
import { MICA_STATUS_BADGE_STYLES, MICA_STATUS_DESCRIPTIONS } from "../mica";

describe("classification descriptor projections", () => {
  it("preserves the completed descriptor projections", () => {
    const { HERO_CHIP_BACKING_LABELS, HERO_CHIP_GOVERNANCE_LABELS, MECHANISM_ARCHETYPE_DESCRIPTORS,
      MECHANISM_ARCHETYPE_LABELS, MECHANISM_ARCHETYPE_SHORT_LABELS, MECHANISM_ARCHETYPE_ONE_LINERS, GRADE_RADAR_COLORS } = classification;
    const projections = [HERO_CHIP_BACKING_LABELS, HERO_CHIP_GOVERNANCE_LABELS, MECHANISM_ARCHETYPE_DESCRIPTORS,
      MECHANISM_ARCHETYPE_LABELS, MECHANISM_ARCHETYPE_SHORT_LABELS, MECHANISM_ARCHETYPE_ONE_LINERS, GRADE_RADAR_COLORS];
    expect(createHash("sha256").update(JSON.stringify(projections)).digest("hex"))
      .toBe("621fcbda135b95044ddffb148ea858710f28b9751846fcf8d208f1a30d60e0e9");
  });

  it("preserves every governance and backing projection", () => {
    expect(GOVERNANCE_LABELS).toEqual({ centralized: "Centralized (CeFi)", "centralized-dependent": "CeFi-Dependent", decentralized: "Decentralized (DeFi)" });
    expect(GOVERNANCE_LABELS_SHORT).toEqual({ centralized: "CeFi", "centralized-dependent": "CeFi-Dep", decentralized: "DeFi" });
    expect(GOVERNANCE_PROSE_LABELS).toEqual({ centralized: "centralized", "centralized-dependent": "CeFi-dependent", decentralized: "decentralized" });
    expect(GOVERNANCE_BADGE_STYLES).toEqual({
      centralized: { label: "Centralized", cls: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/20" },
      "centralized-dependent": { label: "CeFi-Dependent", cls: "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20" },
      decentralized: { label: "Decentralized", cls: "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20" },
    });
    expect(BACKING_LABELS).toEqual({ "rwa-backed": "Real-World Asset Backed", "crypto-backed": "Crypto-Collateralized", algorithmic: "Algorithmic" });
    expect(BACKING_LABELS_SHORT).toEqual({ "rwa-backed": "RWA", "crypto-backed": "Crypto", algorithmic: "Algo" });
    expect(BACKING_SENTENCE_LABELS).toEqual({ "rwa-backed": "RWA-backed", "crypto-backed": "Crypto-backed", algorithmic: "algorithmic" });
    expect(BACKING_PROSE_LABELS).toEqual({ "rwa-backed": "backed by real-world assets", "crypto-backed": "collateralized by crypto assets", algorithmic: "algorithmic stablecoin" });
    expect(BACKING_BADGE_STYLES).toEqual({
      "rwa-backed": { label: "RWA-Backed", cls: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20" },
      "crypto-backed": { label: "Crypto-Backed", cls: "bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/20" },
      algorithmic: { label: "Algorithmic", cls: "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20" },
    });
  });

  it("preserves every DEWS band projection", () => {
    expect(THREAT_BAND_ORDER).toEqual({ CALM: 0, WATCH: 1, ALERT: 2, WARNING: 3, DANGER: 4 });
    expect(THREAT_BAND_LABELS).toEqual({ CALM: "Calm", WATCH: "Watch", ALERT: "Alert", WARNING: "Warning", DANGER: "Danger" });
    expect(THREAT_BAND_HEX).toEqual({ CALM: "#22c55e", WATCH: "#14b8a6", ALERT: "#eab308", WARNING: "#f97316", DANGER: "#ef4444" });
    expect(THREAT_BAND_STYLES).toEqual({
      CALM: { cls: "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20", textCls: "text-green-700 dark:text-green-400" },
      WATCH: { cls: "bg-teal-500/10 text-teal-700 dark:text-teal-400 border-teal-500/20", textCls: "text-teal-700 dark:text-teal-400" },
      ALERT: { cls: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/20", textCls: "text-yellow-700 dark:text-yellow-400" },
      WARNING: { cls: "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20", textCls: "text-orange-700 dark:text-orange-400" },
      DANGER: { cls: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20", textCls: "text-red-700 dark:text-red-400" },
    });
  });

  it("preserves every GENIUS authorization-status projection", () => {
    expect(GENIUS_STATUS_SHORT_LABELS).toEqual({
      "ppsi-approved": "PPSI Approved", "state-qualified": "State Qualified", "official-application-pending": "Filing Pending",
      "issuer-announced-intent": "Issuer Intent", "no-public-authorization-found": "None Found", "not-applicable": "Not Applicable", unknown: "Unknown",
    });
    expect(GENIUS_STATUS_TEXT_CLS).toEqual({
      "ppsi-approved": "text-emerald-700 dark:text-emerald-400", "state-qualified": "text-emerald-700 dark:text-emerald-400",
      "official-application-pending": undefined, "issuer-announced-intent": undefined,
      "no-public-authorization-found": "text-muted-foreground", "not-applicable": "text-muted-foreground", unknown: "text-muted-foreground",
    });
    expect(GENIUS_AUTHORIZATION_STATUS_BADGE_STYLES).toEqual({
      "ppsi-approved": { label: "PPSI Approved", cls: "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20" },
      "state-qualified": { label: "State Qualified", cls: "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20" },
      "official-application-pending": { label: "Official Pending", cls: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20" },
      "issuer-announced-intent": { label: "Issuer Intent", cls: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20" },
      "no-public-authorization-found": { label: "No Public Auth Found", cls: "bg-muted/40 text-muted-foreground border-border/60" },
      "not-applicable": { label: "Not Applicable", cls: "bg-muted/40 text-muted-foreground border-border/60" },
      unknown: { label: "Unknown", cls: "bg-muted/40 text-muted-foreground border-border/60" },
    });
    expect(GENIUS_AUTHORIZATION_STATUS_DESCRIPTIONS).toEqual({
      "ppsi-approved": "Official source identifies a domestic permitted payment stablecoin issuer approval for this token or issuer pathway.",
      "state-qualified": "Official source identifies a state-qualified payment stablecoin issuer pathway.",
      "official-application-pending": "Public regulator source shows an application or registration is filed and pending.",
      "issuer-announced-intent": "Issuer or partner materials signal a GENIUS-era issuance path, but no token-specific official approval was found.",
      "no-public-authorization-found": "A dated negative-evidence review found no qualifying public approval, application, or registration source.",
      "not-applicable": "The reviewed asset is outside the tracked GENIUS payment-stablecoin authorization posture.",
      unknown: "The public posture has not been resolved from available sources.",
    });
  });

  it("preserves every MiCA status projection", () => {
    expect(MICA_STATUS_BADGE_STYLES).toEqual({
      authorized: { label: "Authorized", cls: "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20", textCls: "text-green-700 dark:text-green-400" },
      pending: { label: "Pending", cls: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20", textCls: "text-amber-700 dark:text-amber-400" },
      transitional: { label: "Transitional", cls: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20", textCls: "text-amber-700 dark:text-amber-400" },
      "non-compliant": { label: "Non-Compliant", cls: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20", textCls: "text-red-700 dark:text-red-400" },
      "out-of-scope": { label: "Out of Scope", cls: "bg-muted/40 text-muted-foreground border-border/60", textCls: "text-muted-foreground" },
    });
    expect(MICA_STATUS_DESCRIPTIONS).toEqual({
      authorized: "Issuer holds an in-effect EMI or credit-institution authorization listed on a competent-authority register.",
      pending: "Authorization application filed with a competent authority; decision outstanding.",
      transitional: "Offered or traded on EU venues under a member-state CASP grandfathering window; no issuer authorization yet.",
      "non-compliant": "In EU scope with no authorization or transitional cover; delisted or restricted on EU venues.",
      "out-of-scope": "Not offered to the public or admitted to trading in the EU.",
    });
  });
});
