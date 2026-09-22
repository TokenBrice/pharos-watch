"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { AdminActionExecutionDialog } from "@/components/status/admin-action-execution-dialog";
import type {
  AdminActionDialogRequest,
  AdminActionDialogState,
  AdminActionExecution,
  AdminActionExecutionController,
  AdminActionExecutionRequest,
  AdminMutationExecution,
} from "@/components/status/admin-action-execution-types";
import {
  createAdminMutationIdempotencyKey,
  useAdminMutationController,
} from "@/components/status/admin-mutation-intent";
import { focusElement } from "@/lib/focus-element";
export type {
  AdminActionDialogRequest,
  AdminActionDialogState,
  AdminActionExecution,
  AdminActionExecutionController,
  AdminActionExecutionRequest,
  AdminActionReadinessSource,
} from "@/components/status/admin-action-execution-types";

interface AdminActionExecutionContextValue extends AdminActionExecutionController {
  openDialog: (request: AdminActionDialogRequest) => void;
}

const AdminActionExecutionContext = createContext<AdminActionExecutionContextValue | null>(null);

function getAdminActionExecutionKey(request: AdminActionExecutionRequest): string {
  return `${request.action.path}\u0000${request.scopeKey}`;
}

function getAdminActionMutationRequest(request: AdminActionExecutionRequest) {
  return {
    path: request.requestPath,
    method: request.requestMethod,
  };
}

function decorateAdminActionExecution(
  execution: AdminMutationExecution<AdminActionExecutionRequest>,
  request: AdminActionExecutionRequest,
): AdminActionExecution {
  return {
    ...execution,
    action: request.action,
    executionKey: execution.laneKey,
    requestPath: request.requestPath,
    requestMethod: request.requestMethod,
    scopeKey: request.scopeKey,
    scopeLabel: request.scopeLabel,
  };
}

export function AdminActionExecutionProvider({
  children,
  createIdempotencyKey = createAdminMutationIdempotencyKey,
}: {
  children: ReactNode;
  createIdempotencyKey?: () => string;
}) {
  const controller = useAdminMutationController<AdminActionExecutionRequest, AdminActionExecution>({
    getLaneKey: getAdminActionExecutionKey,
    getMutationRequest: getAdminActionMutationRequest,
    decorateExecution: decorateAdminActionExecution,
    createIdempotencyKey,
  });
  const nextDialogIdRef = useRef(0);
  const [dialogRequest, setDialogRequest] = useState<AdminActionDialogState | null>(null);

  const openDialog = useCallback((request: AdminActionDialogRequest) => {
    nextDialogIdRef.current += 1;
    setDialogRequest({ ...request, dialogId: nextDialogIdRef.current });
  }, []);

  const value = useMemo<AdminActionExecutionContextValue>(
    () => ({
      current: controller.current,
      executions: controller.executions,
      execute: controller.runCurrentOrCreate,
      retry: controller.retrySame,
      startNew: controller.startNew,
      openDialog,
    }),
    [controller, openDialog],
  );

  return (
    <AdminActionExecutionContext.Provider value={value}>
      {children}
      {dialogRequest && (
        <AdminActionExecutionDialog
          key={dialogRequest.dialogId}
          request={dialogRequest}
          controller={value}
          onClose={() => {
            const returnFocus = dialogRequest.returnFocus;
            setDialogRequest(null);
            focusElement(returnFocus);
          }}
        />
      )}
    </AdminActionExecutionContext.Provider>
  );
}

function useAdminActionExecutionContext(): AdminActionExecutionContextValue {
  const context = useContext(AdminActionExecutionContext);
  if (!context) {
    throw new Error("Admin action controls must be rendered inside AdminActionExecutionProvider");
  }
  return context;
}

export function useAdminActionExecutions(): readonly AdminActionExecution[] {
  return useAdminActionExecutionContext().executions;
}

export function useAdminActionDialog(actionPath: string) {
  const context = useAdminActionExecutionContext();
  return {
    execution: context.executions.find((candidate) => candidate.action.path === actionPath),
    openDialog: context.openDialog,
  };
}
