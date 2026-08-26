import {
  AnonymousTransferConflictError,
  AnonymousTransferStateError,
  AnonymousTransferSummaryChangedError,
  AnonymousTransferValidationError,
  type AnonymousTransferSummary,
} from "./anonymous-transfer";
import {
  OwnerMutationConflictError,
  OwnerMutationFenceLostError,
  OwnerMutationStateError,
  type OwnerMutationKind,
} from "./db";
import { CrossContextOwnerLockUnavailableError } from "./sync";

export interface AnonymousTransferRecovery {
  summary: AnonymousTransferSummary;
  message: string;
}

interface PendingAccountSyncObservation {
  authenticated: boolean;
  ready: boolean;
  online: boolean;
  transferInFlight: boolean;
  pendingCount: number;
}

export class PendingAccountSyncScheduler {
  private previousEligibleCount: number | undefined;
  private deferredPositiveWork = false;

  observe(observation: PendingAccountSyncObservation): boolean {
    const eligible =
      observation.authenticated &&
      observation.ready &&
      observation.online &&
      !observation.transferInFlight;
    if (!eligible) {
      if (observation.pendingCount > 0) this.deferredPositiveWork = true;
      return false;
    }

    const shouldSynchronize = this.deferredPositiveWork
      ? observation.pendingCount > 0
      : this.previousEligibleCount !== undefined &&
        observation.pendingCount > this.previousEligibleCount;
    this.deferredPositiveWork = false;
    this.previousEligibleCount = observation.pendingCount;
    return shouldSynchronize;
  }
}

interface TransferDiscoveryTicket {
  ownerId: string;
  generation: number;
}

export class TransferDiscoveryGuard {
  private generation = 0;
  private transferInFlight = false;

  constructor(private ownerId: string) {}

  beginDiscovery(): TransferDiscoveryTicket {
    return { ownerId: this.ownerId, generation: ++this.generation };
  }

  beginTransfer(): void {
    this.transferInFlight = true;
    this.invalidate();
  }

  finishTransfer(): void {
    this.transferInFlight = false;
    this.invalidate();
  }

  invalidate(): void {
    this.generation += 1;
  }

  changeOwner(ownerId: string): void {
    this.ownerId = ownerId;
    this.transferInFlight = false;
    this.invalidate();
  }

  canCommit(ticket: TransferDiscoveryTicket, ownerId: string): boolean {
    return (
      !this.transferInFlight &&
      ticket.ownerId === this.ownerId &&
      ownerId === this.ownerId &&
      ticket.generation === this.generation
    );
  }
}

export function reconcileAnonymousTransferRecovery(
  recovery: AnonymousTransferRecovery | undefined,
  summary: AnonymousTransferSummary | undefined,
): AnonymousTransferRecovery | undefined {
  if (!recovery || !isCompleteAnonymousTransferSummary(summary)) {
    return recovery;
  }
  if (!summary.hasData) return undefined;
  if (recovery.summary === summary) return recovery;
  return { summary, message: recovery.message };
}

const anonymousTransferCountKeys = [
  "coffees",
  "bags",
  "machines",
  "grinders",
  "brews",
] as const;

function isCompleteAnonymousTransferSummary(
  summary: AnonymousTransferSummary | undefined,
): summary is AnonymousTransferSummary {
  if (!summary || typeof summary.hasData !== "boolean") return false;
  const counts = anonymousTransferCountKeys.map((key) => summary[key]);
  return (
    counts.every((count) => Number.isSafeInteger(count) && count >= 0) &&
    summary.hasData === counts.some((count) => count > 0)
  );
}

export function shouldPresentAnonymousTransferOffer(
  summary: AnonymousTransferSummary | null,
  recovery: AnonymousTransferRecovery | undefined,
): summary is AnonymousTransferSummary {
  return Boolean(summary && !recovery);
}

function ownerMutationLabel(kind: OwnerMutationKind): string {
  if (kind === "reset") return "local cache reset";
  if (kind === "delete") return "account deletion";
  return "local data move";
}

function productEntity(entity: string): string {
  return entity === "bean" ? "bag" : entity;
}

export function recoveryForAnonymousTransferError(
  error: unknown,
  attemptedSummary: AnonymousTransferSummary,
): AnonymousTransferRecovery {
  return {
    summary:
      error instanceof AnonymousTransferSummaryChangedError
        ? error.currentSummary
        : attemptedSummary,
    message: anonymousTransferErrorMessage(error),
  };
}

export async function runAnonymousTransferConsentAttempt(
  summary: AnonymousTransferSummary,
  move: (summary: AnonymousTransferSummary) => Promise<void>,
): Promise<
  { status: "moved" } | { status: "error"; recovery: AnonymousTransferRecovery }
> {
  try {
    await move(summary);
    return { status: "moved" };
  } catch (error) {
    return {
      status: "error",
      recovery: recoveryForAnonymousTransferError(error, summary),
    };
  }
}

export function anonymousTransferErrorMessage(error: unknown): string {
  const retry = " Local data was preserved. Select Retry move to try again.";
  if (error instanceof AnonymousTransferSummaryChangedError) {
    return error.message;
  }
  if (error instanceof OwnerMutationConflictError) {
    const operation = ownerMutationLabel(error.activeKind);
    const article = error.activeKind === "delete" ? "An" : "A";
    const retryOperation =
      error.activeKind === "reset" ? "cache reset" : operation;
    return `${article} ${operation} needs recovery before local data can be moved. Retry the ${retryOperation}, then select Retry move. Local data was preserved.`;
  }
  if (error instanceof OwnerMutationFenceLostError) {
    return "Another tab took over this local data move. Finish there, or select Retry move here after it stops. Local data was preserved.";
  }
  if (error instanceof OwnerMutationStateError) {
    return "Local account recovery state is inconsistent. Reload Dialed, then select Retry move. Local data was preserved.";
  }
  if (error instanceof AnonymousTransferStateError) {
    return "Local data move recovery state is inconsistent. Reload Dialed, then select Retry move. Local data was preserved.";
  }
  if (error instanceof CrossContextOwnerLockUnavailableError) {
    return "This browser cannot safely coordinate the local data move across tabs. Open Dialed in a browser with Web Locks support, then select Retry move. Local data was preserved.";
  }
  if (error instanceof AnonymousTransferConflictError) {
    return `Local ${productEntity(error.entity)} data conflicts with this account.${retry}`;
  }
  if (error instanceof AnonymousTransferValidationError) {
    return `Local ${productEntity(error.entity)} data is incomplete and could not be moved.${retry}`;
  }
  return `Dialed could not move local data. Check the connection and try again.${retry}`;
}
