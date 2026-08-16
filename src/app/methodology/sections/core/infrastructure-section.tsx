import Link from "next/link";
import {
  METHODOLOGY_LINK_CLASS,
  MethodologyFacts,
  MethodologySectionShell,
} from "../../methodology-shared";
import { INFRASTRUCTURE_SECTION_CONTENT } from "@/lib/methodology-content";
export function InfrastructureMethodologySection() {
  return (
    <MethodologySectionShell
      id={INFRASTRUCTURE_SECTION_CONTENT.id}
      title={INFRASTRUCTURE_SECTION_CONTENT.title}
    >
      <p>
        Infrastructure identifies the shared technical foundation a stablecoin was built on.
        Pharos currently recognises three values: <span className="text-foreground">Liquity v1</span>,{" "}
        <span className="text-foreground">Liquity v2</span>, and{" "}
        <span className="text-foreground">M0</span>. The tag answers the question:{" "}
        <em>what shared technology does this coin inherit risk from?</em>
      </p>
      <p>
        <span className="text-foreground">Liquity v1</span> and{" "}
        <span className="text-foreground">Liquity v2</span> are <em>code lineages</em> &mdash; coins that fork
        the original Liquity{" "}
        <Link
          href="/learn/mechanisms/cdp/"
          className={METHODOLOGY_LINK_CLASS}
        >
          CDP
        </Link>
        {" "}implementation (v1) or its newer BOLD-style design (v2). Forks share source
        code but operate independently with their own reserves, governance, and Stability Pools. A vulnerability
        in the upstream Liquity codebase potentially affects every fork in that branch, even though the forks
        have no operational relationship.
      </p>
      <p>
        <span className="text-foreground">M0</span> is an <em>issuance-platform lineage</em> &mdash; coins built on
        M0&apos;s smart-contract rails (minter governance, the SwapFacility, and the{" "}
        <code className="text-xs bg-muted px-1 py-0.5 rounded">MExtension.sol</code> contract pattern). M0 provides the
        issuance machinery; the reserve composition is set by the issuer and{" "}
        <span className="text-foreground">may or may not include the underlying $M token</span>. Some M0-built coins
        are simple $M wrappers; others manage diversified collateral via M0&apos;s infrastructure. A governance
        issue at the M0 protocol level potentially affects every M0-built coin, even though their day-to-day
        operations and reserves are independent.
      </p>
      <MethodologyFacts
        facts={[
          { label: "Storage", value: "Array field on each StablecoinMeta entry" },
          { label: "Cardinality", value: "Zero, one, or many infrastructures per coin" },
          { label: "Surfaces", value: "Detail badge, homepage filter, taxonomy pages, methodology" },
        ]}
      />
    </MethodologySectionShell>
  );
}
