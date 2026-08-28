import type { CircuitRecord } from "@shared/types";
import { DataTableShell, type DataTableColumn } from "@/components/data-table-shell";
import { TableCell, TableRow } from "@/components/table";
import { Badge } from "@/components/ui/badge";
import { formatTimestampSeconds } from "@/lib/status-dashboard-model";
import { LazyDetails } from "./lazy-details";
import { PublicSignalCard } from "./public-signal-card";

interface CircuitBreakerTableProps {
  circuits: Record<string, CircuitRecord> | undefined;
}

const CIRCUIT_BREAKER_COLUMNS: readonly DataTableColumn[] = [
  { id: "name", label: "Name", className: "pb-2 font-medium" },
  { id: "state", label: "State", className: "pb-2 font-medium" },
  { id: "failures", label: "Failures", className: "pb-2 font-medium" },
  { id: "last-failure", label: "Last Failure", className: "pb-2 font-medium" },
  { id: "last-success", label: "Last Success", className: "pb-2 font-medium" },
];

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
        {formatTimestampSeconds(circuit.lastFailureAt)}
      </TableCell>
      <TableCell className="py-2 font-mono text-xs text-muted-foreground">
        {formatTimestampSeconds(circuit.lastSuccessAt)}
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
        {tripped.length > 0 && (
          <DataTableShell
            tableId="circuit-breakers-tripped"
            testId="circuit-breakers-tripped-table"
            columns={CIRCUIT_BREAKER_COLUMNS}
            chrome="content"
            density="compact"
            tableProps={{ "aria-label": "Tripped circuit breakers" }}
            headerClassName=""
            headerRowClassName="border-b text-left text-muted-foreground"
          >
            {tripped.map(renderRow)}
          </DataTableShell>
        )}
        {healthy.length > 0 && (
          <LazyDetails
            className={tripped.length > 0 ? "mt-4" : undefined}
            summary={
              <summary className="pharos-focus-ring flex min-h-11 cursor-pointer items-center rounded-md text-sm text-muted-foreground">
                {healthy.length} healthy breaker{healthy.length !== 1 ? "s" : ""}
              </summary>
            }
          >
            <DataTableShell
              tableId="circuit-breakers-healthy"
              testId="circuit-breakers-healthy-table"
              columns={CIRCUIT_BREAKER_COLUMNS}
              chrome="content"
              containerClassName="mt-2"
              density="compact"
              tableProps={{ "aria-label": "Healthy circuit breakers" }}
              headerClassName=""
              headerRowClassName="border-b text-left text-muted-foreground"
            >
              {healthy.map(renderRow)}
            </DataTableShell>
          </LazyDetails>
        )}
      </div>
    </PublicSignalCard>
  );
}
