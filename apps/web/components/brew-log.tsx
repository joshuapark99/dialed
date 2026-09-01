"use client";

import { useMemo, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Coffee,
  Info,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { calculateBrewMetrics } from "@dialed/domain";
import {
  parseOptionalFiniteMeasurement,
  parseRequiredPositiveMeasurement,
} from "@/lib/brew-form";
import { formatBagLabel } from "@/lib/coffee-form";
import { makeId, saveBrew } from "@/lib/db";
import type {
  Brew,
  Coffee as CoffeeModel,
  CoffeeBag,
  Grinder,
  Machine,
  Taste,
} from "@/lib/models";
import { getRecommendation } from "@/lib/recommendation";
import { PageHeading, ScorePicker } from "./ui";

interface BrewLogProps {
  ownerId: string;
  coffees: CoffeeModel[];
  bags: CoffeeBag[];
  machines: Machine[];
  grinders: Grinder[];
  brews: Brew[];
  onSaved: (brew: Brew) => void;
  onCancel: () => void;
}

const initialTaste: Taste = {
  acidity: 3,
  bitterness: 3,
  strength: 3,
  body: 3,
  enjoyment: 3,
};

export function BrewLog({
  ownerId,
  coffees,
  bags,
  machines,
  grinders,
  brews,
  onSaved,
  onCancel,
}: BrewLogProps) {
  const [beanId, setBeanId] = useState(bags[0]?.id ?? "");
  const [machineId, setMachineId] = useState(machines[0]?.id ?? "");
  const [grinderId, setGrinderId] = useState(grinders[0]?.id ?? "");
  const [dose, setDose] = useState("18");
  const [shotYield, setShotYield] = useState("36");
  const [duration, setDuration] = useState("28");
  const [grind, setGrind] = useState("");
  const [taste, setTaste] = useState<Taste>(initialTaste);
  const [temperature, setTemperature] = useState("");
  const [pressure, setPressure] = useState("");
  const [preinfusion, setPreinfusion] = useState("");
  const [basket, setBasket] = useState("");
  const [puckPrep, setPuckPrep] = useState("");
  const [observation, setObservation] = useState<Brew["observation"]>();
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const parsedDose = parseRequiredPositiveMeasurement(dose);
  const parsedYield = parseRequiredPositiveMeasurement(shotYield);
  const parsedDuration = parseRequiredPositiveMeasurement(duration);
  const parsedTemperature = parseOptionalFiniteMeasurement(temperature);
  const parsedPressure = parseOptionalFiniteMeasurement(pressure, {
    minimum: 0,
    exclusive: true,
  });
  const parsedPreinfusion = parseOptionalFiniteMeasurement(preinfusion, {
    minimum: 0,
  });
  const doseNumber = parsedDose.valid ? parsedDose.value : 0;
  const yieldNumber = parsedYield.valid ? parsedYield.value : 0;
  const durationNumber = parsedDuration.valid ? parsedDuration.value : 0;
  const metrics =
    doseNumber > 0 && yieldNumber > 0 && durationNumber > 0
      ? calculateBrewMetrics({
          doseGrams: doseNumber,
          yieldGrams: yieldNumber,
          durationSeconds: durationNumber,
        })
      : undefined;
  const ratio = metrics?.ratio ?? 0;
  const flow = metrics?.averageFlowGramsPerSecond ?? 0;
  const machine = machines.find((item) => item.id === machineId) ?? machines[0];
  const grinder = grinders.find((item) => item.id === grinderId) ?? grinders[0];
  const previous = useMemo(
    () =>
      brews.find(
        (brew) =>
          brew.beanId === beanId &&
          brew.machineId === machineId &&
          brew.grinderId === grinderId,
      ),
    [beanId, machineId, grinderId, brews],
  );
  const valid = Boolean(
    beanId &&
    machine &&
    grinder &&
    parsedDose.valid &&
    parsedYield.valid &&
    parsedDuration.valid &&
    parsedTemperature.valid &&
    parsedPressure.valid &&
    parsedPreinfusion.valid &&
    grind.trim(),
  );

  async function save() {
    if (!valid || saving) return;
    setSaving(true);
    const createdAt = new Date().toISOString();
    const input = {
      dose: doseNumber,
      yield: yieldNumber,
      duration: durationNumber,
      grind: grind.trim(),
      observation,
      taste,
      temperature: parsedTemperature.valid
        ? parsedTemperature.value
        : undefined,
      pressure: parsedPressure.valid ? parsedPressure.value : undefined,
      preinfusion: parsedPreinfusion.valid
        ? parsedPreinfusion.value
        : undefined,
      basket: basket.trim() || undefined,
      puckPrep: puckPrep.trim() || undefined,
    };
    const brew: Brew = {
      id: makeId(),
      beanId,
      machineId,
      grinderId,
      dose: doseNumber,
      yield: yieldNumber,
      duration: durationNumber,
      grind: grind.trim(),
      temperature: parsedTemperature.valid
        ? parsedTemperature.value
        : undefined,
      pressure: parsedPressure.valid ? parsedPressure.value : undefined,
      preinfusion: parsedPreinfusion.valid
        ? parsedPreinfusion.value
        : undefined,
      basket: basket.trim() || undefined,
      puckPrep: puckPrep.trim() || undefined,
      observation,
      notes: notes.trim() || undefined,
      taste,
      ratio,
      flow,
      ...(previous ? { comparisonBrewId: previous.id } : {}),
      recommendation: getRecommendation(input, grinder, machine, previous),
      createdAt,
      updatedAt: createdAt,
      syncState: "local",
    };
    await saveBrew(ownerId, brew);
    setSaving(false);
    onSaved(brew);
  }

  return (
    <div className="view-enter pb-44 lg:pb-8">
      <PageHeading
        eyebrow="New espresso"
        title="Log this shot"
        action={
          <button
            type="button"
            className="icon-button"
            aria-label="Cancel"
            title="Cancel"
            onClick={onCancel}
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-4">
          <section className="panel p-4 sm:p-5">
            <div className="mb-4 flex items-center gap-2">
              <Coffee className="h-5 w-5 text-leaf" />
              <h2 className="font-bold">Recipe</h2>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <label>
                <span className="label">Coffee</span>
                <select
                  className="field"
                  value={beanId}
                  onChange={(e) => setBeanId(e.target.value)}
                >
                  {bags.map((bag) => {
                    const coffee = coffees.find(
                      (item) => item.id === bag.coffeeId,
                    );
                    return (
                      <option key={bag.id} value={bag.id}>
                        {coffee?.name ?? "Unknown coffee"} —{" "}
                        {formatBagLabel(bag)}
                      </option>
                    );
                  })}
                </select>
              </label>
              <label>
                <span className="label">Machine</span>
                <select
                  className="field"
                  value={machineId}
                  onChange={(e) => setMachineId(e.target.value)}
                >
                  {machines.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="label">Grinder</span>
                <select
                  className="field"
                  value={grinderId}
                  onChange={(e) => setGrinderId(e.target.value)}
                >
                  {grinders.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="my-5 h-px bg-line" />
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <NumberField
                label="Dose"
                value={dose}
                onChange={setDose}
                unit="g"
                step="0.1"
                min="0.1"
              />
              <NumberField
                label="Yield"
                value={shotYield}
                onChange={setShotYield}
                unit="g"
                step="0.1"
                min="0.1"
              />
              <NumberField
                label="Time"
                value={duration}
                onChange={setDuration}
                unit="s"
                step="1"
                min="1"
              />
              <label>
                <span className="label">
                  Grind <span className="text-coral">(required)</span>
                </span>
                <input
                  required
                  aria-describedby={
                    !grind.trim() ? "grind-save-requirement" : undefined
                  }
                  className="field"
                  value={grind}
                  onChange={(e) => setGrind(e.target.value)}
                  placeholder="0.8"
                />
              </label>
            </div>
            <div className="mt-4 grid grid-cols-2 divide-x divide-line rounded-md bg-ink px-2 py-3 text-white">
              <div className="px-3">
                <p className="text-[11px] font-semibold uppercase text-white/60">
                  Brew ratio
                </p>
                <p className="metric mt-0.5 text-xl font-black">
                  1:{ratio ? ratio.toFixed(2) : "--"}
                </p>
              </div>
              <div className="px-3">
                <p className="text-[11px] font-semibold uppercase text-white/60">
                  Avg. flow
                </p>
                <p className="metric mt-0.5 text-xl font-black">
                  {flow ? flow.toFixed(2) : "--"}{" "}
                  <span className="text-xs font-medium">g/s</span>
                </p>
              </div>
            </div>
          </section>

          <section className="panel p-4 sm:p-5">
            <div className="mb-1 flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-coral" />
              <h2 className="font-bold">How did it taste?</h2>
            </div>
            <p className="mb-5 text-sm text-muted">
              Trust your palate. There are no wrong scores.
            </p>
            <div className="grid gap-x-7 gap-y-5 sm:grid-cols-2">
              <TasteField
                label="Acidity"
                value={taste.acidity}
                low="Flat"
                high="Sour"
                onChange={(value) => setTaste({ ...taste, acidity: value })}
              />
              <TasteField
                label="Bitterness"
                value={taste.bitterness}
                low="None"
                high="Harsh"
                onChange={(value) => setTaste({ ...taste, bitterness: value })}
              />
              <TasteField
                label="Strength"
                value={taste.strength}
                low="Weak"
                high="Intense"
                onChange={(value) => setTaste({ ...taste, strength: value })}
              />
              <TasteField
                label="Body"
                value={taste.body}
                low="Thin"
                high="Heavy"
                onChange={(value) => setTaste({ ...taste, body: value })}
              />
              <div className="sm:col-span-2">
                <TasteField
                  label="Overall enjoyment"
                  value={taste.enjoyment}
                  low="Not for me"
                  high="Excellent"
                  onChange={(value) => setTaste({ ...taste, enjoyment: value })}
                />
              </div>
            </div>
          </section>

          <details className="panel group">
            <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 px-4 font-bold sm:px-5">
              <SlidersHorizontal className="h-5 w-5 text-sky" />
              Shot details{" "}
              <span className="ml-auto text-xs font-medium text-muted">
                Optional
              </span>
              <ChevronDown className="h-4 w-4 text-muted transition group-open:rotate-180" />
            </summary>
            <div className="border-t border-line p-4 sm:p-5">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                {machine?.temperatureControl !== "none" && (
                  <NumberField
                    label="Temperature"
                    value={temperature}
                    onChange={setTemperature}
                    unit="C"
                    step="0.5"
                  />
                )}
                {machine?.hasPressureControl && (
                  <NumberField
                    label="Pressure"
                    value={pressure}
                    onChange={setPressure}
                    unit="bar"
                    step="0.1"
                    min="0.1"
                  />
                )}
                {machine?.hasPreinfusion && (
                  <NumberField
                    label="Pre-infusion"
                    value={preinfusion}
                    onChange={setPreinfusion}
                    unit="s"
                    step="1"
                    min="0"
                  />
                )}
                <label>
                  <span className="label">Basket</span>
                  <input
                    className="field"
                    value={basket}
                    onChange={(e) => setBasket(e.target.value)}
                    placeholder="18 g IMS"
                  />
                </label>
                <label>
                  <span className="label">Puck prep</span>
                  <input
                    className="field"
                    value={puckPrep}
                    onChange={(e) => setPuckPrep(e.target.value)}
                    placeholder="WDT + tamp"
                  />
                </label>
              </div>
              <span className="label mt-5">Flow observation</span>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {(["even", "channeling", "gushing", "choked"] as const).map(
                  (item) => (
                    <button
                      type="button"
                      key={item}
                      onClick={() =>
                        setObservation(observation === item ? undefined : item)
                      }
                      className={`min-h-10 rounded-md border px-2 text-sm font-semibold capitalize ${observation === item ? "border-ink bg-ink text-white" : "border-line bg-white"}`}
                    >
                      {item}
                    </button>
                  ),
                )}
              </div>
              <label className="mt-5 block">
                <span className="label">Notes</span>
                <textarea
                  className="field min-h-24 py-3"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Aroma, finish, anything unusual..."
                />
              </label>
            </div>
          </details>
        </div>

        <aside className="h-fit xl:sticky xl:top-24">
          {previous ? (
            <div className="panel mb-4 hidden p-4 xl:block">
              <div className="mb-3 flex items-center gap-2 text-sm font-bold">
                <Info className="h-4 w-4 text-sky" />
                Comparison
              </div>
              <p className="text-sm text-muted">
                This shot will be compared with your latest matching setup:
              </p>
              <p className="metric mt-3 font-bold">
                {previous.dose} g in / {previous.yield} g out /{" "}
                {previous.duration}s
              </p>
            </div>
          ) : null}
          <div className="fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] left-4 right-4 z-20 xl:static">
            <button
              type="button"
              disabled={!valid || saving}
              aria-describedby={
                !grind.trim() ? "grind-save-requirement" : undefined
              }
              onClick={() => void save()}
              className="button-primary w-full shadow-xl xl:shadow-none"
            >
              {saving ? "Saving..." : "Save and see next move"}
              <Check className="h-5 w-5" />
            </button>
            {!grind.trim() && (
              <p
                id="grind-save-requirement"
                className="mt-2 rounded-md bg-canvas/95 px-3 py-1.5 text-center text-xs font-semibold text-muted shadow-sm"
              >
                Enter a grind setting to save.
              </p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  unit,
  step,
  min,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  unit: string;
  step: string;
  min?: string;
}) {
  return (
    <label>
      <span className="label">{label}</span>
      <span className="relative block">
        <input
          type="number"
          min={min}
          step={step}
          className="field pr-10"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <span className="pointer-events-none absolute right-3 top-3.5 text-sm font-semibold text-muted">
          {unit}
        </span>
      </span>
    </label>
  );
}

function TasteField({
  label,
  value,
  low,
  high,
  onChange,
}: {
  label: string;
  value: number;
  low: string;
  high: string;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <span className="label">{label}</span>
      <ScorePicker value={value} onChange={onChange} low={low} high={high} />
    </div>
  );
}
