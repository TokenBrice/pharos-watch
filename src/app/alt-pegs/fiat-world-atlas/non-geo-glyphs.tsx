export function SunGlyph({ color }: { color: string }) {
  const gradId = `sun-grad-${color.replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <svg viewBox="0 0 100 100" className="h-full w-full">
      <defs>
        <radialGradient id={gradId} cx="42%" cy="38%" r="60%">
          <stop offset="0%" stopColor={`${color}ff`} />
          <stop offset="70%" stopColor={`${color}cc`} />
          <stop offset="100%" stopColor={`${color}00`} />
        </radialGradient>
      </defs>
      <circle cx="50" cy="50" r="46" fill={`${color}18`} />
      <circle cx="50" cy="50" r="32" fill={`url(#${gradId})`} />
      <circle cx="50" cy="50" r="20" fill={color} />
    </svg>
  );
}

export function MoonGlyph({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 100 100" className="h-full w-full">
      <circle cx="50" cy="50" r="38" fill={`${color}28`} />
      <circle cx="50" cy="50" r="26" fill={color} />
      <circle cx="42" cy="44" r="22" fill="var(--background)" opacity="0.9" />
    </svg>
  );
}

export function IndexGlyph({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 100 100" className="h-full w-full">
      <circle cx="50" cy="50" r="42" fill="none" stroke={`${color}66`} strokeWidth="2" />
      <circle cx="50" cy="50" r="28" fill="none" stroke={`${color}aa`} strokeWidth="2" />
      <circle cx="50" cy="50" r="10" fill={color} />
      <circle cx="50" cy="8" r="3" fill={color} />
      <circle cx="92" cy="50" r="3" fill={color} />
      <circle cx="50" cy="92" r="3" fill={color} />
      <circle cx="8" cy="50" r="3" fill={color} />
    </svg>
  );
}
