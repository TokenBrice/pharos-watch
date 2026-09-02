import type { CircuitRecord } from "@shared/types";
import { TableCell, TableRow } from "@/components/table";
import { Badge } from "@/components/ui/badge";
import { formatStatusTimestamp } from "@/lib/status/dashboard-presentation";
import { PublicSignalCard } from "./public-signal-card";
import { PrioritySplitTable } from "./priority-split-table";
import { defineStatusColumns } from "./page-primitives";

interface CircuitBreakerTableProps {
  circuits: Record<string, CircuitRecord> | undefined;
}

const CIRCUIT_BREAKER_COLUMNS = defineStatusColumns([
  ["name", "Name"],
  ["state", "State"],
  ["failures", "Failures"],
  ["last-failure", "Last Failure"],
  ["last-success", "Last Success"],
]);

export function CircuitBreakerTable({ circuits }: CircuitBreakerTableProps) {
  if (!circuits || Object.keys(circuits).length === 0) {
    return (
      <PublicSignalCard title="Circuit Breakers" contentClassName="mt-3">
        <p className="text-sm text-muted-foreground">No circuit breakers registered</p>
      </PublicSignalCard>
    );
  }

  const entries = Object.entries(circuits);
  const tripped = entries.filter(([, c]) => c.state !== "closed");
  const healthy = entries.filter(([, c]) => c.state === "closed");

  const renderRow = ([name, circuit]: [string, CircuitRecord]) => (
    <TableRow key={name} className="border-b last:border-0">
      <TableCell className="py-2 font-mono text-xs">{name}</TableCell>
      <TableCell className="py-2">
        {circuit.state === "closed" && (
          <Badge className="bg-emerald-500/15 text-xs text-emerald-700 dark:text-emerald-400">closed</Badge>
        )}
        {circuit.state === "half-open" && (
          <Badge className="bg-amber-500/15 text-xs text-amber-700 dark:text-amber-400">half-open</Badge>
        )}
        {circuit.state === "open" && (
          <Badge className="bg-red-500/15 text-xs text-red-700 dark:text-red-400">open</Badge>
        )}
      </TableCell>
      <TableCell className="py-2 pharos-numeric">{circuit.consecutiveFailures}</TableCell>
      <TableCell className="py-2 font-mono text-xs text-muted-foreground">
        {formatStatusTimestamp(circuit.lastFailureAt, { fallback: "—", timeZoneName: "short" })}
      </TableCell>
      <TableCell className="py-2 font-mono text-xs text-muted-foreground">
        {formatStatusTimestamp(circuit.lastSuccessAt, { fallback: "—", timeZoneName: "short" })}
      </TableCell>
    </TableRow>
  );

  return (
    <PublicSignalCard title="Circuit Breakers" contentClassName="mt-0">
      <p className="text-sm text-muted-foreground leading-relaxed mb-4">
        Circuit breakers protect data quality by temporarily disabling a data source after repeated failures.{" "}
        <strong className="text-foreground">Closed</strong> means the source is healthy.{" "}
        <strong className="text-foreground">Half-open</strong> means Pharos is cautiously retesting after a failure
        period. <strong className="text-foreground">Open</strong> means the source is disabled — affected features will
        show cached data until the source recovers.
      </p>
      <div className="mt-4">
        <PrioritySplitTable
          primaryRows={tripped}
          secondaryRows={healthy}
          columns={CIRCUIT_BREAKER_COLUMNS}
          idPrefix="circuit-breakers"
          primaryAriaLabel="Tripped circuit breakers"
          secondaryAriaLabel="Healthy circuit breakers"
          secondaryNoun="breaker"
          renderRow={renderRow}
          primaryTableId="circuit-breakers-tripped"
          secondaryTableId="circuit-breakers-healthy"
          headerRowClassName="border-b text-left text-muted-foreground"
        />
      </div>
    </PublicSignalCard>
  );
}
