import { ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { StablecoinMeta } from "@/lib/types";
import {
  GOVERNANCE_BADGE_STYLES,
  BACKING_BADGE_STYLES,
  PEG_BADGE_STYLES,
  POR_BADGE_STYLES,
} from "@/lib/classification";

export function MechanismCard({ meta }: { meta: StablecoinMeta }) {
  const gov = GOVERNANCE_BADGE_STYLES[meta.flags.governance];
  const backing = BACKING_BADGE_STYLES[meta.flags.backing];
  const peg = PEG_BADGE_STYLES[meta.flags.pegCurrency];
  const hasDescription = meta.collateral || meta.pegMechanism;

  return (
    <Card className="rounded-2xl border-l-[3px] border-l-violet-500">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Classification & Mechanism</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {gov && <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${gov.cls}`}>{gov.label}</span>}
          {backing && <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${backing.cls}`}>{backing.label}</span>}
          {peg && <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${peg.cls}`}>{peg.label}</span>}
          {meta.flags.yieldBearing && <span className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold bg-emerald-500/10 text-emerald-500 border-emerald-500/20">Yield-Bearing</span>}
          {meta.flags.rwa && <span className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold bg-sky-500/10 text-sky-500 border-sky-500/20">RWA</span>}
          {meta.flags.governance !== "decentralized" && (
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

        {meta.flags.governance !== "decentralized" && (
          <div className="rounded-xl bg-muted/50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Proof of Reserves</p>
            {meta.proofOfReserves ? (
              <div className="space-y-1">
                <p className="text-sm leading-relaxed">
                  {POR_BADGE_STYLES[meta.proofOfReserves.type].label}
                  {meta.proofOfReserves.provider && ` by ${meta.proofOfReserves.provider}`}
                </p>
                <a
                  href={meta.proofOfReserves.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-blue-500 hover:underline"
                >
                  View reserves <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No proof of reserves published</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
