// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CopyButton } from "@/components/copy-button";


const mockWriteText = vi.fn().mockResolvedValue(undefined);

Object.assign(navigator, {
  clipboard: { writeText: mockWriteText },
});

describe("CopyButton", () => {
  afterEach(() => {
    mockWriteText.mockClear();
  });

  it("copies text to clipboard on click", async () => {
    render(<CopyButton text="test-content" />);
    const button = screen.getByRole("button", { name: /copy/i });
    fireEvent.click(button);
    expect(mockWriteText).toHaveBeenCalledWith("test-content");
  });
});
