export const ANONYMOUS_TRANSFER_SOURCE_MARKER_KEY = "anonymous-transfer-source";
export const ANONYMOUS_TRANSFER_JOURNAL_KEY = "anonymous-transfer-journal";
export const ANONYMOUS_TRANSFER_DISMISSED_KEY = "anonymous-transfer-dismissed";

export interface AnonymousTransferJournal {
  version: 1;
  destinationOwnerId: string;
  phase: "staged";
  operationIds: string[];
  acknowledgedOperationIds: string[];
  startedAt: string;
}

export class AnonymousTransferStateError extends Error {
  constructor() {
    super("Anonymous transfer state is inconsistent; local data was preserved");
    this.name = "AnonymousTransferStateError";
  }
}

const journalKeys = new Set([
  "version",
  "destinationOwnerId",
  "phase",
  "operationIds",
  "acknowledgedOperationIds",
  "startedAt",
]);

function failStateValidation(): never {
  throw new AnonymousTransferStateError();
}

function isUniqueNonemptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.length > 0) &&
    new Set(value).size === value.length
  );
}

export function parseBoundAnonymousTransferJournal(
  value: string,
  destinationOwnerId: string,
  sourceDestinationOwnerId: string | undefined,
): AnonymousTransferJournal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    failStateValidation();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    failStateValidation();
  }
  const journal = parsed as Record<string, unknown>;
  const keys = Object.keys(journal);
  if (
    keys.length !== journalKeys.size ||
    keys.some((key) => !journalKeys.has(key)) ||
    journal.version !== 1 ||
    journal.phase !== "staged" ||
    journal.destinationOwnerId !== destinationOwnerId ||
    sourceDestinationOwnerId !== destinationOwnerId ||
    !isUniqueNonemptyStringArray(journal.operationIds) ||
    !isUniqueNonemptyStringArray(journal.acknowledgedOperationIds) ||
    typeof journal.startedAt !== "string" ||
    Number.isNaN(Date.parse(journal.startedAt))
  ) {
    failStateValidation();
  }
  const operationIds = new Set(journal.operationIds);
  if (
    journal.acknowledgedOperationIds.some(
      (operationId) => !operationIds.has(operationId),
    )
  ) {
    failStateValidation();
  }
  return journal as unknown as AnonymousTransferJournal;
}
