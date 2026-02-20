export function BalanceBar({ ratio }: { ratio: number }) {
  const pct = Math.round(ratio * 100);
  const bgColor = ratio >= 0.8 ? "bg-emerald-500" : ratio >= 0.5 ? "bg-amber-500" : "bg-red-500";
  const textColor = ratio >= 0.8 ? "text-emerald-500" : ratio >= 0.5 ? "text-amber-500" : "text-red-500";
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-12 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${bgColor}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`font-mono tabular-nums text-xs ${textColor}`}>{pct}%</span>
    </div>
  );
}
