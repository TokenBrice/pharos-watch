// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiKeyRequestForm } from "@/components/api-key-request-form";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

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

  it("prominently reveals an issued key after email verification", async () => {
    const suffix = randomUUID().slice(0, 8);
    const token = `ph_test_${suffix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const keyPrefix = `prefix-${suffix}`;

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      status: "issued",
      requestId: `akr_${suffix}`,
      key: {
        id: 1,
        keyPrefix,
        maskedToken: `${keyPrefix}...`,
        name: `self-serve-${suffix}`,
        ownerEmail: `api-smoke-${suffix}@example.com`,
        tier: "self-serve",
        trafficClass: "external",
        rateLimitPerMinute: 30,
        isActive: true,
        expiresAt: 1_788_888_888,
        createdAt: 1_783_704_000,
        updatedAt: 1_783_704_000,
        lastUsedAt: null,
        lastUsedRoute: null,
      },
      token,
      usage: {
        baseUrl: "https://api.pharos.watch",
        headerName: "X-API-Key",
        retryGuidance: "Respect 429 Retry-After responses.",
      },
    }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    })));

    window.history.replaceState(null, "", `/api/?verify=verify-${suffix}`);
    render(<ApiKeyRequestForm />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Your API Key Is Ready" })).toBeTruthy();
    });

    expect(screen.getByText("Copy this token now.")).toBeTruthy();
    expect(screen.getByText(token)).toBeTruthy();
    expect(screen.getByText("Issued Key Policy")).toBeTruthy();
  });
});
