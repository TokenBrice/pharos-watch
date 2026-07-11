"use client";

import { ApiKeyRequestFields } from "@/components/api-key-request-fields";
import { ApiKeyRequestReveal } from "@/components/api-key-request-reveal";
import { useApiKeyRequestFormState } from "@/hooks/use-api-key-request-form-state";
import { cn } from "@/lib/utils";

export function ApiKeyRequestForm() {
  const model = useApiKeyRequestFormState();

  return (
    <div
      className={cn(
        "grid gap-5",
        model.issuedKey
          ? "lg:grid-cols-[minmax(0,0.46fr)_minmax(28rem,0.54fr)]"
          : "lg:grid-cols-[minmax(0,0.58fr)_minmax(20rem,0.42fr)]",
      )}
    >
      <ApiKeyRequestFields model={model} />
      <ApiKeyRequestReveal model={model} />
    </div>
  );
}
