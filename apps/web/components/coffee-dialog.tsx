"use client";

import React, { useState, type FormEvent } from "react";
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

export function CoffeeDialog(props: CoffeeDialogProps) {
  const [coffeeDraft, setCoffeeDraft] =
    useState<CoffeeFormDraft>(initialCoffeeDraft);
  const [bagDraft, setBagDraft] = useState<BagFormDraft>(initialBagDraft);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const coffeeResult = parseCoffeeForm(coffeeDraft);
  const bagResult = parseBagForm(bagDraft);
  const parseError =
    props.mode === "coffee" && !coffeeResult.valid
      ? coffeeResult
      : !bagResult.valid
        ? bagResult
        : undefined;
  const valid =
    props.mode === "coffee"
      ? coffeeResult.valid && bagResult.valid
      : bagResult.valid;

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
    <div
      className="fixed inset-0 z-50 flex items-end bg-ink/35 sm:items-center sm:justify-center sm:p-5"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) props.onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="coffee-dialog-title"
        className="max-h-[92dvh] w-full overflow-y-auto rounded-t-lg bg-white p-5 sm:max-w-2xl sm:rounded-lg"
      >
        <div className="mb-5 flex items-center gap-3">
          {props.mode === "coffee" ? (
            <CoffeeIcon className="h-5 w-5 text-leaf" />
          ) : (
            <PackagePlus className="h-5 w-5 text-leaf" />
          )}
          <div>
            <h2 id="coffee-dialog-title" className="text-lg font-black">
              {props.mode === "coffee" ? "Add Coffee" : "Add Another Bag"}
            </h2>
            {props.mode === "bag" && (
              <p className="text-sm text-muted">{props.coffee.name}</p>
            )}
          </div>
        </div>

        <form onSubmit={(event) => void submit(event)}>
          {props.mode === "coffee" && (
            <fieldset className="mb-6">
              <legend className="mb-3 font-bold">Coffee details</legend>
              <div className="grid gap-x-3 sm:grid-cols-2">
                <TextField
                  name="name"
                  label="Coffee name"
                  value={coffeeDraft.name}
                  onChange={(value) => updateCoffee("name", value)}
                  required
                  autoFocus
                />
                <TextField
                  name="roaster"
                  label="Roaster"
                  value={coffeeDraft.roaster}
                  onChange={(value) => updateCoffee("roaster", value)}
                  required
                />
                <TextField
                  name="originCountry"
                  label="Origin country"
                  value={coffeeDraft.originCountry}
                  onChange={(value) => updateCoffee("originCountry", value)}
                />
                <TextField
                  name="originRegion"
                  label="Origin region"
                  value={coffeeDraft.originRegion}
                  onChange={(value) => updateCoffee("originRegion", value)}
                />
                <TextField
                  name="producer"
                  label="Producer"
                  value={coffeeDraft.producer}
                  onChange={(value) => updateCoffee("producer", value)}
                />
                <TextField
                  name="process"
                  label="Process"
                  value={coffeeDraft.process}
                  onChange={(value) => updateCoffee("process", value)}
                />
                <TextField
                  name="varietal"
                  label="Varietal"
                  value={coffeeDraft.varietal}
                  onChange={(value) => updateCoffee("varietal", value)}
                />
                <TextField
                  name="elevationMeters"
                  label="Elevation (meters)"
                  value={coffeeDraft.elevationMeters}
                  onChange={(value) => updateCoffee("elevationMeters", value)}
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
                    value={coffeeDraft.roastLevel}
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
                </label>
              </div>
              <TextAreaField
                name="notes"
                label="Coffee notes"
                value={coffeeDraft.notes}
                onChange={(value) => updateCoffee("notes", value)}
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
                type="date"
                autoFocus={props.mode === "bag"}
              />
              <TextField
                name="purchasedOn"
                label="Purchase date"
                value={bagDraft.purchasedOn}
                onChange={(value) => updateBag("purchasedOn", value)}
                type="date"
              />
              <TextField
                name="openedOn"
                label="Opened date"
                value={bagDraft.openedOn}
                onChange={(value) => updateBag("openedOn", value)}
                type="date"
              />
              <TextField
                name="startingWeightGrams"
                label="Starting weight (grams)"
                value={bagDraft.startingWeightGrams}
                onChange={(value) => updateBag("startingWeightGrams", value)}
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
            />
          </fieldset>

          {(parseError || saveError) && (
            <p className="mt-3 text-sm font-semibold text-coral" role="alert">
              {saveError ?? parseError?.message}
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
      </section>
    </div>
  );
}

function TextField({
  name,
  label,
  value,
  onChange,
  type = "text",
  ...inputProps
}: {
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "number" | "date";
  required?: boolean;
  autoFocus?: boolean;
  min?: string;
  max?: string;
  step?: string;
}) {
  return (
    <label className="mb-4">
      <span className="label">{label}</span>
      <input
        {...inputProps}
        name={name}
        type={type}
        className="field"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function TextAreaField({
  name,
  label,
  value,
  onChange,
}: {
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <span className="label">{label}</span>
      <textarea
        name={name}
        className="field min-h-24 py-3"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
