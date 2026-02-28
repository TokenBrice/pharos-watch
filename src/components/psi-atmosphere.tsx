import type { ConditionBand } from "@/lib/psi-colors";

/* ─── Deterministic crack SVG paths ───────────────────────────── */

const CRACK_PATHS = [
  "M 50,0 L 48,8 L 52,16 L 49,24 L 53,30 L 50,38 L 47,42 M 52,16 L 58,20 L 62,18",
  "M 15,0 L 18,12 L 16,20 L 20,28 L 17,36 M 18,12 L 24,15",
  "M 78,0 L 75,10 L 79,18 L 76,26 L 80,32 M 79,18 L 85,22",
  "M 5,100 L 8,88 L 6,80 L 10,72 L 7,65",
  "M 88,100 L 85,90 L 89,82 L 86,75 L 90,68",
];

/* ─── Band config ─────────────────────────────────────────────── */

const BAND_CONFIG: Record<
  ConditionBand,
  {
    bg: string;
    showCracks: boolean;
    crackOpacity: string;
    animateCracks: boolean;
    vignette: boolean;
  }
> = {
  BEDROCK: {
    bg: "",
    showCracks: false,
    crackOpacity: "opacity-0",
    animateCracks: false,
    vignette: false,
  },
  STEADY: {
    bg: "bg-blue-500/[0.015]",
    showCracks: false,
    crackOpacity: "opacity-0",
    animateCracks: false,
    vignette: false,
  },
  TREMOR: {
    bg: "bg-amber-500/[0.025]",
    showCracks: false,
    crackOpacity: "opacity-0",
    animateCracks: false,
    vignette: false,
  },
  FRACTURE: {
    bg: "bg-orange-500/[0.04]",
    showCracks: true,
    crackOpacity: "opacity-[0.04]",
    animateCracks: false,
    vignette: false,
  },
  CRISIS: {
    bg: "bg-red-500/[0.03]",
    showCracks: true,
    crackOpacity: "opacity-[0.07]",
    animateCracks: false,
    vignette: false,
  },
  MELTDOWN: {
    bg: "bg-red-500/[0.05]",
    showCracks: true,
    crackOpacity: "opacity-[0.12]",
    animateCracks: true,
    vignette: true,
  },
};

/* ─── Component ───────────────────────────────────────────────── */

export function PsiAtmosphere({ band }: { band: ConditionBand }) {
  const config = BAND_CONFIG[band];

  return (
    <div
      className={`absolute inset-0 pointer-events-none overflow-hidden rounded-xl -z-10 transition-all duration-1000 ${config.bg}`}
      aria-hidden="true"
    >
      {/* Crack SVG overlay */}
      {config.showCracks && (
        <svg
          className={`absolute inset-0 h-full w-full text-foreground ${config.crackOpacity} ${config.animateCracks ? "animate-pulse" : ""} transition-opacity duration-1000`}
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          fill="none"
          stroke="currentColor"
          strokeWidth="0.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {CRACK_PATHS.map((d) => (
            <path key={d} d={d} />
          ))}
        </svg>
      )}

      {/* Red edge vignette for MELTDOWN */}
      {config.vignette && (
        <div
          className="absolute inset-0 transition-opacity duration-1000"
          style={{
            background:
              "radial-gradient(ellipse at center, transparent 50%, rgba(239,68,68,0.08) 100%)",
          }}
        />
      )}
    </div>
  );
}
