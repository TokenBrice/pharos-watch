import { API_PARTNERS } from "@/lib/api-partners";

/** Teams that build on the API and agreed to be named; usage, not endorsement. */
export function ApiPartnerLogos() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <p id="api-partners-label" className="pharos-label">
        Used by
      </p>
      <ul
        aria-labelledby="api-partners-label"
        className="grid grid-cols-2 gap-x-4 gap-y-2 sm:flex sm:flex-wrap sm:items-center"
      >
        {API_PARTNERS.map((partner) => (
          <li key={partner.name}>
            <a
              href={partner.href}
              target="_blank"
              rel="noopener noreferrer"
              className="pharos-focus-ring inline-flex items-center gap-2 rounded-md text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {/* Same plate as StablecoinLogo: dark marks stay visible in dark mode. */}
              <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/80 dark:bg-foreground/90">
                <img src={partner.logoSrc} alt="" width={18} height={18} className="size-4.5 rounded-full" />
              </span>
              {partner.name}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
