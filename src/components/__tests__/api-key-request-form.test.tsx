// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ApiKeyRequestForm } from "@/components/api-key-request-form";

afterEach(cleanup);

describe("ApiKeyRequestForm", () => {
  it("enables submission for a concise completed request", () => {
    const suffix = randomUUID().slice(0, 8);
    render(<ApiKeyRequestForm />);

    const submit = screen.getByRole("button", { name: /send verification email/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: `api-smoke-${suffix}@example.com` },
    });
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: `Test User ${suffix}` },
    });
    fireEvent.change(screen.getByLabelText("Organization"), {
      target: { value: `Integration Lab ${suffix}` },
    });
    fireEvent.change(screen.getByLabelText("Project URL"), {
      target: { value: `https://example.com/pharos-${suffix}` },
    });
    fireEvent.change(screen.getByLabelText("Use Case"), {
      target: { value: `index QA workflow ${suffix}` },
    });
    fireEvent.change(screen.getByLabelText("Expected Volume"), {
      target: { value: `${200 + suffix.length} reads/day` },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Not sure yet" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /I will use the API for read-only public data/i }));

    expect(submit.disabled).toBe(false);
  });
});
