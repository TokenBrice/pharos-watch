/// <reference types="react/canary" />
import * as React from "react";
import type { ReactNode } from "react";

// The App Router bundles React canary, which exports `ViewTransition`; the
// stable `react` package (unit tests, tooling) does not, so each wrapper falls
// back to rendering its children unchanged. Every wrapper sets
// `default="none"` so it only animates for its own trigger, never for an
// unrelated transition elsewhere on the page. Reduced motion is honoured by
// the `::view-transition-*` rules in globals.css.
const ViewTransition: typeof React.ViewTransition | undefined = (React as Partial<typeof React>).ViewTransition;

/**
 * Shared-element morph for a stablecoin's identity (logo + ticker + name): a
 * row that links to the dossier and the dossier's identity header wrap their
 * identity with the same coin id, and the App Router navigation (a
 * transition) morphs one into the other. With `default="none"` the explicit
 * `share` is what keeps the pair morphing.
 */
export function StablecoinIdentityTransition({ id, children }: { id: string; children: ReactNode }) {
  if (!ViewTransition) return children;
  return (
    <ViewTransition name={`coin-identity-${id}`} share="auto" default="none">
      {children}
    </ViewTransition>
  );
}
