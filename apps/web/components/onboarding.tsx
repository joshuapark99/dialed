"use client";

import React, { useState } from "react";
import { ArrowRight, Coffee, Gauge, RotateCw } from "lucide-react";
import {
  makeId,
  saveCoffeeWithBag,
  saveGrinder,
  saveMachine,
  setOwnerPreference,
} from "../lib/db";
import { parseBagForm, parseCoffeeForm } from "../lib/coffee-form";
import type { RoastLevel, TemperatureControl } from "../lib/models";
import { Brand, Segmented } from "./ui";

export interface OnboardingSetupDraft {
  coffeeName: string;
  roaster: string;
  roast: RoastLevel;
  roastedOn: string;
  machine: string;
  temperatureControl: TemperatureControl;
  grinder: string;
  finerDirection: "lower" | "higher";
}

export async function saveOnboardingSetup(
  ownerId: string,
  draft: OnboardingSetupDraft,
): Promise<void> {
  const coffeeResult = parseCoffeeForm({
    name: draft.coffeeName,
    roaster: draft.roaster,
    originCountry: "",
    originRegion: "",
    producer: "",
    process: "",
    varietal: "",
    elevationMeters: "",
    roastLevel: draft.roast,
    notes: "",
  });
  const bagResult = parseBagForm({
    roastedOn: draft.roastedOn,
    purchasedOn: "",
    openedOn: "",
    startingWeightGrams: "",
    notes: "",
  });
  if (!coffeeResult.valid) throw new Error(coffeeResult.message);
  if (!bagResult.valid) throw new Error(bagResult.message);

  const createdAt = new Date().toISOString();
  const coffeeId = makeId();
  await saveCoffeeWithBag(
    ownerId,
    { id: coffeeId, ...coffeeResult.value, createdAt },
    { id: makeId(), coffeeId, ...bagResult.value, createdAt },
  );
  await saveMachine(ownerId, {
    id: makeId(),
    name: draft.machine.trim(),
    temperatureControl: draft.temperatureControl,
    hasPressureControl: false,
    hasPreinfusion: false,
    createdAt,
  });
  await saveGrinder(ownerId, {
    id: makeId(),
    name: draft.grinder.trim(),
    finerDirection: draft.finerDirection,
    createdAt,
  });
  await setOwnerPreference(ownerId, "onboarded", "true");
}

export function Onboarding({ ownerId }: { ownerId: string }) {
  const [step, setStep] = useState(0);
  const [beanName, setBeanName] = useState("");
  const [roaster, setRoaster] = useState("");
  const [roast, setRoast] = useState<RoastLevel>("medium");
  const [roastedOn, setRoastedOn] = useState("");
  const [machine, setMachine] = useState("");
  const [temperatureControl, setTemperatureControl] =
    useState<TemperatureControl>("none");
  const [grinder, setGrinder] = useState("");
  const [finerDirection, setFinerDirection] = useState<"lower" | "higher">(
    "lower",
  );

  async function finish() {
    await saveOnboardingSetup(ownerId, {
      coffeeName: beanName,
      roaster,
      roast,
      roastedOn,
      machine,
      temperatureControl,
      grinder,
      finerDirection,
    });
  }

  const valid =
    step === 0
      ? beanName.trim() && roaster.trim()
      : step === 1
        ? machine.trim()
        : grinder.trim();
  const icons = [Coffee, Gauge, RotateCw];
  const Icon = icons[step];

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col px-5 pb-8 pt-[max(2rem,env(safe-area-inset-top))]">
      <div className="mb-10 flex items-center justify-between">
        <Brand />
        <span className="text-sm font-semibold text-muted">{step + 1} / 3</span>
      </div>
      <div className="mb-8 flex gap-1.5" aria-hidden>
        {[0, 1, 2].map((item) => (
          <span
            key={item}
            className={`h-1.5 flex-1 rounded-full ${item <= step ? "bg-coral" : "bg-line"}`}
          />
        ))}
      </div>
      <section className="view-enter flex-1" key={step}>
        <Icon className="mb-5 h-8 w-8 text-leaf" />
        {step === 0 && (
          <>
            <h1 className="text-3xl font-black">Start with your coffee</h1>
            <p className="mb-7 mt-2 text-muted">
              Recipes behave differently for every bean. Add the bag you're
              dialing in now.
            </p>
            <label className="label" htmlFor="bean">
              Coffee
            </label>
            <input
              id="bean"
              className="field mb-4"
              value={beanName}
              onChange={(e) => setBeanName(e.target.value)}
              placeholder="Hualalai Kona"
              autoFocus
            />
            <label className="label" htmlFor="roaster">
              Roaster
            </label>
            <input
              id="roaster"
              className="field mb-4"
              value={roaster}
              onChange={(e) => setRoaster(e.target.value)}
              placeholder="Coffee Purveyors"
            />
            <span className="label">Roast</span>
            <Segmented
              value={roast}
              onChange={setRoast}
              options={[
                { value: "light", label: "Light" },
                { value: "medium", label: "Medium" },
                { value: "dark", label: "Dark" },
              ]}
            />
            <label className="mt-4 block" htmlFor="roasted-on">
              <span className="label">Roast date (optional)</span>
              <input
                id="roasted-on"
                name="roastedOn"
                type="date"
                className="field"
                value={roastedOn}
                onChange={(event) => setRoastedOn(event.target.value)}
              />
            </label>
          </>
        )}
        {step === 1 && (
          <>
            <h1 className="text-3xl font-black">Add your machine</h1>
            <p className="mb-7 mt-2 text-muted">
              We'll only suggest controls your espresso machine actually has.
            </p>
            <label className="label" htmlFor="machine">
              Machine
            </label>
            <input
              id="machine"
              className="field mb-4"
              value={machine}
              onChange={(e) => setMachine(e.target.value)}
              placeholder="Gaggia Classic Pro E24"
              autoFocus
            />
            <span className="label">Temperature control</span>
            <Segmented
              columns={1}
              value={temperatureControl}
              onChange={setTemperatureControl}
              options={[
                { value: "none", label: "Thermostat / none" },
                { value: "relative", label: "Relative steps" },
                { value: "precise", label: "Precise temperature" },
              ]}
            />
          </>
        )}
        {step === 2 && (
          <>
            <h1 className="text-3xl font-black">Add your grinder</h1>
            <p className="mb-7 mt-2 text-muted">
              Grind numbers vary, so tell us how your adjustment moves.
            </p>
            <label className="label" htmlFor="grinder">
              Grinder
            </label>
            <input
              id="grinder"
              className="field mb-4"
              value={grinder}
              onChange={(e) => setGrinder(e.target.value)}
              placeholder="Fellow Opus"
              autoFocus
            />
            <span className="label">Which way is finer?</span>
            <Segmented
              value={finerDirection}
              onChange={setFinerDirection}
              options={[
                { value: "lower", label: "Lower number" },
                { value: "higher", label: "Higher number" },
              ]}
            />
          </>
        )}
      </section>
      <div className="mt-8 flex gap-3">
        {step > 0 && (
          <button
            type="button"
            className="button-secondary flex-1"
            onClick={() => setStep(step - 1)}
          >
            Back
          </button>
        )}
        <button
          type="button"
          disabled={!valid}
          className="button-primary flex-[2]"
          onClick={() => (step < 2 ? setStep(step + 1) : void finish())}
        >
          {step === 2 ? "Start dialing in" : "Continue"}
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </main>
  );
}
