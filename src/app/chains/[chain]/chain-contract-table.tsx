import Link from "next/link";
import { ContentTable } from "@/components/table";
import type { ContentTableColumn, ContentTableRow } from "@/components/table/content-table";
import { buildExplorerUrl } from "@shared/lib/explorer";
import { rankChainDeployments, type ChainTrackedDeployment } from "../static-chain-content";

/** Presentational bound: the complete profile directory below remains the continuation. */
const CHAIN_CONTRACT_TABLE_ROW_LIMIT = 20;

const COLUMNS: ContentTableColumn[] = [
  { id: "stablecoin", header: "Stablecoin", rowHeader: true, cellClassName: "whitespace-normal" },
  {
    id: "address",
    header: "Contract address",
    cellClassName: "whitespace-normal break-all font-mono text-xs text-muted-foreground",
  },
  { id: "decimals", header: "Decimals" },
  { id: "explorer", header: "Explorer" },
];

/**
 * Registry-order candidates: base coins first, NAV tokens and variants after,
 * matching the title ranking. Never presented as a market-cap or popularity
 * order, and never a claim that a recorded address is currently supported.
 */
function buildChainContractRows(deployments: readonly ChainTrackedDeployment[]) {
  return rankChainDeployments(deployments).flatMap((deployment) =>
    deployment.contracts.map((contract) => ({ deployment, contract })),
  );
}

/**
 * Bounded, server-rendered contract lookup for the three pilot chain hubs.
 * Each row links to the `#contracts` module on the coin profile, whose closed
 * `Contract addresses` fold lists the recorded address with the full profile
 * context; the complete coin directory below keeps every profile (and
 * therefore every overflow deployment) reachable.
 */
export function ChainContractTable({
  chainName,
  deployments,
}: {
  chainName: string;
  deployments: readonly ChainTrackedDeployment[];
}) {
  const candidates = buildChainContractRows(deployments);
  if (candidates.length === 0) {
    return null;
  }

  const shown = candidates.slice(0, CHAIN_CONTRACT_TABLE_ROW_LIMIT);
  const rows: ContentTableRow[] = shown.map(({ deployment, contract }) => {
    const explorerUrl = buildExplorerUrl({
      chainKey: contract.chain,
      deploymentKind: contract.kind,
      entityType: "contract",
      value: contract.address,
    });

    return {
      // Row identity only: React keys never reach the DOM.
      id: `${contract.chain}:${contract.address}`,
      cells: {
        stablecoin: (
          <Link
            href={`${deployment.href}#contracts`}
            className="pharos-focus-ring rounded-sm font-medium text-foreground hover:underline"
          >
            {deployment.name} ({deployment.symbol})
          </Link>
        ),
        address: contract.address,
        decimals: contract.decimals ?? "—",
        explorer: explorerUrl ? (
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`View on ${chainName} explorer`}
            className="pharos-focus-ring rounded-sm text-frost-blue hover:underline"
          >
            Explorer
          </a>
        ) : (
          "—"
        ),
      },
    };
  });

  return (
    <section
      id="chain-contract-addresses"
      aria-labelledby="chain-contract-addresses-heading"
      className="space-y-3"
    >
      <h2 id="chain-contract-addresses-heading" className="pharos-label">
        Recorded contract addresses on {chainName}
      </h2>
      <p className="text-sm text-muted-foreground">
        Showing {shown.length} of {candidates.length} recorded deployments
      </p>
      <ContentTable
        tableId="chain-contract-addresses"
        tableAriaLabel={`Recorded contract addresses on ${chainName}`}
        columns={COLUMNS}
        rows={rows}
      />
    </section>
  );
}
