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
        "Cap semantics, claim impairment, reconciliation cadence, supervisory regime, and qualified governance place the mint on a posture rung. The ladder distinguishes collateral-gated issuance, minority-veto and governance-delayed unbounded issuance, unbounded minting with unknown reconciliation, and a confirmed absence of reconciliation.",
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
    id: "seasoning",
    cells: {
      signal: "Seasoned track record",
      effect: "Bounded credit",
      meaning:
        "After 60 months, eligible postures earn 10 points without crossing the next rung. Minority-veto issuance starts at 70 and clips at 79 below prudential reconciliation at 80, just like partially bounded administration. Governance-delayed issuance starts at 60 and clips at 69. Unbounded minting with unknown reconciliation has a 55-point base; seasoned and positive merged-signal credits from a 55-point base stop at 59. Unbounded, unreconciled issuance has a dedicated ceiling of 39. An active incident is ineligible.",
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
      posture: "No live authority (100), or bounded admin (85)",
      meaning: V9_MINT_POSTURE_BANDS.hardened.detail,
    },
  },
  {
    id: "governed",
    cells: {
      band: V9_MINT_POSTURE_BANDS.governed.label,
      posture: "Partially bounded admin or unbounded, veto-guarded (70), or unbounded, governance-delayed (60)",
      meaning: V9_MINT_POSTURE_BANDS.governed.detail,
    },
  },
  {
    id: "managed",
    cells: {
      band: V9_MINT_POSTURE_BANDS.managed.label,
      posture: "Prudential-reconciled (80), attestation-reconciled (70), or unbounded-reconciled base (55)",
      meaning: V9_MINT_POSTURE_BANDS.managed.detail,
    },
  },
  {
    id: "concentrated",
    cells: {
      band: V9_MINT_POSTURE_BANDS.concentrated.label,
      posture: "Collateral-gated (50), or concentrated admin (55)",
      meaning: V9_MINT_POSTURE_BANDS.concentrated.detail,
    },
  },
  {
    id: "exposed",
    cells: {
      band: V9_MINT_POSTURE_BANDS.exposed.label,
      posture: "Unknown reconciliation (55), or unbounded, unreconciled / compromised (25)",
      meaning: V9_MINT_POSTURE_BANDS.exposed.detail,
    },
  },
  {
    id: "nr",
    cells: {
      band: "NR",
      posture: "Unknown control facts (quality 45-50)",
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
        Mint authority measures how much durable stablecoin supply can be created, authorized, or expanded on the
        deployment or deployments that issue the canonical claim. It follows native minters, cap and proxy admins,
        off-chain attestation systems, backend signers, governance, Safes and multisigs, custodians, and wrapper
        inheritance that can change that native issuance.
      </p>
      <p>
        Pharos scored this twice until methodology v9.1: once as a standalone Mint Authority Score and once inside the
        Safety Score. The two engines disagreed — most sharply on incidents, where the standalone score remembered a
        resolved exploit for years and the Safety Score forgot it the moment it was resolved. Since v9.1 there is one
        grader. Mint risk is the Safety Score&apos;s Economic Control pillar mint component, and every mint score on the
        site is that component.
      </p>
      <p>
        Bridge Risk is evaluated at a different scope. A destination token, adapter, lockbox, message path, route
        limit, bridge upgrade, or bridge administrator can harm the representation it governs without changing the
        canonical issuer&apos;s native mint authority. Pharos therefore scores those controls on their individual bridge
        routes. The same controller can appear in both assessments when it holds different powers, but a bridge power
        is never treated as global native-mint risk.
      </p>
      <MethodologyFacts
        facts={[
          { label: "Score range", value: "0-100, with NR for missing or unresolved review data" },
          { label: "Main risk", value: "Privileged durable supply creation or mint-route expansion" },
          { label: "Where it lives", value: "Safety Score V10 Economic Control pillar, mint component" },
        ]}
      />
      <ContentTable
        tableId="methodology-mint-authority-components"
        testId="methodology-mint-authority-components-table"
        columns={SIGNAL_COLUMNS}
        rows={SIGNAL_ROWS}
      />
      <p>
        The governed rung covers economically unbounded issuance held only by delayed, flash-resistant on-chain token
        governance. Every mint control must have a complete execution-scope certificate proving that all unbounded
        issuance paths are governance-controlled and enforce an unavoidable delay of at least 48 hours. Qualifying
        issuance starts at 60 and publishes in the Governed band.
      </p>
      <p>
        Safety Score v10.03 adds minority-veto due process (D30): when any holder or delegation group of at most 2%
        of flash-resistant votes can block a new issuer during an unavoidable public window of at least 14 days,
        admission is protected against majority capture. Qualifying issuance derives &quot;Unbounded, veto-guarded&quot;
        at 70 in the Governed band, above affirmative governance at 60. The economic power stays unbounded (D14);
        neither process changes DDR&apos;s fragile or unbounded membership.
      </p>
      <MethodologyDetails summary="Minority-veto issuance: gates V1–V7 (Safety Score v10.03)">
        <ul className="list-disc space-y-2 pl-5">
          <li>V1: complete runtime/signer-bound execution-scope certificates on every authored mint control,
            a fresh closed review, no scoped question, and no active incident.</li>
          <li>V2: an explicit minority-veto decision rule and a minimum, never summed, unavoidable public window
            of 1,209,600 seconds across every reachable unbounded issuance path.</li>
          <li>V3: a unilateral veto quorum at most 200 bps of total flash-resistant holding-period-weighted,
            lock-escrowed, or past-block-checkpoint votes; any override is none, symmetric vote destruction
            costing the caller an equal number of its own votes, or insolvency-gated restructure only while pinned
            equity is at least twice the threshold, retaining staleness headroom (D30-R).</li>
          <li>V4: every unbounded path is rooted in the veto governor by structured signer identity naming only
            authored contract execution hops, with no multisig, threshold, or signature phrasing. The governor
            itself carries no unbounded path. Only certified disabled-reactivatable restructure-dependent paths
            are excluded while restructure is unreachable.</li>
          <li>V5: each guarded issuance controller is targeted by a certified active parameter-change veto path
            containing every declared exact selector; a dormant veto cannot qualify.</li>
          <li>V6: issuance is enumerable through authorization events and capacity reads.</li>
          <li>V7: formula-bound interest (deposits × rate × time) is bounded-impairment monetary policy only with
            a hard-coded annual-ppm rate cap, an exact reviewed control/path inventory, and minority-replaceable
            rate changes delayed at least 172,800 seconds (D30-S). Any qualified holder at or below the veto quorum
            can replace/reset a pending change. Such paths reuse raiseable with null bound and bounded impairment,
            outside the fourteen-day window; uncertified interest or loss-coverage remains unbounded.</li>
        </ul>
        <p>
          Holding-period-weighted votes equal balance × holding duration: newly received or flash-borrowed shares
          carry zero votes. Unknown evidence fails closed. Graded prudential or attestation-only reconciliation
          still takes precedence; a failed minority-veto profile cannot fall back to affirmative governance.
          Qualifying veto-guarded issuance emits only a low centralized-mint signal (cap 83):
          &quot;Minting is economically unbounded but every new issuer faces a public minority-veto window.&quot;
        </p>
        <p>
          Restructure below the twice-threshold equity margin fails closed, and its selectors must bind to a
          reachable governor-certificate path. Every dependent path must be dormant and reachable only through
          restructure; ordinary redemption cannot reduce governance-share supply to zero. Equity is in whole
          asset-token units, veto quorum in bps of pinned votes, and rate caps in annual ppm. Plain equal-cost
          kamikaze remains symmetric vote destruction; cross-certificate reactivation causality remains an
          evidence-backed residual risk.
        </p>
        <p>
          The admission path carries the public veto window; already-admitted minters never inherit that delay.
          Their issuance paths carry their actual economic bound and exercise delay, often zero for an unbounded
          path, which fails the fourteen-day gate.
        </p>
      </MethodologyDetails>
      <WorkedExample summary="Worked example: a resolved mint incident on a reconciled issuer">
        <p>
          An issuer whose minting is economically unbounded but reconciled against reserves under attestation sits on
          the reconciled rung. A privileged-mint incident from eighteen months ago is resolved, so it raises no active
          incident signal — but the resolved-incident cap holds the component down to the concentrated-admin rung, the
          same class V10 gives a mint whose issuance authority is neither bounded nor independently constrained, which
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
            The mint component is one of three in the Economic Control pillar, alongside oracle and route-scoped
            bridge controls. The pillar takes the lowest binding component, so a weak native mint path is not averaged
            away by a strong oracle, while a material bridge control can bind through its own component.
          </p>
        </div>
        <div className="space-y-2">
          <h3 className="text-foreground font-medium">What is deliberately not counted</h3>
          <p>
            The retired engine priced the mint route family (issuer-direct, permissioned minter, bridge synthetic, and
            so on) as its own weighted component. That is not carried over: the cap and claim semantics already price
            native issuance, while bridge capabilities are compiled separately for the routes they govern. Treating a
            satellite bridge administrator as global mint authority would apply the wrong scope and could penalize the
            same capability twice.
          </p>
        </div>
        <div className="space-y-2">
          <h3 className="text-foreground font-medium">Curated posture is an annotation</h3>
          <p>
            The curated authority-posture field shown on detail pages is a reviewer annotation, not a scoring input.
            The Safety Score derives posture from compiled control facts, including the complete execution-scope
            certificates and governance evidence required for the governed rung; a disagreement raises curation work
            rather than moving a score. It is not inert everywhere: the depeg resolver reads it as a curated structural
            input, so re-curating a posture can change a published depeg verdict.
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
