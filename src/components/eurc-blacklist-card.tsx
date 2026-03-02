import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export function EurcBlacklistCard() {
  return (
    <Card className="rounded-xl border-l-[3px] border-l-blue-500">
      <CardHeader className="pb-1">
        <div className="flex items-center justify-between">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            EURC Blacklisting
          </CardTitle>
          <Badge variant="secondary" className="text-xs">Info</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col items-center text-center gap-2 sm:flex-row sm:text-left sm:gap-4">
          <img src="/logos/50-eurc.png" alt="EURC" className="size-12 sm:size-14 shrink-0 rounded-full opacity-60 saturate-50" />
          <p className="text-sm text-muted-foreground">
            Circle blacklists addresses across all its tokens simultaneously. When an address is frozen on USDC, it is also frozen on EURC. Pharos tracks USDC events only to avoid duplicate zero-balance entries.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
