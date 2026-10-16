// @vitest-environment jsdom

import { useEffect, type ReactNode } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CemeterySelectionProvider,
  useCemeterySelection,
  type CemeterySelectionHandler,
} from "@/components/cemetery/cemetery-selection-context";

const KNOWN_IDS = ["ust-terrausd-2022-05", "mim-abracadabra"] as const;

function Probe() {
  const value = useCemeterySelection();
  return <output data-testid="selected">{value.selectedId ?? "none"}</output>;
}

function Registrar({ onPin, onReveal }: { onPin?: CemeterySelectionHandler; onReveal?: CemeterySelectionHandler }) {
  const { registerPinGrave, registerRevealRecord } = useCemeterySelection();
  useEffect(() => (onPin ? registerPinGrave(onPin) : undefined), [onPin, registerPinGrave]);
  useEffect(() => (onReveal ? registerRevealRecord(onReveal) : undefined), [onReveal, registerRevealRecord]);
  return null;
}

function renderProvider(children: ReactNode) {
  return render(
    <CemeterySelectionProvider knownIds={KNOWN_IDS}>
      <Probe />
      {children}
    </CemeterySelectionProvider>,
  );
}

/** A user fragment navigation: new history entry, then the browser's hashchange. */
function navigateToHash(hash: string) {
  act(() => {
    window.history.pushState(null, "", hash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("CemeterySelectionProvider", () => {
  it("queues a record hash until the handlers register, then flushes it once", () => {
    window.history.replaceState(null, "", "/cemetery/#mim-abracadabra");
    const onPin = vi.fn();
    const onReveal = vi.fn();
    const view = renderProvider(null);

    expect(screen.getByTestId("selected").textContent).toBe("mim-abracadabra");
    expect(onPin).not.toHaveBeenCalled();

    view.rerender(
      <CemeterySelectionProvider knownIds={KNOWN_IDS}>
        <Probe />
        <Registrar onPin={onPin} onReveal={onReveal} />
      </CemeterySelectionProvider>,
    );

    expect(onPin).toHaveBeenCalledExactlyOnceWith("mim-abracadabra", "hash");
    expect(onReveal).toHaveBeenCalledExactlyOnceWith("mim-abracadabra", "hash");
  });

  it("pins and reveals on hashchange, ignoring sections and unknown ids", () => {
    window.history.replaceState(null, "", "/cemetery/");
    const onPin = vi.fn();
    const onReveal = vi.fn();
    renderProvider(<Registrar onPin={onPin} onReveal={onReveal} />);
    expect(onPin).not.toHaveBeenCalled();

    for (const hash of ["#register", "#cause-abandoned", "#not-a-coin"]) navigateToHash(hash);
    expect(onPin).not.toHaveBeenCalled();
    expect(onReveal).not.toHaveBeenCalled();

    navigateToHash("#ust-terrausd-2022-05");
    expect(onPin).toHaveBeenCalledExactlyOnceWith("ust-terrausd-2022-05", "hash");
    expect(onReveal).toHaveBeenCalledExactlyOnceWith("ust-terrausd-2022-05", "hash");
    expect(screen.getByTestId("selected").textContent).toBe("ust-terrausd-2022-05");
  });
});
