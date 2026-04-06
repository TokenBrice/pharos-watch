import { Skeleton } from "@/components/ui/skeleton";

export function SectionSkeleton({ className }: { className: string }) {
  return <Skeleton className={className} />;
}

export function ChartSkeleton({ className, type = "area", height = "h-[300px]" }: { className?: string; type?: "area" | "bar" | "radar"; height?: string }) {
  return (
    <div className={`relative overflow-hidden rounded-xl border border-border/50 bg-card/50 ${className}`}>
      {/* Chart header placeholder */}
      <div className="flex items-center justify-between border-b border-border/30 px-4 py-3">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-8 w-24 rounded-md" />
      </div>
      {/* Chart area placeholder */}
      <div className="relative px-4 pb-4 pt-3">
        {/* Y-axis labels */}
        <div className="absolute left-4 top-3 bottom-4 flex flex-col justify-between py-2">
          <Skeleton className="h-3 w-8" />
          <Skeleton className="h-3 w-8" />
          <Skeleton className="h-3 w-8" />
          <Skeleton className="h-3 w-6" />
        </div>
        {/* Chart content */}
        <div className={`ml-12 ${height} relative`}>
          {type === "area" && (
            <>
              <div className="absolute inset-0 bg-gradient-to-b from-muted/60 via-muted/30 to-transparent rounded-lg" />
              <div className="absolute bottom-0 left-0 right-0 h-1/2 bg-gradient-to-t from-muted/40 to-transparent rounded-b-lg" />
              {/* Simulated line path */}
              <svg className="absolute inset-0 w-full h-full" preserveAspectRatio="none">
                <path
                  d="M0,80 C50,70 100,90 150,60 S250,40 300,50 S400,30 450,45 S550,35 600,40"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="text-muted-foreground/30"
                />
              </svg>
            </>
          )}
          {type === "radar" && (
            <div className="flex h-full items-center justify-center">
              <div className="relative h-4/5 w-4/5">
                <div className="absolute inset-0 rounded-full border-2 border-dashed border-muted-foreground/20" />
                <div className="absolute inset-[15%] rounded-full border-2 border-dashed border-muted-foreground/20" />
                <div className="absolute inset-[30%] rounded-full border-2 border-dashed border-muted-foreground/20" />
                <div className="absolute inset-[45%] rounded-full bg-muted-foreground/10" />
              </div>
            </div>
          )}
          {type === "bar" && (
            <div className="flex h-full items-end justify-around gap-2 px-4">
              <Skeleton variant="shimmer" className="h-[40%] w-8" />
              <Skeleton variant="shimmer" className="h-[65%] w-8" />
              <Skeleton variant="shimmer" className="h-[50%] w-8" />
              <Skeleton variant="shimmer" className="h-[80%] w-8" />
              <Skeleton variant="shimmer" className="h-[45%] w-8" />
              <Skeleton variant="shimmer" className="h-[70%] w-8" />
            </div>
          )}
          {/* X-axis labels */}
          <div className="absolute -bottom-6 left-0 right-0 flex justify-between">
            <Skeleton className="h-3 w-10" />
            <Skeleton className="h-3 w-10" />
            <Skeleton className="h-3 w-10" />
            <Skeleton className="h-3 w-10" />
          </div>
        </div>
      </div>
    </div>
  );
}
