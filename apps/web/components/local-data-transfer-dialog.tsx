"use client";

import React, { useEffect, useRef } from "react";
import { ArrowRight, LoaderCircle } from "lucide-react";
import type { AnonymousTransferSummary } from "@/lib/anonymous-transfer";
import type { AnonymousTransferRecovery } from "@/lib/anonymous-transfer-ui";

export interface LocalDataTransferDialogProps {
  summary: AnonymousTransferSummary;
  status: "offering" | "moving" | "error";
  error?: string;
  onMove: () => void;
  onNotNow: () => void;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}

export function LocalDataTransferRecoveryNotice({
  recovery,
  onRetry,
}: {
  recovery: AnonymousTransferRecovery;
  onRetry: (summary: AnonymousTransferSummary) => void;
}) {
  return (
    <div
      role="alert"
      className="border-t border-coral/25 bg-coral/5 p-4 text-sm text-coral"
    >
      <p className="font-bold">Local data move needs recovery</p>
      <p className="mt-1">{recovery.message}</p>
      <p className="mt-1">
        {describeAnonymousTransferSummary(recovery.summary)} will be included
        when you retry.
      </p>
      <button
        type="button"
        className="button-secondary mt-3"
        onClick={() => onRetry(recovery.summary)}
      >
        Retry local data move
      </button>
    </div>
  );
}

interface ModalElement {
  open: boolean;
  showModal: () => void;
  close: () => void;
}

interface FocusTarget {
  isConnected: boolean;
  focus: () => void;
}

export function selectTransferFocusRestoreTarget<T extends FocusTarget>(
  activeTarget: T | null | undefined,
  bodyTarget: FocusTarget,
): T | undefined {
  return activeTarget?.isConnected && activeTarget !== bodyTarget
    ? activeTarget
    : undefined;
}

export function activateTransferModalLifecycle(
  dialog: ModalElement,
  primaryTarget?: FocusTarget | null,
  restoreTarget?: FocusTarget | null,
  getFallbackTarget?: () => FocusTarget | null | undefined,
): () => void {
  if (!dialog.open) dialog.showModal();
  primaryTarget?.focus();
  return () => {
    if (dialog.open) dialog.close();
    const target = restoreTarget?.isConnected
      ? restoreTarget
      : getFallbackTarget?.();
    if (target?.isConnected) target.focus();
  };
}

export function handleTransferModalCancel(
  event: { preventDefault: () => void },
  moving: boolean,
  onNotNow: () => void,
): void {
  event.preventDefault();
  if (!moving) onNotNow();
}

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function describeAnonymousTransferSummary(
  summary: AnonymousTransferSummary,
): string {
  const counts = [
    summary.brews ? plural(summary.brews, "shot") : undefined,
    summary.coffees ? plural(summary.coffees, "coffee", "coffees") : undefined,
    summary.bags ? plural(summary.bags, "bag") : undefined,
    summary.machines ? plural(summary.machines, "machine") : undefined,
    summary.grinders ? plural(summary.grinders, "grinder") : undefined,
  ].filter((item): item is string => item !== undefined);

  if (counts.length === 0) return "Local data";
  if (counts.length === 1) return counts[0]!;
  if (counts.length === 2) return `${counts[0]} and ${counts[1]}`;
  return `${counts.slice(0, -1).join(", ")}, and ${counts.at(-1)}`;
}

export function LocalDataTransferDialog({
  summary,
  status,
  error,
  onMove,
  onNotNow,
  returnFocusRef,
}: LocalDataTransferDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const primaryActionRef = useRef<HTMLButtonElement>(null);
  const moving = status === "moving";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const activeTarget =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    const restoreTarget = selectTransferFocusRestoreTarget(
      activeTarget,
      document.body,
    );
    return activateTransferModalLifecycle(
      dialog,
      primaryActionRef.current,
      restoreTarget,
      () => returnFocusRef?.current,
    );
  }, [returnFocusRef]);

  return (
    <dialog
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="local-data-transfer-title"
      aria-describedby="local-data-transfer-description"
      className="fixed inset-x-0 bottom-0 top-auto z-50 m-0 w-full max-w-none rounded-t-lg border-0 bg-white p-5 text-ink shadow-panel backdrop:bg-ink/35 sm:inset-0 sm:m-auto sm:max-w-md sm:rounded-lg"
      onCancel={(event) => handleTransferModalCancel(event, moving, onNotNow)}
    >
      <h2 id="local-data-transfer-title" className="text-xl font-black">
        Move local data?
      </h2>
      <p
        id="local-data-transfer-description"
        className="mt-2 text-sm leading-relaxed text-muted"
      >
        {describeAnonymousTransferSummary(summary)} from local mode can be moved
        to this account. Nothing is removed from local mode until the move is
        safely synced.
      </p>

      {moving && (
        <p
          role="status"
          className="mt-4 flex items-center gap-2 rounded-md bg-canvas p-3 text-sm font-semibold"
        >
          <LoaderCircle className="h-4 w-4 animate-spin text-leaf" />
          Moving local data… Keep this window open.
        </p>
      )}
      {status === "error" && error && (
        <p
          role="alert"
          className="mt-4 rounded-md border border-coral/25 bg-coral/5 p-3 text-sm text-coral"
        >
          {error}
        </p>
      )}

      <div className="mt-6 grid grid-cols-2 gap-3">
        <button
          type="button"
          className="button-secondary"
          disabled={moving}
          onClick={onNotNow}
        >
          Not now
        </button>
        <button
          ref={primaryActionRef}
          type="button"
          className="button-primary"
          disabled={moving}
          onClick={onMove}
        >
          {moving ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <ArrowRight className="h-4 w-4" />
          )}
          {status === "error" ? "Retry move" : "Move data"}
        </button>
      </div>
    </dialog>
  );
}
