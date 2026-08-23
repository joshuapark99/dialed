"use client";

import React, { useEffect, useRef, useState, type FormEvent } from "react";
import { Coffee as CoffeeIcon, PackagePlus } from "lucide-react";
import { makeId, saveCoffeeBag, saveCoffeeWithBag } from "../lib/db";
import {
  parseBagForm,
  parseCoffeeForm,
  type BagFormDraft,
  type CoffeeFormDraft,
} from "../lib/coffee-form";
import type { Coffee, CoffeeRoastLevel } from "../lib/models";

export type CoffeeDialogProps =
  | { mode: "coffee"; ownerId: string; onClose: () => void }
  | { mode: "bag"; ownerId: string; coffee: Coffee; onClose: () => void };

const initialCoffeeDraft: CoffeeFormDraft = {
  name: "",
  roaster: "",
  originCountry: "",
  originRegion: "",
  producer: "",
  process: "",
  varietal: "",
  elevationMeters: "",
  roastLevel: "unknown",
  notes: "",
};

const initialBagDraft: BagFormDraft = {
  roastedOn: "",
  purchasedOn: "",
  openedOn: "",
  startingWeightGrams: "",
  notes: "",
};

const roastOptions: ReadonlyArray<{
  value: CoffeeRoastLevel;
  label: string;
}> = [
  { value: "unknown", label: "Not specified" },
  { value: "light", label: "Light" },
  { value: "medium-light", label: "Medium-light" },
  { value: "medium", label: "Medium" },
  { value: "medium-dark", label: "Medium-dark" },
  { value: "dark", label: "Dark" },
];

export interface ModalElement {
  open: boolean;
  showModal: () => void;
  close: () => void;
}

export interface FocusTarget {
  focus: () => void;
}

export function activateModalLifecycle(
  dialog: ModalElement,
  restoreTarget?: FocusTarget | null,
): () => void {
  if (!dialog.open) dialog.showModal();
  return () => {
    if (dialog.open) dialog.close();
    restoreTarget?.focus();
  };
}

export function handleModalCancel(
  event: { preventDefault: () => void },
  saving: boolean,
  onClose: () => void,
): void {
  event.preventDefault();
  if (!saving) onClose();
}

export interface ScopedFieldError {
  scope: "coffee" | "bag";
  field: string;
  message: string;
}

export interface VisibleFieldError extends ScopedFieldError {
  id: string;
}

export function selectVisibleFieldError(
  error: ScopedFieldError | undefined,
  touchedFields: ReadonlySet<string>,
): VisibleFieldError | undefined {
  if (!error || !touchedFields.has(`${error.scope}.${error.field}`))
    return undefined;
  return { ...error, id: `${error.scope}-${error.field}-error` };
}

