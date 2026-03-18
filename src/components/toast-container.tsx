"use client";

import { CheckCircle, Info, AlertCircle, XCircle, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Toast, ToastType } from "@/hooks/use-toast";

interface ToastContainerProps {
  toasts: Toast[];
  removeToast: (id: string) => void;
}

const toastIcons: Record<ToastType, typeof Info> = {
  success: CheckCircle,
  info: Info,
  warning: AlertCircle,
  error: XCircle,
};

const toastStyles: Record<ToastType, string> = {
  success: "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400",
  info: "border-[var(--brand-accent)]/30 bg-[var(--brand-accent)]/10 text-foreground",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  error: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
};

function ToastItem({
  toast,
  onRemove,
  index,
}: {
  toast: Toast;
  onRemove: (id: string) => void;
  index: number;
}) {
  const Icon = toastIcons[toast.type];

  return (
    <div
      role="alert"
      className={cn(
        "pointer-events-auto flex w-full items-center gap-3 rounded-lg border px-4 py-3 shadow-lg",
        "animate-in slide-in-from-bottom-2 fade-in duration-200",
        "transition-all duration-200",
        toastStyles[toast.type]
      )}
      style={{
        animationDelay: `${index * 50}ms`,
      }}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <p className="flex-1 text-sm font-medium">{toast.message}</p>
      <button
        onClick={() => onRemove(toast.id)}
        className="shrink-0 rounded-md p-1 opacity-60 transition-opacity hover:opacity-100"
        aria-label="Dismiss notification"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function ToastContainer({ toasts, removeToast }: ToastContainerProps) {
  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2 p-4 sm:bottom-6 sm:right-6"
      aria-live="polite"
      aria-atomic="true"
    >
      {toasts.map((toast, index) => (
        <ToastItem
          key={toast.id}
          toast={toast}
          onRemove={removeToast}
          index={toasts.length - 1 - index}
        />
      ))}
    </div>
  );
}
