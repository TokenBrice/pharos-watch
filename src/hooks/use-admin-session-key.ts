"use client";

import { useCallback, useState } from "react";

const SESSION_KEY = "pharos-admin-key";

export function useAdminSessionKey() {
  const [adminKey, setAdminKey] = useState(() => {
    if (typeof window === "undefined") return "";
    return sessionStorage.getItem(SESSION_KEY) ?? "";
  });

  const handleKeySubmit = useCallback((key: string) => {
    sessionStorage.setItem(SESSION_KEY, key);
    setAdminKey(key);
  }, []);

  const handleSignOut = useCallback(() => {
    sessionStorage.removeItem(SESSION_KEY);
    setAdminKey("");
  }, []);

  return {
    adminKey,
    handleKeySubmit,
    handleSignOut,
  };
}
