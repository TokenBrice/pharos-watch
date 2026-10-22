import { ContentTable } from "@/components/table";
import { MINT_AUTHORITY_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/constants";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { MethodologyDetails, MethodologyFacts, MethodologySectionShell } from "../../methodology-shared";
import { MINT_AUTHORITY_SCORE_SECTION_CONTENT } from "@/lib/methodology-content";

export function MintAuthorityScoreMethodologySection() {
  const { markdownParagraphs } = MINT_AUTHORITY_SCORE_SECTION_CONTENT;
  const ladder = V9_CANDIDATE_POLICY_V1.policy.semantic.control.authorityLadder;

  return (
    <MethodologySectionShell
      id={MINT_AUTHORITY_SCORE_SECTION_CONTENT.id}
      title={MINT_AUTHORITY_SCORE_SECTION_CONTENT.title}
      versionBadge={{ label: MINT_AUTHORITY_METHODOLOGY_VERSION_LABEL }}
      versionNote="The standalone lane is closed. Current economic-authority rules are versioned in the Safety Score changelog; this badge marks the terminal Mint Authority release."
    >
      <p>{markdownParagraphs[0]}</p>
      <MethodologyFacts
        facts={[
          { label: "Where it lives", value: "Safety Score V10 Economic Control pillar" },
          { label: "Potential authority", value: "One weakest-effective-path ladder, including upgrades and allocators" },
          { label: "Component maximum", value: `${ladder.maxComponentQuality}, after bound and assurance credits` },
          { label: "Measured compromise", value: `${ladder.compromised}, without assurance credit` },
        ]}
      />
      <ContentTable
        tableId="methodology-mint-authority-components"
        testId="methodology-mint-authority-components-table"
        columns={[
          { id: "authority", header: "Effective authority", rowHeader: true },
          { id: "quality", header: "Base quality" },
        ]}
        rows={[
          { id: "single", cells: { authority: "Verified single signer / one-signature path", quality: ladder.singleSigner } },
          { id: "opaque", cells: { authority: "Opaque or incompletely resolved controller", quality: ladder.opaqueController } },
          { id: "quorum", cells: { authority: "Verified multisig / affirmative governance, no unavoidable delay", quality: ladder.quorum } },
          { id: "quorum-delay", cells: { authority: "Verified multisig with unavoidable timelock", quality: ladder.quorumTimelock } },
          { id: "governance-delay", cells: { authority: "Public governance / minority veto with unavoidable timelock", quality: ladder.governanceTimelock } },
          { id: "immutable", cells: { authority: "Reviewed immutable execution without discretionary economic power", quality: ladder.immutableNoPower } },
        ]}
      />
      <MethodologyDetails summary="Economic authority: evidence, bounds, assurance and incidents">
        {markdownParagraphs.slice(1).map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
      </MethodologyDetails>
    </MethodologySectionShell>
  );
}
