import type { CircuitRecord } from "@shared/types";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface CircuitBreakerTableProps {
  circuits: Record<string, CircuitRecord> | undefined;
}

export function CircuitBreakerTable({ circuits }: CircuitBreakerTableProps) {
  if (!circuits || Object.keys(circuits).length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Circuit Breakers</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No circuit breakers registered</p>
        </CardContent>
      </Card>
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
      <td className="py-2 text-muted-foreground">
        {circuit.lastFailureAt ? new Date(circuit.lastFailureAt * 1000).toLocaleString() : "—"}
      </td>
      <td className="py-2 text-muted-foreground">
        {circuit.lastSuccessAt ? new Date(circuit.lastSuccessAt * 1000).toLocaleString() : "—"}
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
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Circuit Breakers</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
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
      </CardContent>
    </Card>
  );
}
