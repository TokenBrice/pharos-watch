const PILLARS: ReadonlyArray<{
  key: "backing" | "exit" | "control";
  label: string;
  weight: number;
  question: string;
  description: string;
  signals: string;
  segmentColor: string;
}> = [
  {
    key: "backing",
    label: "Backing",
    weight: 40,
    question: "Is there real value behind the token?",
    description: "Tests the quality, transparency, and structure of reserves or collateral.",
    signals: "Assets · Custody · Mechanism",
    segmentColor: "#4bc4de",
  },
  {
    key: "exit",
    label: "Exit",
    weight: 35,
    question: "Can I get my value out?",
    description: "Tests real redemption and market routes at meaningful size, not theoretical liquidity.",
    signals: "Redemption · Depth · Route diversity",
    segmentColor: "#2388b8",
  },
  {
    key: "control",
    label: "Control",
    weight: 25,
    question: "Who can change or break the system?",
    description: "Tests minting, oracle, bridge, and intervention powers that can harm holders.",
    signals: "Minting · Oracles · Bridges",
    segmentColor: "#31536f",
  },
];

export function SafetyPillarExplainer() {
  return (
    <section
      className="pharos-card-shell overflow-hidden"
      aria-labelledby="safety-pillar-explainer-title"
    >
      <div className="border-b border-border/50 px-4 py-4 sm:px-6">
        <p className="pharos-kicker">How to read the score</p>
        <h2
          id="safety-pillar-explainer-title"
          className="mt-1.5 text-lg font-semibold tracking-tight text-foreground sm:text-xl"
        >
          Three questions behind every grade
        </h2>
      </div>

      <div
        className="flex h-1.5 w-full gap-1 bg-background"
        role="img"
        aria-label="Safety Score pillar weights: Backing 40%, Exit 35%, Control 25%"
      >
        {PILLARS.map((pillar) => (
          <span
            key={pillar.key}
            aria-hidden="true"
            style={{
              width: `${pillar.weight}%`,
              backgroundColor: pillar.segmentColor,
            }}
          />
        ))}
      </div>

      <ol className="grid md:grid-cols-3">
        {PILLARS.map((pillar, index) => {
          return (
            <li
              key={pillar.key}
              className="border-b border-border/50 px-4 py-4 last:border-b-0 sm:px-6 md:border-b-0 md:border-r md:last:border-r-0"
            >
              <div className="min-w-0">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="pharos-kicker">
                    <span className="sr-only">Pillar {index + 1}: </span>
                    {pillar.label}
                  </p>
                  <span className="pharos-numeric text-sm font-semibold text-foreground">
                    {pillar.weight}%
                  </span>
                </div>
                <h3 className="mt-2 text-sm font-semibold leading-snug text-foreground sm:text-[15px]">
                  {pillar.question}
                </h3>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  {pillar.description}
                </p>
                <p className="pharos-meta mt-3 text-[11px] text-foreground/75">
                  {pillar.signals}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
