"use client";

import type { FormEvent, RefObject } from "react";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { ApiKeySelfServeCadence } from "@shared/types";
import {
  readVerificationTokenFromUrl,
  stripQueryVerificationTokenFromUrl,
  stripVerificationTokenFromUrl,
} from "@/lib/api-key-verification-url";
import { submitApiKeyRequest, verifyApiKeyRequestToken } from "@/lib/api-key-self-serve";
import { copyText as writeClipboardText } from "@/lib/clipboard";
import {
  apiKeyRequestWorkflowReducer,
  buildApiKeySelfServeRequestPayload,
  buildCurlCommand,
  canSubmitApiKeyRequest,
  INITIAL_API_KEY_REQUEST_WORKFLOW_STATE,
  isProjectUrlValid,
} from "@/lib/api-key-request-form-view-model";


function useVerificationTokenEffect(verifyToken: (token: string) => Promise<void>) {
  const consumedVerificationTokenRef = useRef<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    stripQueryVerificationTokenFromUrl();
    const token = readVerificationTokenFromUrl();
    if (!token || consumedVerificationTokenRef.current === token) return;
    consumedVerificationTokenRef.current = token;
    stripVerificationTokenFromUrl();
    void verifyToken(token);
  }, [verifyToken]);
}

function useIssuedKeyFocusEffect(
  issuedKey: unknown,
  copyTokenButtonRef: RefObject<HTMLButtonElement | null>,
) {
  useEffect(() => {
    if (!issuedKey) return;
    copyTokenButtonRef.current?.focus();
  }, [copyTokenButtonRef, issuedKey]);
}

function useUnsavedTokenBeforeUnloadEffect(issuedKey: unknown, tokenSecured: boolean) {
  useEffect(() => {
    if (!issuedKey || tokenSecured) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [issuedKey, tokenSecured]);
}

export function useApiKeyRequestFormState() {
  const [state, dispatch] = useReducer(
    apiKeyRequestWorkflowReducer,
    INITIAL_API_KEY_REQUEST_WORKFLOW_STATE,
  );
  const copyTokenButtonRef = useRef<HTMLButtonElement | null>(null);
  const tokenCodeRef = useRef<HTMLElement | null>(null);

  const curlCommand = useMemo(
    () => state.issuedKey ? buildCurlCommand(state.issuedKey.token) : "",
    [state.issuedKey],
  );
  const trimmedUseCaseLength = state.useCase.trim().length;
  const projectUrlValue = state.projectUrl.trim();
  const projectUrlValid = isProjectUrlValid(projectUrlValue);
  const tokenSecured = state.tokenCopied || state.revealAcknowledged;
  const canSubmit = canSubmitApiKeyRequest(state);

  const copyText = useCallback(async (kind: "token" | "curl", value: string) => {
    const result = await writeClipboardText(value);
    if (result.ok) {
      dispatch({ type: "copySucceeded", kind });
      window.setTimeout(() => dispatch({ type: "clearCopied" }), 1800);
    } else {
      dispatch({
        type: "copyFailed",
        error: "Copy failed. Select the text and copy it manually before leaving this page.",
      });
    }
  }, []);

  const selectTokenText = useCallback(() => {
    const tokenNode = tokenCodeRef.current;
    const selection = window.getSelection?.();
    if (!tokenNode || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(tokenNode);
    selection.removeAllRanges();
    selection.addRange(range);
    tokenNode.focus();
  }, []);

  const verifyToken = useCallback(async (token: string) => {
    dispatch({ type: "verificationStarted" });

    try {
      const payload = await verifyApiKeyRequestToken(token);
      dispatch({ type: "verificationSucceeded", payload });
    } catch (error) {
      dispatch({
        type: "verificationFailed",
        error: error instanceof Error ? error.message : "Verification failed",
      });
    }
  }, []);

  useVerificationTokenEffect(verifyToken);
  useIssuedKeyFocusEffect(state.issuedKey, copyTokenButtonRef);
  useUnsavedTokenBeforeUnloadEffect(state.issuedKey, tokenSecured);

  const handleSubmit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    dispatch({ type: "submitStarted" });

    try {
      const payload = await submitApiKeyRequest(buildApiKeySelfServeRequestPayload(state));
      dispatch({ type: "submitSucceeded", payload });
    } catch (error) {
      dispatch({
        type: "submitFailed",
        error: error instanceof Error ? error.message : "Could not submit API key request",
      });
    }
  }, [state]);

  const markTokenSaved = useCallback(() => {
    dispatch({ type: "tokenSaved" });
  }, []);

  const setField = useCallback((
    field: "email" | "requesterName" | "organization" | "projectUrl" | "useCase" | "expectedVolume" | "website",
    value: string,
  ) => {
    dispatch({ type: "setField", field, value });
  }, []);

  return {
    acceptedTerms: state.acceptedTerms,
    canSubmit,
    copied: state.copied,
    copyError: state.copyError,
    copyText,
    copyTokenButtonRef,
    curlCommand,
    email: state.email,
    expectedCadence: state.expectedCadence,
    expectedVolume: state.expectedVolume,
    handleSubmit,
    issuedKey: state.issuedKey,
    markTokenSaved,
    organization: state.organization,
    pendingRequest: state.pendingRequest,
    projectUrl: state.projectUrl,
    projectUrlValid,
    projectUrlValue,
    requestError: state.requestError,
    requesterName: state.requesterName,
    requestStatus: state.requestStatus,
    selectTokenText,
    setAcceptedTerms: (value: boolean) => dispatch({ type: "setAcceptedTerms", value }),
    setEmail: (value: string) => setField("email", value),
    setExpectedCadence: (value: ApiKeySelfServeCadence) => dispatch({ type: "setExpectedCadence", value }),
    setExpectedVolume: (value: string) => setField("expectedVolume", value),
    setOrganization: (value: string) => setField("organization", value),
    setProjectUrl: (value: string) => setField("projectUrl", value),
    setRequesterName: (value: string) => setField("requesterName", value),
    setUseCase: (value: string) => setField("useCase", value),
    setWebsite: (value: string) => setField("website", value),
    tokenCodeRef,
    tokenSecured,
    trimmedUseCaseLength,
    useCase: state.useCase,
    verificationError: state.verificationError,
    verificationStatus: state.verificationStatus,
    website: state.website,
  };
}
