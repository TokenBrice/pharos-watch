import { ContentTable } from "@/components/table";
import { MINT_AUTHORITY_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/constants";
import {
  MethodologyDetails,
  MethodologyFacts,
  MethodologySectionShell,
  WorkedExample,
} from "../../methodology-shared";
import { MINT_AUTHORITY_SCORE_SECTION_CONTENT } from "../methodology-content";

const COMPONENT_COLUMNS = [
  { id: "component", header: "Component", rowHeader: true },
  { id: "weight", header: "Weight" },
  { id: "meaning", header: "Meaning", cellClassName: "whitespace-normal" },
] as const;

const COMPONENT_ROWS = [
  {
    id: "route",
    cells: {
      component: "Route",
      weight: "30%",
      meaning: "Structural mint route family, from immutable user collateral to bridges, backend signers, or issuer-direct minting.",
    },
  },
  {
    id: "controller",
    cells: {
      component: "Controller",
      weight: "40%",
      meaning: "Weakest mint-capable controller across direct minters, minter admins, cap admins, proxy admins, bridge admins, and upgrade paths.",
    },
  },
  {
    id: "bounds",
    cells: {
      component: "Bounds",
      weight: "15%",
      meaning: "Whether mint-capable routes are quantitatively capped, and whether a privileged actor can raise those caps.",
    },
  },
  {
    id: "posture",
    cells: {
      component: "Posture",
      weight: "15%",
      meaning: "Reviewed authority posture, from no privileged route through bounded, concentrated, or unbounded/compromised authority.",
    },
  },
] as const;

const BAND_COLUMNS = [
  { id: "band", header: "Band", rowHeader: true },
  { id: "range", header: "Range" },
  { id: "meaning", header: "Meaning", cellClassName: "whitespace-normal" },
] as const;

const BAND_ROWS = [
  { id: "hardened", cells: { band: "Hardened", range: "80-100", meaning: "No resolved privileged mint path or strongly bounded, high-confidence controls." } },
  { id: "governed", cells: { band: "Governed", range: "65-79", meaning: "Governance or admin controls exist, but they are comparatively bounded or slow." } },
  { id: "managed", cells: { band: "Managed", range: "50-64", meaning: "Active mint management exists with some controls or route limits." } },
  { id: "concentrated", cells: { band: "Concentrated", range: "35-49", meaning: "A small operator, backend, custodian, bridge, or low-threshold route can affect supply." } },
  { id: "exposed", cells: { band: "Exposed", range: "0-34", meaning: "Unbounded, compromised, single-key, or otherwise weak authority dominates the score." } },
  { id: "nr", cells: { band: "NR", range: "Not rated", meaning: "Missing, unknown, inherited-but-unresolved, or insufficient review data." } },
] as const;

export function MintAuthorityScoreMethodologySection() {
  return (
    <MethodologySectionShell
      id={MINT_AUTHORITY_SCORE_SECTION_CONTENT.id}
      title={MINT_AUTHORITY_SCORE_SECTION_CONTENT.title}
      versionBadge={{ label: MINT_AUTHORITY_METHODOLOGY_VERSION_LABEL }}
      versionNote="Version increments when weights, route/controller scores, caps, bands, inheritance, or NR semantics change."
    >
      <p>
        Mint Authority Score measures how much durable stablecoin supply can be created, authorized, expanded, or
        routed by privileged actors. It focuses on mint paths such as issuer minters, allowlisted minters, cap admins,
        proxy admins, facilitators, bridges, off-chain attestation systems, backend signers, governance, Safes/multisigs,
        custodians, and wrapper inheritance.
      </p>
      <MethodologyFacts
        facts={[
          { label: "Score range", value: "0-100, with NR for missing or unresolved review data" },
          { label: "Main risk", value: "Privileged durable supply creation or mint-route expansion" },
          { label: "Safety Score role", value: "V9 evaluates the underlying reviewed control facts directly" },
        ]}
      />
      <ContentTable
        tableId="methodology-mint-authority-components"
        testId="methodology-mint-authority-components-table"
        columns={COMPONENT_COLUMNS}
        rows={COMPONENT_ROWS}
      />
      <WorkedExample summary="Worked example: compromised privileged mint route">
        <p className="pharos-numeric">Inputs: route=40, controller=15, bounds=30, posture=5</p>
        <p className="pharos-numeric">rawScore=round(40*0.30 + 15*0.40 + 30*0.15 + 5*0.15)=23</p>
        <p>
          Because the profile records an unbounded or compromised posture with a privileged-mint incident, the incident
          cap limits the final score to <span className="text-foreground">10/100 (Exposed)</span>.
        </p>
      </WorkedExample>
      <MethodologyDetails summary="Technical details: caps, inheritance, and bands">
        <div className="space-y-2">
          <h3 className="text-foreground font-medium">Caps</h3>
          <ul className="list-disc list-inside space-y-1">
            <li>
              Bounds: cap-limited controls receive the immutable-cap bonus only when every cap-limited mint-capable
              control explicitly records that its cap cannot be raised. Unknown or omitted cap-mutability evidence stays
              bounded, but does not score as immutable.
            </li>
            <li>
              Incident cap: unbounded or compromised authority with a recorded mint incident is capped by the age of
              the most recent incident — 10 when under 2 years old, 15 at 2-4 years, 20 at 4+ years. Decay is purely
              time-based and always stays below the no-incident unbounded cap.
            </li>
            <li>Unbounded cap: unbounded or compromised authority without a recorded incident is capped at 25.</li>
            <li>EOA cap: a non-issuer-context EOA that can mint or authorize minting without MPC/HSM attestation is capped at 40.</li>
            <li>Confidence cap: verified caps at 100, probable at 90, manual-review at 85, and unknown returns NR.</li>
          </ul>
        </div>
        <div className="space-y-2">
          <h3 className="text-foreground font-medium">Wrapper inheritance</h3>
          <p>
            `wrapped-or-variant-inherited` rows inherit from `inheritedFrom`. If the parent is scoreable, the wrapper
            score is the lower of the parent score and a blend of 60% parent score plus 40% weakest wrapper-control score.
            Missing parents, cycles, unresolved parents, and depth-limit cases return NR.
          </p>
        </div>
        <ContentTable
          tableId="methodology-mint-authority-bands"
          testId="methodology-mint-authority-bands-table"
          columns={BAND_COLUMNS}
          rows={BAND_ROWS}
        />
      </MethodologyDetails>
    </MethodologySectionShell>
  );
}
