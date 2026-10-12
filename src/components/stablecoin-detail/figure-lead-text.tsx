const LEADING_FIGURE = /^([+\-−]?\d[\d.,/%]*(?:[KMBT](?![A-Za-z]))?)(.*)$/s;

/**
 * Three-register rule for short mixed sub-lines ("−12 bps", "2,671 pools",
 * "15/100", "1.2K pools", "30d vs USD 3M T-bill"): a leading figure renders in the mono
 * figure face, the words after it stay in the surrounding sans, as written.
 */
export function FigureLeadText({ text }: { text: string }) {
  const match = LEADING_FIGURE.exec(text);
  // "30d …" is a word-like period label, not a measured figure.
  if (!match || /^[a-z]/i.test(match[2] ?? "")) return <>{text}</>;
  return (
    <>
      <span className="pharos-numeric">{match[1]}</span>
      {match[2]}
    </>
  );
}
