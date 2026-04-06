import type { StatusPageAction } from "./definitions";
import { ENDPOINT_DEFINITIONS } from "./definitions";

export function getStatusPageActions(): StatusPageAction[] {
  return ENDPOINT_DEFINITIONS.flatMap((endpoint) => {
    if (!endpoint.statusPageAction) return [];
    return [
      {
        label: endpoint.statusPageAction.label,
        path: endpoint.statusPageAction.path ?? endpoint.probePath ?? endpoint.path,
        confirm: endpoint.statusPageAction.confirm,
        destructive: endpoint.statusPageAction.destructive ?? false,
        method: endpoint.statusPageAction.method,
        acceptsStablecoinFilter: endpoint.statusPageAction.acceptsStablecoinFilter ?? false,
      },
    ];
  });
}
