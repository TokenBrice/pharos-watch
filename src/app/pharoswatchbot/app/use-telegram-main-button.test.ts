// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTelegramMainButton, type UseTelegramMainButtonArgs } from "./use-telegram-main-button";

afterEach(cleanup);

it("keeps exactly one native listener across handler, activity, SDK and unmount transitions", () => {
  const button = () => {
    const listeners = new Set<() => void>();
    return {
      listeners,
      show: vi.fn(), hide: vi.fn(), setParams: vi.fn(),
      onClick: vi.fn((handler: () => void) => { listeners.add(handler); }),
      offClick: vi.fn((handler: () => void) => { listeners.delete(handler); }),
    };
  };
  const first = button();
  const second = button();
  const handlerA = vi.fn();
  const handlerB = vi.fn();
  const initialProps: UseTelegramMainButtonArgs = {
    webApp: { initData: "signed", MainButton: first, themeParams: { button_color: "#123456" } },
    text: "Save", handler: handlerA,
  };
  const { rerender, unmount } = renderHook(useTelegramMainButton, { initialProps });
  expect([...first.listeners]).toEqual([handlerA]);
  expect(first.setParams).toHaveBeenLastCalledWith({ text: "Save", is_visible: true, is_active: true, color: "#123456" });
  rerender({ ...initialProps, handler: null });
  expect(first.listeners.size).toBe(0);
  expect(first.offClick).toHaveBeenCalledExactlyOnceWith(handlerA);
  rerender({ ...initialProps, handler: handlerB });
  expect([...first.listeners]).toEqual([handlerB]);
  rerender({ ...initialProps, handler: handlerB, active: false });
  expect(first.listeners.size).toBe(0);
  expect(first.setParams).toHaveBeenLastCalledWith(expect.objectContaining({ is_active: false }));
  rerender({ ...initialProps, handler: handlerB, color: "#654321", textColor: "#ffffff" });
  expect([...first.listeners]).toEqual([handlerB]);
  expect(first.setParams).toHaveBeenLastCalledWith(expect.objectContaining({ color: "#654321", text_color: "#ffffff" }));
  rerender({ ...initialProps, handler: handlerB, webApp: { initData: "signed", MainButton: second } });
  expect(first.listeners.size).toBe(0);
  expect(first.hide).toHaveBeenCalled();
  expect([...second.listeners]).toEqual([handlerB]);
  unmount();
  expect(second.listeners.size).toBe(0);
  expect(second.offClick).toHaveBeenCalledExactlyOnceWith(handlerB);
  expect(second.hide).toHaveBeenCalled();
});
