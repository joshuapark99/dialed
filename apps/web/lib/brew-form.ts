export type ParsedRequiredMeasurement =
  { valid: false } | { valid: true; value: number };

export type ParsedOptionalMeasurement =
  { valid: false } | { valid: true; value?: number };

export interface OptionalMeasurementConstraints {
  minimum?: number;
  exclusive?: boolean;
}

export function parseRequiredPositiveMeasurement(
  input: string,
): ParsedRequiredMeasurement {
  const value = Number(input);
  return input.trim() && Number.isFinite(value) && value > 0
    ? { valid: true, value }
    : { valid: false };
}

export function parseOptionalFiniteMeasurement(
  input: string,
  constraints: OptionalMeasurementConstraints = {},
): ParsedOptionalMeasurement {
  if (!input.trim()) return { valid: true };
  const value = Number(input);
  if (!Number.isFinite(value)) return { valid: false };
  if (constraints.minimum !== undefined) {
    const withinRange = constraints.exclusive
      ? value > constraints.minimum
      : value >= constraints.minimum;
    if (!withinRange) return { valid: false };
  }
  return { valid: true, value };
}
