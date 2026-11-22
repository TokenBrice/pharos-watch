import Link from "next/link";

export function ScreenerModeSwitch({ active }: { active: "screener" | "picker" }) {
  return (
    <nav aria-label="Screener mode" className="pharos-segmented shrink-0">
      <Link
        href="/screener/"
        aria-current={active === "screener" ? "page" : undefined}
        className="pharos-focus-ring pharos-segmented-item min-h-11 px-3 sm:min-h-8"
      >
        Screener
      </Link>
      <Link
        href="/screener/picker/"
        aria-current={active === "picker" ? "page" : undefined}
        className="pharos-focus-ring pharos-segmented-item min-h-11 px-3 sm:min-h-8"
      >
        Guided Picker
      </Link>
    </nav>
  );
}
