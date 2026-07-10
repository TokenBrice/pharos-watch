import type { StatusPageAction } from "./definitions";
import { ENDPOINT_DEFINITIONS } from "./definitions";

export function getStatusPageActions(): StatusPageAction[] {
  return ENDPOINT_DEFINITIONS.flatMap((endpoint) => {
    if (!endpoint.statusPageAction) return [];
    return [
      {
        label: endpoint.statusPageAction.label,
        path: endpoint.statusPageAction.path ?? endpoint.path,
        confirm: endpoint.statusPageAction.confirm,
        destructive: endpoint.statusPageAction.destructive ?? false,
        method: endpoint.statusPageAction.method,
        acceptsStablecoinFilter: endpoint.statusPageAction.scope.type === "asset-or-batch",
        group: endpoint.statusPageAction.group ?? "recovery",
        kind: endpoint.statusPageAction.kind,
        risk: endpoint.statusPageAction.risk,
        scope: endpoint.statusPageAction.scope,
        dryRun: endpoint.statusPageAction.dryRun,
        expectedDuration: endpoint.statusPageAction.expectedDuration,
        preconditions: endpoint.statusPageAction.preconditions,
        blockedBy: endpoint.statusPageAction.blockedBy,
        resultMode: endpoint.statusPageAction.resultMode,
        ...(endpoint.statusPageAction.rollback ? { rollback: endpoint.statusPageAction.rollback } : {}),
        ...(endpoint.statusPageAction.runbookPath ? { runbookPath: endpoint.statusPageAction.runbookPath } : {}),
      },
    ];
  });
}
