import { cn } from "@/lib/utils";
import { CONTROL_COMPONENT_ROLE_LABELS, type ControlComponentRole } from "@shared/lib/classification";

/**
 * The one grammar for how a published Control component relates to the
 * pillar minimum (plan §6). Every surface that marks a limiting or a
 * diagnostic component draws it with `ControlRoleTag`, never its own marker:
 * module headers, the rail Evidence index (`size="compact"`) and the
 * deployment-strip legend.
 *
 * - `limiting`: a filled diamond inside a solid outline, the outline the
 *   deployment strip draws around the component(s) at the eligible minimum.
 * - `diagnostic`: a dashed hollow diamond inside a dashed outline, the dashed
 *   track of a component outside the eligible set.
 * - `eligible` / `excluded`: nothing. An eligible component above the minimum
 *   is the default reading, and an unscored one already reads "NR" or "–".
 *
 * Roles come from `resolveControlComponentRoles`; `binding: true` alone only
 * means "in the eligible set" and never earns the limiting mark.
 */

type MarkedRole = Extract<ControlComponentRole, "limiting" | "diagnostic">;

/** The one visible word; the rest of the published label stays in the accessible text. */
const ROLE_WORDS: Record<MarkedRole, string> = {
  limiting: "Limiting",
  diagnostic: "Diagnostic",
};

function isMarkedRole(role: ControlComponentRole | null | undefined): role is MarkedRole {
  return role === "limiting" || role === "diagnostic";
}

/** The bare glyph, decorative: its owner names the role in text or in an aria-label. */
function ControlRoleGlyph({
  role,
  className,
}: {
  role: ControlComponentRole | null | undefined;
  className?: string;
}) {
  if (!isMarkedRole(role)) return null;
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 10 10"
      data-control-glyph={role}
      className={cn("size-2.5 shrink-0", className)}
    >
      {role === "limiting" ? (
        <path d="M5 0.5 9.5 5 5 9.5 0.5 5Z" className="fill-current" />
      ) : (
        <path
          d="M5 1.25 8.75 5 5 8.75 1.25 5Z"
          className="fill-none stroke-current"
          strokeWidth={1.25}
          strokeDasharray="1.6 1.15"
        />
      )}
    </svg>
  );
}

export function ControlRoleTag({
  role,
  size = "default",
}: {
  role: ControlComponentRole | null | undefined;
  size?: "default" | "compact";
}) {
  if (!isMarkedRole(role)) return null;
  const label = CONTROL_COMPONENT_ROLE_LABELS[role];
  const word = ROLE_WORDS[role];
  // Screen readers and copy-paste get the whole published label
  // ("Limiting input · before adjustments"); the eye gets glyph + word.
  const remainder = label.startsWith(word) ? label.slice(word.length) : ` · ${label}`;
  return (
    <span
      data-control-role={role}
      title={label}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md text-[11px] leading-tight",
        size === "compact" ? "px-1 py-px" : "px-1.5 py-0.5",
        role === "limiting"
          ? "border-[1.5px] border-foreground/80 font-medium text-foreground"
          : "border border-dashed border-muted-foreground/70 text-muted-foreground",
      )}
    >
      <ControlRoleGlyph role={role} className={size === "compact" ? "size-2" : undefined} />
      {word}
      <span className="sr-only">{remainder}</span>
    </span>
  );
}
