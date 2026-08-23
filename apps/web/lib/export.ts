import type { Brew, Coffee, CoffeeBag, Grinder, Machine } from "./models";

export interface ExportData {
  coffees: Coffee[];
  bags: CoffeeBag[];
  machines: Machine[];
  grinders: Grinder[];
  brews: Brew[];
}

export function buildJsonExport(data: ExportData): string {
  return JSON.stringify(data, null, 2);
}

export function buildBrewCsv(
  data: Pick<ExportData, "coffees" | "bags" | "brews">,
): string {
  const bagsById = new Map(data.bags.map((bag) => [bag.id, bag]));
  const coffeesById = new Map(
    data.coffees.map((coffee) => [coffee.id, coffee]),
  );
  const rows = [
    [
      "date",
      "coffee",
      "roaster",
      "roast_date",
      "dose_g",
      "yield_g",
      "duration_s",
      "grind",
      "ratio",
      "enjoyment",
      "dialed",
    ],
    ...data.brews.map((brew) => {
      const bag = bagsById.get(brew.beanId);
      const coffee = bag ? coffeesById.get(bag.coffeeId) : undefined;
      return [
        brew.createdAt,
        coffee?.name ?? "",
        coffee?.roaster ?? "",
        bag?.roastedOn ?? "",
        brew.dose,
        brew.yield,
        brew.duration,
        brew.grind,
        brew.ratio,
        brew.taste.enjoyment,
        Boolean(brew.dialedAt),
      ];
    }),
  ];

  return rows
    .map((row) => row.map((cell) => csvCell(cell)).join(","))
    .join("\n");
}

function csvCell(value: string | number | boolean): string {
  return `"${String(value).replaceAll('"', '""')}"`;
}
