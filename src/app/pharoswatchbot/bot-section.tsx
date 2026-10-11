import { cn } from "@/lib/utils";

interface BotSectionProps {
  id: string;
  kicker: string;
  title: string;
  lead?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

/**
 * One flat card per landing-page section: kicker → h2 → optional lead, then
 * the body. Keeps every band on the shared card shell and heading scale.
 */
export function BotSection({ id, kicker, title, lead, className, children }: BotSectionProps) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={cn("pharos-card-shell scroll-mt-24 p-5 sm:p-6 lg:p-7", className)}
    >
      <div className="max-w-3xl space-y-1.5">
        <p className="pharos-kicker">{kicker}</p>
        <h2 id={`${id}-title`} className="pharos-section-title">
          {title}
        </h2>
        {lead ? <p className="pharos-lead">{lead}</p> : null}
      </div>
      <div className="mt-6">{children}</div>
    </section>
  );
}
