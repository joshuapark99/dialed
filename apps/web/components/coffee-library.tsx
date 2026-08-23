"use client";

import React, { useState } from "react";
import { Coffee as CoffeeIcon, Package, Plus } from "lucide-react";
import { formatBagLabel } from "../lib/coffee-form";
import type { Coffee, CoffeeBag } from "../lib/models";
import { CoffeeDialog } from "./coffee-dialog";

export interface CoffeeLibraryProps {
  ownerId: string;
  coffees: Coffee[];
  bags: CoffeeBag[];
}

export function CoffeeLibrary({ ownerId, coffees, bags }: CoffeeLibraryProps) {
  const [dialog, setDialog] = useState<
    { mode: "coffee" } | { mode: "bag"; coffee: Coffee }
  >();
  const bagsByCoffee = new Map<string, CoffeeBag[]>();
  for (const bag of bags) {
    const group = bagsByCoffee.get(bag.coffeeId) ?? [];
    group.push(bag);
    bagsByCoffee.set(bag.coffeeId, group);
  }

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-bold">Coffee</h2>
        <button
          type="button"
          className="button-secondary min-h-9 px-2.5 text-sm"
          onClick={() => setDialog({ mode: "coffee" })}
        >
          <Plus className="h-4 w-4" />
          Add Coffee
        </button>
      </div>

      {coffees.length ? (
        <div className="space-y-3">
          {coffees.map((coffee) => {
            const coffeeBags = [...(bagsByCoffee.get(coffee.id) ?? [])].sort(
              (left, right) => right.createdAt.localeCompare(left.createdAt),
            );
            return (
              <article className="panel overflow-hidden" key={coffee.id}>
                <div className="flex items-start gap-3 border-b border-line p-4">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-canvas">
                    <CoffeeIcon className="h-4 w-4 text-muted" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{coffee.name}</span>
                    <span className="block text-xs text-muted">
                      {coffee.roaster} / {coffee.roastLevel} roast
                    </span>
                  </span>
                  <button
                    type="button"
                    className="button-secondary min-h-9 shrink-0 px-2.5 text-sm"
                    onClick={() => setDialog({ mode: "bag", coffee })}
                  >
                    <Plus className="h-4 w-4" />
                    Add Another Bag
                  </button>
                </div>
                <ul className="divide-y divide-line">
                  {coffeeBags.length ? (
                    coffeeBags.map((bag) => (
                      <li
                        className="flex min-h-12 items-center gap-3 px-4 text-sm"
                        key={bag.id}
                      >
                        <Package className="h-4 w-4 text-muted" />
                        <span>{formatBagLabel(bag)}</span>
                      </li>
                    ))
                  ) : (
                    <li className="px-4 py-3 text-sm text-muted">
                      No bags added
                    </li>
                  )}
                </ul>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="panel px-5 py-8 text-center">
          <CoffeeIcon className="mx-auto mb-3 h-7 w-7 text-muted" />
          <p className="font-semibold">No coffee added yet</p>
          <p className="mt-1 text-sm text-muted">
            Add a coffee and its first bag to start dialing in.
          </p>
        </div>
      )}

      {dialog?.mode === "coffee" && (
        <CoffeeDialog
          mode="coffee"
          ownerId={ownerId}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog?.mode === "bag" && (
        <CoffeeDialog
          mode="bag"
          ownerId={ownerId}
          coffee={dialog.coffee}
          onClose={() => setDialog(undefined)}
        />
      )}
    </section>
  );
}
