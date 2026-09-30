// @vitest-environment jsdom

import { useEffect, type ReactNode } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CemeterySelectionProvider,
  useCemeterySelection,
  type CemeterySelectionContextValue,
  type CemeterySelectionHandler,
} from "@/components/cemetery/cemetery-selection-context";

const KNOWN_IDS = ["ust-terrausd-2022-05", "mim-abracadabra"] as const;

let selection: CemeterySelectionContextValue | null = null;

function Probe() {
  const value = useCemeterySelection();
  useEffect(() => {
    selection = value;
  });
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

function current(): CemeterySelectionContextValue {
  if (!selection) throw new Error("provider not rendered");
  return selection;
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
  selection = null;
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

  it("normalises the legacy obituary alias to the canonical anchor", () => {
    window.history.replaceState(null, "", "/cemetery/?cause=abandoned#obituary-ust-terrausd-2022-05");
    const onReveal = vi.fn();
    renderProvider(<Registrar onReveal={onReveal} />);

    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      "/cemetery/?cause=abandoned#ust-terrausd-2022-05",
    );
    expect(onReveal).toHaveBeenCalledExactlyOnceWith("ust-terrausd-2022-05", "hash");
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

  it("writes the record hash with replaceState and does not re-trigger its own handlers", () => {
    window.history.replaceState(null, "", "/cemetery/?peak=1b-plus");
    const onPin = vi.fn();
    const onReveal = vi.fn();
    renderProvider(<Registrar onPin={onPin} onReveal={onReveal} />);
    const replaceState = vi.spyOn(window.history, "replaceState");
    const pushState = vi.spyOn(window.history, "pushState");
    const historyLength = window.history.length;

    act(() => current().setRecordHash("mim-abracadabra"));

    expect(replaceState).toHaveBeenCalledOnce();
    expect(pushState).not.toHaveBeenCalled();
    expect(window.history.length).toBe(historyLength);
    expect(window.location.search + window.location.hash).toBe("?peak=1b-plus#mim-abracadabra");
    expect(screen.getByTestId("selected").textContent).toBe("mim-abracadabra");

    // An echoed hashchange for the hash the provider just wrote is not a new request.
    act(() => {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(onPin).not.toHaveBeenCalled();
    expect(onReveal).not.toHaveBeenCalled();

    // Writing the same hash again is a no-op.
    act(() => current().setRecordHash("mim-abracadabra"));
    expect(replaceState).toHaveBeenCalledOnce();

    act(() => current().setRecordHash(null));
    expect(window.location.search + window.location.hash).toBe("?peak=1b-plus");
    expect(screen.getByTestId("selected").textContent).toBe("none");
  });

  it("routes pin and reveal requests to the registered handlers with their source", () => {
    const onPin = vi.fn();
    const onReveal = vi.fn();
    renderProvider(<Registrar onPin={onPin} onReveal={onReveal} />);

    act(() => current().revealRecord("ust-terrausd-2022-05", "hero"));
    act(() => current().pinGrave("mim-abracadabra", "register"));
    act(() => current().pinGrave("not-a-coin", "chart"));

    expect(onReveal).toHaveBeenCalledExactlyOnceWith("ust-terrausd-2022-05", "hero");
    expect(onPin).toHaveBeenCalledExactlyOnceWith("mim-abracadabra", "register");
    expect(screen.getByTestId("selected").textContent).toBe("mim-abracadabra");
  });

  it("stops delivering to an unregistered handler and queues for the next one", () => {
    const first = vi.fn();
    const second = vi.fn();
    const view = renderProvider(<Registrar onPin={first} />);
    view.rerender(
      <CemeterySelectionProvider knownIds={KNOWN_IDS}>
        <Probe />
      </CemeterySelectionProvider>,
    );

    act(() => current().pinGrave("ust-terrausd-2022-05", "facts"));
    act(() => current().pinGrave("mim-abracadabra", "causes"));
    expect(first).not.toHaveBeenCalled();

    view.rerender(
      <CemeterySelectionProvider knownIds={KNOWN_IDS}>
        <Probe />
        <Registrar onPin={second} />
      </CemeterySelectionProvider>,
    );
    expect(second).toHaveBeenCalledExactlyOnceWith("mim-abracadabra", "causes");
  });
});
