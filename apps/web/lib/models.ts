export type RoastLevel = "light" | "medium" | "dark";
export type TemperatureControl = "none" | "relative" | "precise";

export interface Bean {
  id: string;
  name: string;
  roaster: string;
  origin?: string;
  roastLevel: RoastLevel;
  createdAt: string;
}

export interface Machine {
  id: string;
  name: string;
  temperatureControl: TemperatureControl;
  hasPressureControl: boolean;
  hasPreinfusion: boolean;
  createdAt: string;
}

export interface Grinder {
  id: string;
  name: string;
  finerDirection: "lower" | "higher";
  createdAt: string;
}

export interface Taste {
  acidity: number;
  bitterness: number;
  strength: number;
  body: number;
  enjoyment: number;
}

export type RecommendationVariable =
  | "grind"
  | "yield"
  | "dose"
  | "temperature"
  | "pressure"
  | "pre-infusion"
  | "puck-prep"
  | "hold";

export interface Recommendation {
  variable: RecommendationVariable;
  direction: "increase" | "decrease" | "finer" | "coarser" | "improve" | "hold";
  target?: number;
  headline: string;
  rationale: string;
  expectedEffect: string;
  confidence: "low" | "medium" | "high";
  ruleVersion: string;
}

export interface Brew {
  id: string;
  beanId: string;
  machineId: string;
  grinderId: string;
  dose: number;
  yield: number;
  duration: number;
  grind: string;
  temperature?: number;
  pressure?: number;
  preinfusion?: number;
  basket?: string;
  puckPrep?: string;
  observation?: "even" | "channeling" | "gushing" | "choked";
  notes?: string;
  taste: Taste;
  ratio: number;
  flow: number;
  comparisonBrewId?: string;
  recommendation: Recommendation;
  dialedAt?: string;
  createdAt: string;
  updatedAt: string;
  syncState: "local" | "synced" | "pending";
}

export interface Preference {
  key: string;
  value: string;
}

export type SyncEntity = "bean" | "machine" | "grinder" | "brew";

export interface SyncOperation {
  operationId: string;
  entity: SyncEntity;
  entityId: string;
  action: "upsert" | "delete";
  payload?: Record<string, unknown>;
  createdAt: string;
}

export interface AccountUser {
  id: string;
  email: string;
  name: string;
  image?: string | null;
}
