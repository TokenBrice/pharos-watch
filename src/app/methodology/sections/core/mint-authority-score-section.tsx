import { ContentTable } from "@/components/table";
import { MINT_AUTHORITY_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/constants";
import { V9_MINT_POSTURE_BANDS } from "@shared/lib/safety-score-v9/mint-posture";
import {
  MethodologyDetails,
  MethodologyFacts,
  MethodologySectionShell,
  WorkedExample,
} from "../../methodology-shared";
import { MINT_AUTHORITY_SCORE_SECTION_CONTENT } from "@/lib/methodology-content";

const SIGNAL_COLUMNS = [
  { id: "signal", header: "Signal", rowHeader: true },
  { id: "effect", header: "Effect" },
  { id: "meaning", header: "Meaning", cellClassName: "whitespace-normal" },
] as const;

const SIGNAL_ROWS = [
  {
    id: "posture",
    cells: {
      signal: "Derived posture",
      effect: "Sets the base",
      meaning:
        "Cap semantics, claim impairment, reconciliation cadence, and supervisory regime place the mint on a posture rung: no live authority, bounded admin, partially bounded, unbounded-but-reconciled, concentrated, or unbounded/compromised.",
    },
  },
  {
    id: "incident",
    cells: {
      signal: "Resolved-incident decay",
      effect: "Caps the component",
      meaning:
        "A resolved mint incident caps the component and the cap relaxes with the incident's age: while recent the mint reads no better than a concentrated admin, from two years as a partially bounded admin, and from four years as a bounded admin. It never reaches the clean-record rung, so a resolved exploit is never scored as a clean record, and the cap decays only with age — not with how severe the incident was. An active incident keeps its own critical path.",
    },
  },
  {
    id: "custody",
    cells: {
      signal: "Key custody",
      effect: "Penalty and waiver",
      meaning:
        "A bare externally-owned mint key is a single-point custody failure the cap and claim semantics cannot see. Reviewed MPC or HSM custody reclassifies it as an issuer-operated backend and waives the penalty.",
    },
  },
  {
    id: "quorum",
    cells: {
      signal: "Multisig quorum",
      effect: "Bounded penalty",
      meaning:
        "Threshold, signer set, timelock, and Safe module surface grade quorum quality. A one-of-N Safe is penalized far harder than a three-of-five; relief for a majority threshold or a timelock can cancel the penalty but never lifts the component above its posture rung.",
    },
  },
  {
    id: "modules",
    cells: {
      signal: "Modules and guards",
      effect: "Small penalty",
      meaning:
        "A reviewed Safe module or guard on the binding mint control is an extra path around the quorum and takes a small penalty. Unknown and not-applicable module surfaces are inert.",
    },
  },
] as const;

const BAND_COLUMNS = [
  { id: "band", header: "Band", rowHeader: true },
  { id: "posture", header: "Derived posture" },
  { id: "meaning", header: "Meaning", cellClassName: "whitespace-normal" },
] as const;

const BAND_ROWS = [
  {
    id: "hardened",
    cells: {
      band: V9_MINT_POSTURE_BANDS.hardened.label,
      posture: "No live authority, or bounded admin",
      meaning: V9_MINT_POSTURE_BANDS.hardened.detail,
    },
  },
  {
    id: "governed",
    cells: {
      band: V9_MINT_POSTURE_BANDS.governed.label,
      posture: "Partially bounded admin",
      meaning: V9_MINT_POSTURE_BANDS.governed.detail,
    },
  },
  {
    id: "managed",
    cells: {
      band: V9_MINT_POSTURE_BANDS.managed.label,
      posture: "Unbounded but reconciled",
      meaning: V9_MINT_POSTURE_BANDS.managed.detail,
    },
  },
  {
    id: "concentrated",
    cells: {
      band: V9_MINT_POSTURE_BANDS.concentrated.label,
      posture: "Concentrated admin",
      meaning: V9_MINT_POSTURE_BANDS.concentrated.detail,
    },
  },
  {
    id: "exposed",
    cells: {
      band: V9_MINT_POSTURE_BANDS.exposed.label,
      posture: "Unbounded or compromised",
      meaning: V9_MINT_POSTURE_BANDS.exposed.detail,
    },
  },
  {
    id: "nr",
    cells: {
      band: "NR",
      posture: "Unknown",
      meaning: "Missing, unknown, inherited-but-unresolved, or insufficient review data.",
    },
  },
] as const;

export function MintAuthorityScoreMethodologySection() {
  return (
    <MethodologySectionShell
      id={MINT_AUTHORITY_SCORE_SECTION_CONTENT.id}
      title={MINT_AUTHORITY_SCORE_SECTION_CONTENT.title}
      versionBadge={{ label: MINT_AUTHORITY_METHODOLOGY_VERSION_LABEL }}
      versionNote="This lane is closed. Mint risk is versioned in the Safety Score changelog from v9.1 onward; the badge marks the terminal Mint Authority release."
    >
      <p>
        Mint authority measures how much durable stablecoin supply can be created, authorized, expanded, or routed by
        privileged actors — issuer minters, allowlisted minters, cap admins, proxy admins, facilitators, bridges,
        off-chain attestation systems, backend signers, governance, Safes and multisigs, custodians, and wrapper
        inheritance.
      </p>
      <p>
        Pharos scored this twice until methodology v9.1: once as a standalone Mint Authority Score and once inside the
        Safety Score. The two engines disagreed — most sharply on incidents, where the standalone score remembered a
        resolved exploit for years and the Safety Score forgot it the moment it was resolved. Since v9.1 there is one
        grader. Mint risk is the Safety Score&apos;s Economic Control pillar mint component, and every mint score on the
        site is that component.
      </p>
      <MethodologyFacts
        facts={[
          { label: "Score range", value: "0-100, with NR for missing or unresolved review data" },
          { label: "Main risk", value: "Privileged durable supply creation or mint-route expansion" },
          { label: "Where it lives", value: "Safety Score V9 Economic Control pillar, mint component" },
        ]}
      />
      <ContentTable
        tableId="methodology-mint-authority-components"
        testId="methodology-mint-authority-components-table"
        columns={SIGNAL_COLUMNS}
        rows={SIGNAL_ROWS}
      />
      <WorkedExample summary="Worked example: a resolved mint incident on a reconciled issuer">
        <p>
          An issuer whose minting is economically unbounded but reconciled against reserves under attestation sits on
          the reconciled rung. A privileged-mint incident from eighteen months ago is resolved, so it raises no active
          incident signal — but the resolved-incident cap holds the component down to the concentrated-admin rung, the
          same class V9 gives a mint whose issuance authority is neither bounded nor independently constrained, which
          is what an unbacked mint demonstrated. The cap relaxes to the partially-bounded rung on the incident&apos;s
          second anniversary and to the bounded-admin rung on its fourth, at which point it is above the issuer&apos;s
          own clean posture and the penalty has expired.
        </p>
        <p>
          Under the retired standalone engine the same asset carried a permanent cap in the teens. Under the merged
          grader the penalty is proportionate to the pillar it feeds, and it is the same number the letter grade uses.
        </p>
      </WorkedExample>
      <MethodologyDetails summary="Technical details: composition, annotation, and bands">
        <div className="space-y-2">
          <h3 className="text-foreground font-medium">Composition</h3>
          <p>
            The mint component is one of three in the Economic Control pillar, alongside oracle and bridge topology.
            The pillar takes the lowest binding component, so a weak mint path is not averaged away by a strong oracle.
          </p>
        </div>
        <div className="space-y-2">
          <h3 className="text-foreground font-medium">What is deliberately not counted</h3>
          <p>
            The retired engine priced the mint route family (issuer-direct, permissioned minter, bridge synthetic, and
            so on) as its own weighted component. That is not carried over: the cap and claim semantics already price
            the same risk, and counting it twice would double-penalize the same fact.
          </p>
        </div>
        <div className="space-y-2">
          <h3 className="text-foreground font-medium">Curated posture is an annotation</h3>
          <p>
            The curated authority-posture field shown on detail pages is a reviewer annotation. It is validated against
            the derived posture and never affects the Safety Score; a disagreement raises curation work rather than
            moving a score. It is not inert everywhere: the depeg resolver reads it as a curated structural input, so
            re-curating a posture can change a published depeg verdict.
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
