import type { CircuitRecord } from "@shared/types";
import { Badge } from "@/components/ui/badge";
import { formatTimestampSeconds } from "@/lib/status-dashboard-model";

interface CircuitBreakerTableProps {
  circuits: Record<string, CircuitRecord> | undefined;
}

export function CircuitBreakerTable({ circuits }: CircuitBreakerTableProps) {
  if (!circuits || Object.keys(circuits).length === 0) {
    return (
      <article className="rounded-[1.35rem] border border-black/7 bg-[linear-gradient(180deg,oklch(0.995_0.004_248_/_0.96),oklch(0.972_0.01_248_/_0.99))] p-5 shadow-[inset_0_1px_0_oklch(1_0_0_/0.72),0_16px_36px_oklch(0_0_0_/0.08)] dark:border-white/10 dark:bg-[linear-gradient(180deg,oklch(0.16_0.014_248_/_0.78),oklch(0.12_0.01_248_/_0.9))] dark:shadow-[0_16px_36px_oklch(0_0_0_/0.12)]">
        <h3 className="text-base font-semibold tracking-tight text-foreground">Circuit Breakers</h3>
        <p className="mt-3 text-sm text-muted-foreground">No circuit breakers registered</p>
      </article>
    );
  }

  const entries = Object.entries(circuits);
  const tripped = entries.filter(([, c]) => c.state !== "closed");
  const healthy = entries.filter(([, c]) => c.state === "closed");

  const renderRow = ([name, circuit]: [string, CircuitRecord]) => (
    <tr key={name} className="border-b last:border-0">
      <td className="py-2 font-mono text-xs">{name}</td>
      <td className="py-2">
        {circuit.state === "closed" && (
          <Badge className="bg-green-500/15 text-xs text-green-700 dark:text-green-400">closed</Badge>
        )}
        {circuit.state === "half-open" && (
          <Badge className="bg-amber-500/15 text-xs text-amber-700 dark:text-amber-400">half-open</Badge>
        )}
        {circuit.state === "open" && (
          <Badge className="bg-red-500/15 text-xs text-red-700 dark:text-red-400">open</Badge>
        )}
      </td>
      <td className="py-2 font-mono tabular-nums">{circuit.consecutiveFailures}</td>
      <td className="py-2 font-mono text-xs text-muted-foreground">
        {formatTimestampSeconds(circuit.lastFailureAt)}
      </td>
      <td className="py-2 font-mono text-xs text-muted-foreground">
        {formatTimestampSeconds(circuit.lastSuccessAt)}
      </td>
    </tr>
  );

  const tableHead = (
    <thead>
      <tr className="border-b text-left text-muted-foreground">
        <th scope="col" className="pb-2 font-medium">Name</th>
        <th scope="col" className="pb-2 font-medium">State</th>
        <th scope="col" className="pb-2 font-medium">Failures</th>
        <th scope="col" className="pb-2 font-medium">Last Failure</th>
        <th scope="col" className="pb-2 font-medium">Last Success</th>
      </tr>
    </thead>
  );

  return (
    <article className="rounded-[1.35rem] border border-black/7 bg-[linear-gradient(180deg,oklch(0.995_0.004_248_/_0.96),oklch(0.972_0.01_248_/_0.99))] p-5 shadow-[inset_0_1px_0_oklch(1_0_0_/0.72),0_16px_36px_oklch(0_0_0_/0.08)] dark:border-white/10 dark:bg-[linear-gradient(180deg,oklch(0.16_0.014_248_/_0.78),oklch(0.12_0.01_248_/_0.9))] dark:shadow-[0_16px_36px_oklch(0_0_0_/0.12)]">
      <h3 className="text-base font-semibold tracking-tight text-foreground">Circuit Breakers</h3>
      <div className="mt-4 overflow-x-auto">
        {tripped.length > 0 && (
          <table className="w-full text-sm">
            {tableHead}
            <tbody>{tripped.map(renderRow)}</tbody>
          </table>
        )}
        {healthy.length > 0 && (
          <details className={tripped.length > 0 ? "mt-4" : undefined}>
            <summary className="cursor-pointer text-sm text-muted-foreground">
              {healthy.length} healthy breaker{healthy.length !== 1 ? "s" : ""}
            </summary>
            <table className="mt-2 w-full text-sm">
              {tripped.length === 0 && tableHead}
              <tbody>{healthy.map(renderRow)}</tbody>
            </table>
          </details>
        )}
      </div>
    </article>
  );
}
