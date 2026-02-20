import { ExternalLink, Globe } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { StablecoinMeta } from "@/lib/types";

export function IssuerInfoCard({ meta }: { meta: StablecoinMeta }) {
  const isDecentralized = meta.flags.governance === "decentralized";
  const hasLinks = meta.links && meta.links.length > 0;
  const hasJurisdiction = !isDecentralized && meta.jurisdiction;

  if (!hasLinks && !hasJurisdiction) return null;

  return (
    <Card className="rounded-2xl border-l-[3px] border-l-violet-500">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Issuer Info</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {hasJurisdiction && meta.jurisdiction && (
          <div className="rounded-xl bg-muted/50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Jurisdiction</p>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{meta.jurisdiction.country}</span>
              {meta.jurisdiction.regulator && (
                <span className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold bg-blue-500/10 text-blue-500 border-blue-500/20">
                  {meta.jurisdiction.regulator}
                </span>
              )}
              {meta.jurisdiction.license && (
                <span className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold bg-violet-500/10 text-violet-500 border-violet-500/20">
                  {meta.jurisdiction.license}
                </span>
              )}
            </div>
          </div>
        )}

        {hasLinks && (
          <div className="flex flex-wrap gap-3">
            {meta.links!.map((link) => (
              <a
                key={link.url}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors"
              >
                {link.label === "Website" ? (
                  <Globe className="h-3.5 w-3.5" />
                ) : (
                  <ExternalLink className="h-3.5 w-3.5" />
                )}
                {link.label}
              </a>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
