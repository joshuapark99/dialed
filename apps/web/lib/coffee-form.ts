import type { Coffee, CoffeeBag, CoffeeRoastLevel } from "./models";

export type FormParseResult<T> =
  { valid: true; value: T } | { valid: false; field: string; message: string };

export interface CoffeeFormDraft {
  name: string;
  roaster: string;
  originCountry: string;
  originRegion: string;
  producer: string;
  process: string;
  varietal: string;
  elevationMeters: string;
  roastLevel: CoffeeRoastLevel;
  notes: string;
}

export interface BagFormDraft {
  roastedOn: string;
  purchasedOn: string;
  openedOn: string;
  startingWeightGrams: string;
  notes: string;
}

export type CoffeeFormValue = Omit<Coffee, "id" | "createdAt">;
export type BagFormValue = Omit<CoffeeBag, "id" | "coffeeId" | "createdAt">;

const roastLevels: ReadonlySet<CoffeeRoastLevel> = new Set([
  "light",
  "medium-light",
  "medium",
  "medium-dark",
  "dark",
  "unknown",
]);

export function parseCoffeeForm(
  draft: CoffeeFormDraft,
): FormParseResult<CoffeeFormValue> {
  const name = draft.name.trim();
  if (!name) return invalid("name", "Coffee name is required");
  if (name.length > 120)
    return invalid("name", "Coffee name must be 120 characters or fewer");

  const roaster = draft.roaster.trim();
  if (!roaster) return invalid("roaster", "Roaster is required");
  if (roaster.length > 120)
    return invalid("roaster", "Roaster must be 120 characters or fewer");

  if (!roastLevels.has(draft.roastLevel))
    return invalid("roastLevel", "Choose a valid roast level");

  const originCountry = optionalText(draft.originCountry, 120);
  if (!originCountry.valid)
    return invalid(
      "originCountry",
      "Origin country must be 120 characters or fewer",
    );
  const originRegion = optionalText(draft.originRegion, 120);
  if (!originRegion.valid)
    return invalid(
      "originRegion",
      "Origin region must be 120 characters or fewer",
    );
  const producer = optionalText(draft.producer, 240);
  if (!producer.valid)
    return invalid("producer", "Producer must be 240 characters or fewer");
  const process = optionalText(draft.process, 120);
  if (!process.valid)
    return invalid("process", "Process must be 120 characters or fewer");
  const varietal = optionalText(draft.varietal, 240);
  if (!varietal.valid)
    return invalid("varietal", "Varietal must be 240 characters or fewer");
  const notes = optionalText(draft.notes, 2_000);
  if (!notes.valid)
    return invalid("notes", "Coffee notes must be 2,000 characters or fewer");

  const elevationMeters = optionalNumber(draft.elevationMeters, {
    minimum: 1,
    maximum: 9_000,
    integer: true,
  });
  if (!elevationMeters.valid)
    return invalid(
      "elevationMeters",
      "Elevation must be a whole number from 1 to 9,000 meters",
    );

  return {
    valid: true,
    value: compact({
      name,
      roaster,
      originCountry: originCountry.value,
      originRegion: originRegion.value,
      producer: producer.value,
      process: process.value,
      varietal: varietal.value,
      elevationMeters: elevationMeters.value,
      roastLevel: draft.roastLevel,
      notes: notes.value,
    }),
  };
}

export function parseBagForm(
  draft: BagFormDraft,
): FormParseResult<BagFormValue> {
  const roastedOn = blankToUndefined(draft.roastedOn);
  const purchasedOn = blankToUndefined(draft.purchasedOn);
  const openedOn = blankToUndefined(draft.openedOn);
  const dates = [
    ["roastedOn", roastedOn, "Roast date"],
    ["purchasedOn", purchasedOn, "Purchase date"],
    ["openedOn", openedOn, "Opened date"],
  ] as const;

  for (const [field, input, label] of dates) {
    if (input !== undefined && !calendarDate(input))
      return invalid(field, `${label} must be a valid date`);
  }

  const startingWeightGrams = optionalNumber(draft.startingWeightGrams, {
    minimum: Number.MIN_VALUE,
    maximum: 100_000,
  });
  if (!startingWeightGrams.valid)
    return invalid(
      "startingWeightGrams",
      "Starting weight must be greater than 0 and at most 100,000 grams",
    );

  const notes = optionalText(draft.notes, 2_000);
  if (!notes.valid)
    return invalid("notes", "Bag notes must be 2,000 characters or fewer");

  return {
    valid: true,
    value: compact({
      roastedOn,
      purchasedOn,
      openedOn,
      startingWeightGrams: startingWeightGrams.value,
      notes: notes.value,
    }),
  };
}

export function formatBagLabel(bag: CoffeeBag, locale?: string): string {
  if (!bag.roastedOn) return "Roast date not set";
  const date = calendarDate(bag.roastedOn);
  if (!date) return "Roast date not set";
  return `Roasted ${new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date)}`;
}

function invalid(field: string, message: string) {
  return { valid: false, field, message } as const;
}

function optionalText(
  input: string,
  maximum: number,
): { valid: true; value?: string } | { valid: false } {
  const value = blankToUndefined(input);
  if (value === undefined) return { valid: true };
  return value.length <= maximum ? { valid: true, value } : { valid: false };
}

function blankToUndefined(input: string): string | undefined {
  return input.trim() || undefined;
}

function optionalNumber(
  input: string,
  constraints: { minimum: number; maximum: number; integer?: boolean },
): { valid: true; value?: number } | { valid: false } {
  if (!input.trim()) return { valid: true };
  const value = Number(input);
  if (
    !Number.isFinite(value) ||
    value < constraints.minimum ||
    value > constraints.maximum ||
    (constraints.integer && !Number.isInteger(value))
  )
    return { valid: false };
  return { valid: true, value };
}

function calendarDate(input: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return undefined;
  return date;
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}
