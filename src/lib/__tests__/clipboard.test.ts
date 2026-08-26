// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "@/lib/clipboard";

const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");

function setExecCommand(value: (command: string) => boolean) {
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalExecCommand) {
    Object.defineProperty(document, "execCommand", originalExecCommand);
  } else {
    Reflect.deleteProperty(document, "execCommand");
  }
});

describe("copyText", () => {
  it("uses the Clipboard API when it succeeds", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(copyText("hello")).resolves.toEqual({ ok: true });
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to execCommand when the Clipboard API rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    const execCommand = vi.fn(() => {
      expect(document.querySelector("textarea")?.value).toBe("fallback text");
      return true;
    });
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    setExecCommand(execCommand);

    await expect(copyText("fallback text")).resolves.toEqual({ ok: true });
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("returns a failure result when both copy paths fail", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    setExecCommand(() => false);

    await expect(copyText("blocked")).resolves.toEqual({
      ok: false,
      reason: "copy-failed",
    });
  });

  it("reports unavailable when neither copy path exists", async () => {
    vi.stubGlobal("navigator", {});

    await expect(copyText("unavailable")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});
