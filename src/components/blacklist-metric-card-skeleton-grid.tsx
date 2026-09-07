import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function BlacklistMetricCardSkeletonGrid(props: { gridClassName: string; cardClassName: string }) {
  return (
    <div className={props.gridClassName}>
      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i} className={props.cardClassName}>
          <CardHeader><Skeleton className="h-4 w-24" /></CardHeader>
          <CardContent><Skeleton className="h-8 w-16" /></CardContent>
        </Card>
      ))}
    </div>
  );
}
