import { cn } from "@/lib/utils";
import { CONTROL_COMPONENT_ROLE_LABELS, type ControlComponentRole } from "@shared/lib/classification";

/**
 * The one grammar for how a published Control component relates to the
 * pillar minimum (plan §6). Every surface that marks a limiting or a
 * diagnostic component draws it with `ControlRoleTag`, never its own marker:
 * module headers, the rail Evidence index (`size="compact"`) and the
 * deployment-strip legend.
 *
 * Both draw the page's standard neutral pill (the chip-row shape), so the
 * role reads as a qualifier beside the score pill, never as a status of its
 * own; the glyph and the outline pattern carry the role:
 *
 * - `limiting`: a filled diamond in a solid pill.
 * - `diagnostic`: a dashed hollow diamond in a dashed pill, the dashed
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

/** What the role means for the score, in plain words: the tooltip and the spoken tail. */
export const CONTROL_ROLE_HINTS: Record<MarkedRole, string> = {
  limiting: "The lowest eligible Control input: it sets the Economic Control score",
  diagnostic: "Shown for context: outside the inputs that set the Economic Control score",
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
  // ("Limiting input · before adjustments") and what it means for the score;
  // the eye gets glyph + word, with the plain meaning on hover.
  const remainder = label.startsWith(word) ? label.slice(word.length) : ` · ${label}`;
  const hint = CONTROL_ROLE_HINTS[role];
  return (
    <span
      data-control-role={role}
      title={hint}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border text-2xs font-medium leading-tight",
        size === "compact" ? "px-1.5 py-px" : "px-2 py-0.5",
        role === "limiting"
          ? "border-border/60 bg-muted/30 text-foreground"
          : "border-dashed border-muted-foreground/50 text-muted-foreground",
      )}
    >
      <ControlRoleGlyph role={role} className={size === "compact" ? "size-2" : undefined} />
      {word}
      <span className="sr-only">{`${remainder}. ${hint}.`}</span>
    </span>
  );
}
