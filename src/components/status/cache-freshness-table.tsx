import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatAge } from "./format";

interface CacheFreshnessTableProps {
  caches: Record<string, { ageSeconds: number | null; maxAge: number; healthy: boolean }>;
}

export function CacheFreshnessTable({ caches }: CacheFreshnessTableProps) {
  const sorted = Object.entries(caches).sort(([, a], [, b]) => {
    const ratioA = a.ageSeconds != null ? a.ageSeconds / a.maxAge : Infinity;
    const ratioB = b.ageSeconds != null ? b.ageSeconds / b.maxAge : Infinity;
    return ratioB - ratioA;
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Cache Freshness</CardTitle>
      </CardHeader>
      <CardContent>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="pb-2 font-medium">Cache Key</th>
              <th className="pb-2 font-medium">Age</th>
              <th className="pb-2 font-medium">Max Age</th>
              <th className="pb-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(([key, cache]) => (
              <tr key={key} className="border-b last:border-0">
                <td className="py-2 font-mono text-xs">{key}</td>
                <td className="py-2">{cache.ageSeconds != null ? formatAge(cache.ageSeconds) : "—"}</td>
                <td className="py-2">{formatAge(cache.maxAge)}</td>
                <td className="py-2">
                  <div className={`h-2.5 w-2.5 rounded-full ${cache.healthy ? "bg-green-500" : "bg-red-500"}`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
