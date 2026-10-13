import type { CircuitRecord } from "@shared/types";
import { TableCell, TableRow } from "@/components/table";
import { Badge } from "@/components/ui/badge";
import { PublicSignalCard } from "./public-signal-card";
import { PrioritySplitTable } from "./priority-split-table";
import { defineStatusColumns, Timestamp } from "./page-primitives";

interface CircuitBreakerTableProps {
  circuits: Record<string, CircuitRecord> | null | undefined;
  unavailableReason?: string | null;
}

const CIRCUIT_BREAKER_COLUMNS = defineStatusColumns([
  ["name", "Name"], ["state", "State"], ["failures", "Failures"],
  ["last-failure", "Last failure"], ["last-success", "Last success"],
]);

export function CircuitBreakerTable({ circuits, unavailableReason }: CircuitBreakerTableProps) {
  if (!circuits || Object.keys(circuits).length === 0) {
    return (
      <PublicSignalCard title="Circuit breakers" contentClassName="mt-3">
        <p className="text-sm text-muted-foreground">{circuits == null
          ? `Circuit breaker evidence unavailable${unavailableReason ? ` (${unavailableReason})` : ""}.`
          : "No circuit breakers registered"}</p>
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
          <Badge className="bg-state-positive-solid/15 text-xs text-state-positive">Closed</Badge>
        )}
        {circuit.state === "half-open" && (
          <Badge className="bg-state-warn-solid/15 text-xs text-state-warn">Half-open</Badge>
        )}
        {circuit.state === "open" && (
          <Badge className="bg-state-danger-solid/15 text-xs text-state-danger">Open</Badge>
        )}
      </TableCell>
      <TableCell className="py-2 pharos-numeric">{circuit.consecutiveFailures}</TableCell>
      <TableCell className="py-2 text-xs text-muted-foreground">
        <Timestamp epochSec={circuit.lastFailureAt} />
      </TableCell>
      <TableCell className="py-2 text-xs text-muted-foreground">
        <Timestamp epochSec={circuit.lastSuccessAt} />
      </TableCell>
    </TableRow>
  );

  return (
    <PublicSignalCard title="Circuit breakers" contentClassName="mt-0">
      <p className="text-sm text-muted-foreground leading-relaxed mb-4">
        A circuit breaker pauses an upstream data source after repeated failures.{" "}
        <strong className="text-foreground">Closed</strong> means the source is in use.{" "}
        <strong className="text-foreground">Half-open</strong> means the source is being retested after a failure
        period. <strong className="text-foreground">Open</strong> means the source is paused, and affected features
        show their last good data until it recovers.
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