export function CoffeeDialog(props: CoffeeDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = `coffee-dialog-${props.mode}-title`;
  const [coffeeDraft, setCoffeeDraft] =
    useState<CoffeeFormDraft>(initialCoffeeDraft);
  const [bagDraft, setBagDraft] = useState<BagFormDraft>(initialBagDraft);
  const [touchedFields, setTouchedFields] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const coffeeResult = parseCoffeeForm(coffeeDraft);
  const bagResult = parseBagForm(bagDraft);
  const parseError: ScopedFieldError | undefined =
    props.mode === "coffee" && !coffeeResult.valid
      ? { ...coffeeResult, scope: "coffee" }
      : !bagResult.valid
        ? { ...bagResult, scope: "bag" }
        : undefined;
  const visibleFieldError = selectVisibleFieldError(parseError, touchedFields);
  const valid =
    props.mode === "coffee"
      ? coffeeResult.valid && bagResult.valid
      : bagResult.valid;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const restoreTarget =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    return activateModalLifecycle(dialog, restoreTarget);
  }, []);

  function touch(scope: ScopedFieldError["scope"], field: string) {
    setTouchedFields((current) => {
      const next = new Set(current);
      next.add(`${scope}.${field}`);
      return next;
    });
  }

  function errorFor(
    scope: ScopedFieldError["scope"],
    field: string,
  ): VisibleFieldError | undefined {
    return visibleFieldError?.scope === scope &&
      visibleFieldError.field === field
      ? visibleFieldError
      : undefined;
  }

  function updateCoffee<Field extends keyof CoffeeFormDraft>(
    field: Field,
    value: CoffeeFormDraft[Field],
  ) {
    setCoffeeDraft((current) => ({ ...current, [field]: value }));
  }

  function updateBag<Field extends keyof BagFormDraft>(
    field: Field,
    value: BagFormDraft[Field],
  ) {
    setBagDraft((current) => ({ ...current, [field]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid || saving || !bagResult.valid) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      const createdAt = new Date().toISOString();
      if (props.mode === "coffee" && coffeeResult.valid) {
        const coffeeId = makeId();
        await saveCoffeeWithBag(
          props.ownerId,
          { id: coffeeId, ...coffeeResult.value, createdAt },
          {
            id: makeId(),
            coffeeId,
            ...bagResult.value,
            createdAt,
          },
        );
      } else if (props.mode === "bag") {
        await saveCoffeeBag(props.ownerId, {
          id: makeId(),
          coffeeId: props.coffee.id,
          ...bagResult.value,
          createdAt,
        });
      }
      props.onClose();
    } catch {
      setSaveError("Could not save. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-x-0 bottom-0 top-auto z-50 m-0 max-h-[92dvh] w-full max-w-none overflow-y-auto rounded-t-lg border-0 bg-white p-5 text-ink shadow-panel backdrop:bg-ink/35 sm:inset-0 sm:m-auto sm:max-w-2xl sm:rounded-lg"
      onCancel={(event) => handleModalCancel(event, saving, props.onClose)}
    >
      <div className="mb-5 flex items-center gap-3">
        {props.mode === "coffee" ? (
          <CoffeeIcon className="h-5 w-5 text-leaf" />
        ) : (
          <PackagePlus className="h-5 w-5 text-leaf" />
        )}
        <div>
          <h2 id={titleId} className="text-lg font-black">
            {props.mode === "coffee" ? "Add coffee" : "Add another bag"}
          </h2>
          {props.mode === "bag" && (
            <p className="text-sm text-muted">{props.coffee.name}</p>
          )}
        </div>
      </div>

      <form noValidate onSubmit={(event) => void submit(event)}>
        {props.mode === "coffee" && (
          <fieldset className="mb-6">
            <legend className="mb-3 font-bold">Coffee details</legend>
            <div className="grid gap-x-3 sm:grid-cols-2">
              <TextField
                name="name"
                label="Coffee name"
                value={coffeeDraft.name}
                onChange={(value) => updateCoffee("name", value)}
                onBlur={() => touch("coffee", "name")}
                error={errorFor("coffee", "name")}
                autoFocus={props.mode === "coffee"}
                required
              />
              <TextField
                name="roaster"
                label="Roaster"
                value={coffeeDraft.roaster}
                onChange={(value) => updateCoffee("roaster", value)}
                onBlur={() => touch("coffee", "roaster")}
                error={errorFor("coffee", "roaster")}
                required
              />
              <TextField
                name="originCountry"
                label="Origin country"
                value={coffeeDraft.originCountry}
                onChange={(value) => updateCoffee("originCountry", value)}
                onBlur={() => touch("coffee", "originCountry")}
                error={errorFor("coffee", "originCountry")}
              />
              <TextField
                name="originRegion"
                label="Origin region"
                value={coffeeDraft.originRegion}
                onChange={(value) => updateCoffee("originRegion", value)}
                onBlur={() => touch("coffee", "originRegion")}
                error={errorFor("coffee", "originRegion")}
              />
              <TextField
                name="producer"
                label="Producer"
                value={coffeeDraft.producer}
                onChange={(value) => updateCoffee("producer", value)}
                onBlur={() => touch("coffee", "producer")}
                error={errorFor("coffee", "producer")}
              />
              <TextField
                name="process"
                label="Process"
                value={coffeeDraft.process}
                onChange={(value) => updateCoffee("process", value)}
                onBlur={() => touch("coffee", "process")}
                error={errorFor("coffee", "process")}
              />
              <TextField
                name="varietal"
                label="Varietal"
                value={coffeeDraft.varietal}
                onChange={(value) => updateCoffee("varietal", value)}
                onBlur={() => touch("coffee", "varietal")}
                error={errorFor("coffee", "varietal")}
              />
              <TextField
                name="elevationMeters"
                label="Elevation (meters)"
                value={coffeeDraft.elevationMeters}
                onChange={(value) => updateCoffee("elevationMeters", value)}
                onBlur={() => touch("coffee", "elevationMeters")}
                error={errorFor("coffee", "elevationMeters")}
                type="number"
                min="1"
                max="9000"
                step="1"
              />
              <label className="mb-4">
                <span className="label">Roast level</span>
                <select
                  name="roastLevel"
                  className="field"
                  aria-invalid={
                    errorFor("coffee", "roastLevel") ? true : undefined
                  }
                  aria-describedby={errorFor("coffee", "roastLevel")?.id}
                  value={coffeeDraft.roastLevel}
                  onBlur={() => touch("coffee", "roastLevel")}
                  onChange={(event) =>
                    updateCoffee(
                      "roastLevel",
                      event.target.value as CoffeeRoastLevel,
                    )
                  }
                >
                  {roastOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <FieldErrorMessage error={errorFor("coffee", "roastLevel")} />
              </label>
            </div>
            <TextAreaField
              name="notes"
              label="Coffee notes"
              value={coffeeDraft.notes}
              onChange={(value) => updateCoffee("notes", value)}
              onBlur={() => touch("coffee", "notes")}
              error={errorFor("coffee", "notes")}
            />
          </fieldset>
        )}

        <fieldset>
          <legend className="mb-3 font-bold">
            {props.mode === "coffee" ? "First bag" : "Bag details"}
          </legend>
          <div className="grid gap-x-3 sm:grid-cols-2">
            <TextField
              name="roastedOn"
              label="Roast date"
              value={bagDraft.roastedOn}
              onChange={(value) => updateBag("roastedOn", value)}
              onBlur={() => touch("bag", "roastedOn")}
              error={errorFor("bag", "roastedOn")}
              autoFocus={props.mode === "bag"}
              type="date"
            />
            <TextField
              name="purchasedOn"
              label="Purchase date"
              value={bagDraft.purchasedOn}
              onChange={(value) => updateBag("purchasedOn", value)}
              onBlur={() => touch("bag", "purchasedOn")}
              error={errorFor("bag", "purchasedOn")}
              type="date"
            />
            <TextField
              name="openedOn"
              label="Opened date"
              value={bagDraft.openedOn}
              onChange={(value) => updateBag("openedOn", value)}
              onBlur={() => touch("bag", "openedOn")}
              error={errorFor("bag", "openedOn")}
              type="date"
            />
            <TextField
              name="startingWeightGrams"
              label="Starting weight (grams)"
              value={bagDraft.startingWeightGrams}
              onChange={(value) => updateBag("startingWeightGrams", value)}
              onBlur={() => touch("bag", "startingWeightGrams")}
              error={errorFor("bag", "startingWeightGrams")}
              type="number"
              min="0"
              max="100000"
              step="any"
            />
          </div>
          <TextAreaField
            name="notes"
            label="Bag notes"
            value={bagDraft.notes}
            onChange={(value) => updateBag("notes", value)}
            onBlur={() => touch("bag", "notes")}
            error={errorFor("bag", "notes")}
          />
        </fieldset>

        {saveError && (
          <p className="mt-3 text-sm font-semibold text-coral" role="alert">
            {saveError}
          </p>
        )}
        <div className="mt-6 grid grid-cols-2 gap-3">
          <button
            className="button-secondary"
            type="button"
            onClick={props.onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            className="button-primary"
            type="submit"
            disabled={!valid || saving}
          >
            {saving
              ? "Saving…"
              : props.mode === "coffee"
                ? "Save coffee"
                : "Save bag"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function TextField({
  name,
  label,
  value,
  onChange,
  onBlur,
  error,
  type = "text",
  ...inputProps
}: {
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  error?: VisibleFieldError;
  type?: "text" | "number" | "date";
  required?: boolean;
  min?: string;
  max?: string;
  step?: string;
  autoFocus?: boolean;
}) {
  return (
    <label className="mb-4">
      <span className="label">{label}</span>
      <input
        {...inputProps}
        name={name}
        type={type}
        className="field"
        aria-invalid={error ? true : undefined}
        aria-describedby={error?.id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
      />
      <FieldErrorMessage error={error} />
    </label>
  );
}

function TextAreaField({
  name,
  label,
  value,
  onChange,
  onBlur,
  error,
}: {
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  error?: VisibleFieldError;
}) {
  return (
    <label>
      <span className="label">{label}</span>
      <textarea
        name={name}
        className="field min-h-24 py-3"
        aria-invalid={error ? true : undefined}
        aria-describedby={error?.id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
      />
      <FieldErrorMessage error={error} />
    </label>
  );
}

function FieldErrorMessage({ error }: { error?: VisibleFieldError }) {
  if (!error) return null;
  return (
    <span
      id={error.id}
      className="mt-1 block text-sm font-semibold text-coral"
      role="alert"
    >
      {error.message}
    </span>
  );
}
