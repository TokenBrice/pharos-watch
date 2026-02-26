import { ExternalLink, Globe } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { StablecoinMeta } from "@/lib/types";
import {
  GOVERNANCE_BADGE_STYLES,
  BACKING_BADGE_STYLES,
  PEG_BADGE_STYLES,
  POR_BADGE_STYLES,
} from "@/lib/classification";

export function KeyInfoCard({ meta }: { meta: StablecoinMeta }) {
  const gov = GOVERNANCE_BADGE_STYLES[meta.flags.governance];
  const backing = BACKING_BADGE_STYLES[meta.flags.backing];
  const peg = PEG_BADGE_STYLES[meta.flags.pegCurrency];
  const hasDescription = meta.collateral || meta.pegMechanism;
  const isDecentralized = meta.flags.governance === "decentralized";
  const hasJurisdiction = !isDecentralized && meta.jurisdiction;
  const hasLinks = meta.links && meta.links.length > 0;

  return (
    <Card className="rounded-xl border-l-[3px] border-l-violet-500">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Key Information</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">

        {/* Links (left) + classification badges (right) */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          {hasLinks && (
            <div className="flex flex-wrap items-center gap-2">
              {meta.links?.map((link) => (
                <a
                  key={link.url}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors"
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
          <div className="flex flex-wrap items-center gap-2">
            {gov && <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${gov.cls}`}>{gov.label}</span>}
            {backing && <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${backing.cls}`}>{backing.label}</span>}
            {peg && <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${peg.cls}`}>{peg.label}</span>}
            {meta.flags.yieldBearing && <span className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold bg-emerald-500/10 text-emerald-500 border-emerald-500/20">Yield-Bearing</span>}
            {meta.flags.rwa && <span className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold bg-sky-500/10 text-sky-500 border-sky-500/20">RWA</span>}
            {!isDecentralized && (
              meta.proofOfReserves ? (
                <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${POR_BADGE_STYLES[meta.proofOfReserves.type].cls}`}>
                  {POR_BADGE_STYLES[meta.proofOfReserves.type].label}
                </span>
              ) : (
                <span className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold bg-red-500/10 text-red-500 border-red-500/20">
                  No PoR
                </span>
              )
            )}
          </div>
        </div>

        {/* Collateral + Peg Stability */}
        {hasDescription && (
          <div className="grid gap-4 sm:grid-cols-2">
            {meta.collateral && (
              <div className="rounded-xl bg-muted/50 p-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Collateral</p>
                <p className="text-sm leading-relaxed">{meta.collateral}</p>
              </div>
            )}
            {meta.pegMechanism && (
              <div className="rounded-xl bg-muted/50 p-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Peg Stability</p>
                <p className="text-sm leading-relaxed">{meta.pegMechanism}</p>
              </div>
            )}
          </div>
        )}

        {/* Proof of Reserves + Jurisdiction (2-col on desktop) */}
        {!isDecentralized && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl bg-muted/50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Proof of Reserves</p>
              {meta.proofOfReserves ? (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm leading-relaxed">
                    {POR_BADGE_STYLES[meta.proofOfReserves.type].label}
                    {meta.proofOfReserves.provider && ` by ${meta.proofOfReserves.provider}`}
                  </p>
                  <a
                    href={meta.proofOfReserves.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-sm text-blue-500 hover:underline shrink-0"
                  >
                    View reserves <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No proof of reserves published</p>
              )}
            </div>

            {meta.jurisdiction && (
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
          </div>
        )}


      </CardContent>
    </Card>
  );
}
