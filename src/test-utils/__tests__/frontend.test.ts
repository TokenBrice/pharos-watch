// @vitest-environment jsdom
import { expect, it } from "vitest";
import { cleanupFrontendTest, installMatchMediaMock } from "../frontend";

it("restores the original matchMedia after replacing a query predicate", () => {
  const descriptor = Object.getOwnPropertyDescriptor(window, "matchMedia");
  const original = (query: string) => ({ matches: query === "original", media: query });
  Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: original });
  try {
    installMatchMediaMock((query) => query === "replacement");
    expect(window.matchMedia("replacement").matches).toBe(true);
    cleanupFrontendTest();
    expect(window.matchMedia).toBe(original);
    expect(window.matchMedia("replacement").matches).toBe(false);
  } finally {
    cleanupFrontendTest();
    if (descriptor) Object.defineProperty(window, "matchMedia", descriptor);
    else Reflect.deleteProperty(window, "matchMedia");
  }
});
