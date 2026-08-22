import {
  recommendNextAdjustment,
  type EspressoBrew,
  type GrinderProfile,
  type MachineProfile,
  type Recommendation as DomainRecommendation,
} from "@dialed/domain";
import type { Brew, Grinder, Machine, Recommendation, Taste } from "./models";

interface ShotInput {
  dose: number;
  yield: number;
  duration: number;
  grind: string;
  temperature?: number;
  pressure?: number;
  preinfusion?: number;
  basket?: string;
  puckPrep?: string;
  observation?: Brew["observation"];
  taste: Taste;
}

const placeholderId = "00000000-0000-7000-8000-000000000000";

export function getRecommendation(
  shot: ShotInput,
  grinder: Grinder,
  machine: Machine,
  previous?: Brew,
): Recommendation {
  const now = new Date().toISOString();
  const brew = toDomainBrew(shot, now);
  const machineProfile: MachineProfile = {
    id: placeholderId,
    userId: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    name: machine.name,
    capabilities: {
      temperatureControl: machine.temperatureControl,
      adjustablePressure: machine.hasPressureControl,
      preInfusion: machine.hasPreinfusion,
    },
  };
  const grinderProfile: GrinderProfile = {
    id: placeholderId,
    userId: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    name: grinder.name,
  };
  const referenceBrew = previous ? storedToDomainBrew(previous) : undefined;
  const recommendation = recommendNextAdjustment({
    brew,
    machine: machineProfile,
    grinder: grinderProfile,
    referenceBrew,
  });
  return toLocalRecommendation(recommendation, grinder);
}

function toDomainBrew(shot: ShotInput, timestamp: string): EspressoBrew {
  const parsedGrind = Number(shot.grind);
  return {
    id: placeholderId,
    userId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null,
    method: "espresso",
    beanId: placeholderId,
    machineId: placeholderId,
    grinderId: placeholderId,
    brewedAt: timestamp,
    dialedAt: null,
    espresso: {
      doseGrams: shot.dose,
      yieldGrams: shot.yield,
      durationSeconds: shot.duration,
      grindSetting: {
        display: shot.grind,
        ...(Number.isFinite(parsedGrind) ? { numericValue: parsedGrind } : {}),
      },
      ...(shot.temperature === undefined
        ? {}
        : { temperatureCelsius: shot.temperature }),
      ...(shot.pressure === undefined ? {} : { pressureBar: shot.pressure }),
      ...(shot.preinfusion === undefined
        ? {}
        : { preInfusionSeconds: shot.preinfusion }),
      ...(shot.basket ? { basket: shot.basket } : {}),
      ...(shot.puckPrep ? { puckPreparation: shot.puckPrep } : {}),
      observations:
        shot.observation && ["channeling", "gushing"].includes(shot.observation)
          ? [shot.observation as "channeling" | "gushing"]
          : [],
    },
    taste: shot.taste,
  };
}

function storedToDomainBrew(brew: Brew): EspressoBrew {
  const parsedGrind = Number(brew.grind);
  return {
    id: brew.id,
    userId: null,
    createdAt: brew.createdAt,
    updatedAt: brew.updatedAt,
    deletedAt: null,
    method: "espresso",
    beanId: brew.beanId,
    machineId: brew.machineId,
    grinderId: brew.grinderId,
    brewedAt: brew.createdAt,
    dialedAt: brew.dialedAt ?? null,
    notes: brew.notes,
    espresso: {
      doseGrams: brew.dose,
      yieldGrams: brew.yield,
      durationSeconds: brew.duration,
      grindSetting: {
        display: brew.grind,
        ...(Number.isFinite(parsedGrind) ? { numericValue: parsedGrind } : {}),
      },
      ...(brew.temperature === undefined
        ? {}
        : { temperatureCelsius: brew.temperature }),
      ...(brew.pressure === undefined ? {} : { pressureBar: brew.pressure }),
      ...(brew.preinfusion === undefined
        ? {}
        : { preInfusionSeconds: brew.preinfusion }),
      ...(brew.basket ? { basket: brew.basket } : {}),
      ...(brew.puckPrep ? { puckPreparation: brew.puckPrep } : {}),
      observations:
        brew.observation && ["channeling", "gushing"].includes(brew.observation)
          ? [brew.observation as "channeling" | "gushing"]
          : [],
    },
    taste: brew.taste,
  };
}

function toLocalRecommendation(
  result: DomainRecommendation,
  grinder: Grinder,
): Recommendation {
  if (result.kind === "hold")
    return {
      variable: "hold",
      direction: "hold",
      headline: "Hold this recipe",
      confidence: result.confidence,
      rationale: result.rationale,
      expectedEffect: result.expectedEffect,
      ruleVersion: result.ruleVersion,
    };
  if (result.kind === "collect-more-data")
    return {
      variable: "hold",
      direction: "hold",
      headline: "Repeat this recipe once",
      confidence: result.confidence,
      rationale: result.rationale,
      expectedEffect: result.expectedEffect,
      ruleVersion: result.ruleVersion,
    };
  const { variable, direction, targetValue, targetDisplay } = result.adjustment;
  return {
    variable: variable === "puck-preparation" ? "puck-prep" : variable,
    direction,
    target: targetValue,
    headline: adjustmentHeadline(variable, direction, targetDisplay, grinder),
    confidence: result.confidence,
    rationale: result.rationale,
    expectedEffect: result.expectedEffect,
    ruleVersion: result.ruleVersion,
  };
}

function adjustmentHeadline(
  variable: string,
  direction: string,
  target: string | undefined,
  grinder: Grinder,
) {
  if (variable === "grind")
    return `Go a little ${direction}${target ? ` to ${target}` : ` on ${grinder.name}`}`;
  if (variable === "yield")
    return `${direction === "increase" ? "Let it run" : "Stop"}${target ? ` near ${target}` : " a little sooner"}`;
  if (variable === "temperature")
    return `Brew slightly ${direction === "increase" ? "hotter" : "cooler"}`;
  if (variable === "puck-preparation") return "Tighten up puck prep";
  return `${direction === "increase" ? "Increase" : direction === "decrease" ? "Decrease" : "Adjust"} ${variable.replace("-", " ")}${target ? ` to ${target}` : ""}`;
}
