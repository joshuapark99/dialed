import {
  ArrowRight,
  CheckCircle2,
  Coffee,
  History,
  Plus,
  Target,
} from "lucide-react";
import type { Brew, Coffee as CoffeeModel, CoffeeBag } from "@/lib/models";
import { EmptyState, PageHeading, formatDate } from "./ui";

export function HomeView({
  coffees,
  bags,
  brews,
  onLog,
  onHistory,
}: {
  coffees: CoffeeModel[];
  bags: CoffeeBag[];
  brews: Brew[];
  onLog: () => void;
  onHistory: () => void;
}) {
  const latest = brews[0];
  const bag = latest
    ? bags.find((item) => item.id === latest.beanId)
    : undefined;
  const coffee = bag
    ? coffees.find((item) => item.id === bag.coffeeId)
    : undefined;
  const dialed = brews.filter((brew) => brew.dialedAt).length;

  return (
    <div className="view-enter pb-28 lg:pb-8">
      <PageHeading
        eyebrow={new Date().toLocaleDateString([], {
          weekday: "long",
          month: "short",
          day: "numeric",
        })}
        title="Ready for the next shot?"
      />
      {!latest ? (
        <EmptyState
          icon={Coffee}
          title="Your first shot starts here"
          body="Log the recipe and how it tasted. Dialed will suggest one useful change."
          action={
            <button type="button" onClick={onLog} className="button-primary">
              <Plus className="h-4 w-4" />
              Log a brew
            </button>
          }
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(17rem,1fr)]">
          <section className="panel overflow-hidden border-ink">
            <div className="bg-ink px-5 py-5 text-white sm:px-6">
              <div className="mb-6 flex items-center justify-between">
                <span className="rounded bg-white/10 px-2 py-1 text-xs font-semibold">
                  {coffee?.name ?? "Recent coffee"}
                </span>
                <span className="text-xs text-white/60">
                  {formatDate(latest.createdAt)}
                </span>
              </div>
              <p className="text-xs font-bold uppercase text-sun">Next move</p>
              <h2 className="mt-1 text-2xl font-black sm:text-3xl">
                {latest.recommendation.headline}
              </h2>
              <p className="mt-2 max-w-lg text-sm leading-relaxed text-white/70">
                {latest.recommendation.rationale}
              </p>
            </div>
            <div className="grid grid-cols-3 divide-x divide-line bg-white">
              <HomeMetric label="Dose" value={`${latest.dose} g`} />
              <HomeMetric label="Yield" value={`${latest.yield} g`} />
              <HomeMetric label="Time" value={`${latest.duration}s`} />
            </div>
            <div className="flex flex-col gap-2 border-t border-line p-4 sm:flex-row">
              <button
                type="button"
                className="button-primary flex-1"
                onClick={onLog}
              >
                Log next shot <ArrowRight className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="button-secondary"
                onClick={onHistory}
              >
                <History className="h-4 w-4" />
                View session
              </button>
            </div>
          </section>

          <aside className="grid grid-cols-2 gap-3 xl:grid-cols-1">
            <div className="panel p-4">
              <Target className="mb-5 h-5 w-5 text-coral" />
              <p className="metric text-3xl font-black">{brews.length}</p>
              <p className="text-sm text-muted">Shots logged</p>
            </div>
            <div className="panel p-4">
              <CheckCircle2 className="mb-5 h-5 w-5 text-leaf" />
              <p className="metric text-3xl font-black">{dialed}</p>
              <p className="text-sm text-muted">Recipes dialed</p>
            </div>
          </aside>
        </div>
      )}
      {brews.length > 1 && (
        <section className="mt-7">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-bold">Recent shots</h2>
            <button
              className="text-sm font-semibold text-leaf"
              type="button"
              onClick={onHistory}
            >
              See all
            </button>
          </div>
          <div className="panel divide-y divide-line">
            {brews.slice(0, 3).map((brew) => {
              const brewBag = bags.find((item) => item.id === brew.beanId);
              const brewCoffee = brewBag
                ? coffees.find((item) => item.id === brewBag.coffeeId)
                : undefined;
              return (
                <button
                  type="button"
                  onClick={onHistory}
                  key={brew.id}
                  className="flex min-h-16 w-full items-center px-4 text-left hover:bg-canvas"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">
                      {brewCoffee?.name}
                    </span>
                    <span className="text-xs text-muted">
                      {formatDate(brew.createdAt)}
                    </span>
                  </span>
                  <span className="metric text-sm font-bold">
                    {brew.dose} : {brew.yield} / {brew.duration}s
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

function HomeMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-4 text-center">
      <p className="text-[11px] font-semibold uppercase text-muted">{label}</p>
      <p className="metric mt-1 text-xl font-black">{value}</p>
    </div>
  );
}
