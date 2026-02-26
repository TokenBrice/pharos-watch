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
          <svg viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg" className="size-10 sm:size-12 shrink-0 opacity-60 saturate-50">
            <circle cx="25" cy="25" r="25" fill="#2775CA" />
            <text x="25" y="27" textAnchor="middle" dominantBaseline="central" fill="white" fontSize="16" fontWeight="bold" fontFamily="system-ui, sans-serif">€</text>
          </svg>
          <p className="text-sm text-muted-foreground">
            Circle blacklists addresses across all its tokens simultaneously — when an address is frozen on USDC, it is also frozen on EURC. Pharos tracks USDC events only to avoid duplicate zero-balance entries.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
