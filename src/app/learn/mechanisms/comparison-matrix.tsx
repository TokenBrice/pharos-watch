import Link from "next/link";
import type { MechanismArchetype } from "@shared/types";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";
import { getMechanismArchetypeLabel, getMechanismExplainerPath } from "@shared/lib/classification";
import { cn } from "@/lib/utils";
import {
  TableBody,
  TableCaption,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/table";

type MatrixCol =
  | "collateralLocation"
  | "redemptionRight"
  | "yieldSource"
  | "primaryFailureMode"
  | "governanceDep"
  | "oracleDep"
  | "jurisdictionDep";

const COLUMNS: ReadonlyArray<{ key: MatrixCol; label: string; short: string }> = [
  { key: "collateralLocation", label: "Collateral location", short: "Collateral" },
  { key: "redemptionRight", label: "Redemption right", short: "Redemption" },
  { key: "yieldSource", label: "Yield source", short: "Yield" },
  { key: "primaryFailureMode", label: "Primary failure mode", short: "Fails by" },
  { key: "governanceDep", label: "Governance dep.", short: "Governance" },
  { key: "oracleDep", label: "Oracle dep.", short: "Oracle" },
  { key: "jurisdictionDep", label: "Jurisdiction dep.", short: "Jurisdiction" },
];

const DEPENDENCY_COLUMNS: ReadonlySet<MatrixCol> = new Set([
  "governanceDep",
  "oracleDep",
  "jurisdictionDep",
]);

const DEPENDENCY_DOT: Record<string, string> = {
  Low: "bg-[var(--severity-healthy)]",
  Medium: "bg-[var(--severity-moderate)]",
  High: "bg-[var(--severity-severe)]",
};

function DependencyCell({ value }: { value: string }) {
  const dot = DEPENDENCY_DOT[value];
  if (!dot) {
    return <span className="text-muted-foreground/70">{value}</span>;
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className={cn("h-1.5 w-1.5 rounded-full", dot)}
      />
      <span className="text-foreground/80">{value}</span>
    </span>
  );
}

const MATRIX: Record<MechanismArchetype, Record<MatrixCol, string>> = {
  "fiat-cash": {
    collateralLocation: "Off-chain",
    redemptionRight: "1:1",
    yieldSource: "—",
    primaryFailureMode: "Banking-rail freeze",
    governanceDep: "Low",
    oracleDep: "—",
    jurisdictionDep: "High",
  },
  tbill: {
    collateralLocation: "Off-chain",
    redemptionRight: "NAV",
    yieldSource: "Treasury yield",
    primaryFailureMode: "Redemption gate",
    governanceDep: "Low",
    oracleDep: "—",
    jurisdictionDep: "High",
  },
  cdp: {
    collateralLocation: "On-chain crypto",
    redemptionRight: "Vault",
    yieldSource: "Liquidations + fees",
    primaryFailureMode: "Liquidation cascade",
    governanceDep: "Medium",
    oracleDep: "High",
    jurisdictionDep: "Low",
  },
  "synthetic-delta-neutral": {
    collateralLocation: "On-chain crypto",
    redemptionRight: "Hedge unwind",
    yieldSource: "Funding rate",
    primaryFailureMode: "Funding inversion",
    governanceDep: "Medium",
    oracleDep: "Low",
    jurisdictionDep: "Medium",
  },
  algorithmic: {
    collateralLocation: "None",
    redemptionRight: "Burn",
    yieldSource: "—",
    primaryFailureMode: "Reflexive collapse",
    governanceDep: "High",
    oracleDep: "Medium",
    jurisdictionDep: "Low",
  },
  "rwa-credit-fund": {
    collateralLocation: "Off-chain",
    redemptionRight: "Fund gate",
    yieldSource: "Credit yield",
    primaryFailureMode: "NAV markdown",
    governanceDep: "Low",
    oracleDep: "—",
    jurisdictionDep: "High",
  },
  "commodity-claim": {
    collateralLocation: "Vaulted metal",
    redemptionRight: "Physical delivery",
    yieldSource: "—",
    primaryFailureMode: "Vault or title failure",
    governanceDep: "Low",
    oracleDep: "—",
    jurisdictionDep: "High",
  },
};

export function MechanismComparisonMatrix() {
  return (
    <section aria-labelledby="mechanism-matrix-heading" className="space-y-3">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="mechanism-matrix-heading" className="pharos-kicker">
          At a glance
        </h2>
        <span className="pharos-numeric text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
          {MECHANISM_ARCHETYPE_VALUES.length} mechanisms
        </span>
      </div>
      <TableFrame
        tableId="mechanism-comparison-matrix"
        testId="mechanism-comparison-matrix-table"
        chrome="content"
        density="compact"
        className="rounded-lg bg-card/20"
        tableClassName="w-full table-fixed border-collapse text-left text-xs"
        tableProps={{ "aria-label": "Stablecoin mechanism comparison matrix" }}
        viewportProps={{ compactBottomPadding: false, mobileScrollHint: false }}
      >
        <TableCaption className="sr-only">Stablecoin mechanism comparison matrix</TableCaption>
        <colgroup>
          <col className="w-[22%]" />
          <col className="w-[12%]" />
          <col className="w-[11%]" />
          <col className="w-[12%]" />
          <col className="w-[15%]" />
          <col className="w-[10%]" />
          <col className="w-[9%]" />
          <col className="w-[9%]" />
        </colgroup>
        <TableHeader>
          <TableRow className="border-b border-border/60 bg-muted/30 hover:bg-transparent">
            <TableHead
              scope="col"
              className="h-auto whitespace-normal px-3 py-2.5 align-bottom font-semibold text-foreground"
            >
              Mechanism
            </TableHead>
            {COLUMNS.map((col) => (
              <TableHead
                key={col.key}
                scope="col"
                className="h-auto whitespace-normal px-3 py-2.5 align-bottom font-semibold text-muted-foreground"
              >
                <span className="sr-only">{col.label}</span>
                <span aria-hidden="true" className="hidden md:inline">{col.label}</span>
                <span aria-hidden="true" className="md:hidden">{col.short}</span>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {MECHANISM_ARCHETYPE_VALUES.map((archetype, i) => {
            const row = MATRIX[archetype];
            return (
              <TableRow
                key={archetype}
                className={cn(
                  "border-b border-border/40 last:border-b-0 hover:bg-transparent",
                  i % 2 === 1 ? "bg-muted/10" : null,
                )}
              >
                <TableHead
                  scope="row"
                  className={cn(
                    "sticky left-0 z-[1] h-auto whitespace-normal px-3 py-2.5 align-top text-left font-medium text-foreground",
                    i % 2 === 1 ? "bg-muted/10" : "bg-background",
                  )}
                >
                  <Link
                    href={getMechanismExplainerPath(archetype)}
                    className="pharos-focus-ring rounded-sm underline-offset-4 hover:text-frost-blue hover:underline"
                  >
                    {getMechanismArchetypeLabel(archetype)}
                  </Link>
                </TableHead>
                {COLUMNS.map((col) => (
                  <TableCell
                    key={col.key}
                    className="whitespace-normal px-3 py-2.5 align-top text-muted-foreground"
                  >
                    {DEPENDENCY_COLUMNS.has(col.key) ? (
                      <DependencyCell value={row[col.key]} />
                    ) : (
                      row[col.key]
                    )}
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
        </TableBody>
      </TableFrame>
    </section>
  );
}
