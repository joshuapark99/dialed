"use client";

import { useMemo, useState } from "react";
import {
  CheckCircle2,
  GitCompareArrows,
  History,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { deleteBrew } from "@/lib/db";
import type { Bean, Brew } from "@/lib/models";
import { EmptyState, PageHeading, formatDate } from "./ui";

export function HistoryView({
  ownerId,
  beans,
  brews,
  onLog,
}: {
  ownerId: string;
  beans: Bean[];
  brews: Brew[];
  onLog: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [compareId, setCompareId] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const filtered = useMemo(
    () =>
      brews.filter((brew) => {
        const bean = beans.find((item) => item.id === brew.beanId);
        return `${bean?.name} ${bean?.roaster} ${brew.notes ?? ""}`
          .toLowerCase()
          .includes(query.toLowerCase());
      }),
    [beans, brews, query],
  );
  const selected = brews.find((brew) => brew.id === selectedId);
  const comparison =
    brews.find((brew) => brew.id === compareId) ??
    (selected
      ? brews.find((brew) => brew.id === selected.comparisonBrewId)
      : undefined);

  async function removeSelected() {
    if (!selected || deleting) return;
    if (
      !window.confirm(
        "Permanently delete this brew log? This cannot be undone.",
      )
    )
      return;
    setDeleteError(undefined);
    setDeleting(true);
    try {
      await deleteBrew(ownerId, selected.id);
      setSelectedId(undefined);
      setCompareId(undefined);
    } catch {
      setDeleteError(
        "Couldn't delete this log. Your brew is still saved. Try again.",
      );
    } finally {
      setDeleting(false);
    }
  }

  if (!brews.length)
    return (
      <div className="view-enter">
        <PageHeading title="Brew history" />
        <EmptyState
          icon={History}
          title="No shots yet"
          body="Your recipes and taste notes will collect here."
          action={
            <button className="button-primary" onClick={onLog}>
              Log a brew
            </button>
          }
        />
      </div>
    );

  return (
    <div className="view-enter pb-28 lg:pb-8">
      <PageHeading
        eyebrow={`${brews.length} shot${brews.length === 1 ? "" : "s"}`}
        title="Brew history"
      />
      <label className="relative mb-4 block">
        <Search className="pointer-events-none absolute left-3 top-3.5 h-5 w-5 text-muted" />
        <input
          className="field pl-10"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search coffee or notes"
        />
      </label>
      <div className="panel divide-y divide-line overflow-hidden">
        {filtered.map((brew) => {
          const bean = beans.find((item) => item.id === brew.beanId);
          return (
            <button
              type="button"
              key={brew.id}
              onClick={() => {
                setSelectedId(brew.id);
                setCompareId(undefined);
                setDeleteError(undefined);
              }}
              className="flex min-h-20 w-full items-center gap-3 px-4 text-left transition hover:bg-canvas"
            >
              <span
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md ${brew.dialedAt ? "bg-leaf text-white" : "bg-canvas text-muted"}`}
              >
                {brew.dialedAt ? (
                  <CheckCircle2 className="h-5 w-5" />
                ) : (
                  <span className="metric text-xs font-black">
                    1:{brew.ratio.toFixed(1)}
                  </span>
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate font-bold">
                    {bean?.name ?? "Unknown coffee"}
                  </span>
                  {brew.dialedAt && (
                    <span className="rounded bg-leaf/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-leaf">
                      Dialed
                    </span>
                  )}
                </span>
                <span className="block text-xs text-muted">
                  {formatDate(brew.createdAt)} / grind {brew.grind}
                </span>
              </span>
              <span className="metric shrink-0 text-right text-sm font-bold">
                {brew.dose} / {brew.yield} g
                <span className="block text-xs font-medium text-muted">
                  {brew.duration}s
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {!filtered.length && (
        <p className="py-12 text-center text-sm text-muted">
          No shots match that search.
        </p>
      )}

      {selected && (
        <div
          className="fixed inset-0 z-40 bg-ink/35 p-0 backdrop-blur-[2px] sm:flex sm:items-end sm:justify-center sm:p-5"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setSelectedId(undefined);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Shot details"
            className="absolute bottom-0 max-h-[90dvh] w-full overflow-auto rounded-t-lg bg-canvas px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-4 shadow-2xl sm:static sm:max-w-2xl sm:rounded-lg sm:p-6"
          >
            <div className="mb-5 flex items-center justify-between">
              <div>
                <p className="text-xs font-bold uppercase text-coral">
                  {formatDate(selected.createdAt)}
                </p>
                <h2 className="text-xl font-black">
                  {beans.find((item) => item.id === selected.beanId)?.name}
                </h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Close"
                onClick={() => setSelectedId(undefined)}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="panel grid grid-cols-4 divide-x divide-line bg-white">
              <DetailMetric label="Dose" value={`${selected.dose}g`} />
              <DetailMetric label="Yield" value={`${selected.yield}g`} />
              <DetailMetric label="Time" value={`${selected.duration}s`} />
              <DetailMetric label="Grind" value={selected.grind} />
            </div>
            <div className="mt-4 rounded-md bg-ink p-4 text-white">
              <p className="text-xs font-bold uppercase text-sun">
                Recommendation
              </p>
              <p className="mt-1 text-lg font-black">
                {selected.recommendation.headline}
              </p>
              <p className="mt-1 text-sm text-white/65">
                {selected.recommendation.rationale}
              </p>
            </div>
            <div className="mt-5 flex items-end gap-3">
              <label className="flex-1">
                <span className="label">Compare against</span>
                <select
                  className="field"
                  value={comparison?.id ?? ""}
                  onChange={(e) => setCompareId(e.target.value)}
                >
                  <option value="">No reference</option>
                  {brews
                    .filter(
                      (brew) =>
                        brew.id !== selected.id &&
                        brew.beanId === selected.beanId,
                    )
                    .map((brew) => (
                      <option key={brew.id} value={brew.id}>
                        {formatDate(brew.createdAt)} / {brew.yield}g in{" "}
                        {brew.duration}s
                      </option>
                    ))}
                </select>
              </label>
              <button type="button" className="icon-button" title="Compare">
                <GitCompareArrows className="h-5 w-5" />
              </button>
            </div>
            {comparison && (
              <div className="mt-3 panel grid grid-cols-3 divide-x divide-line">
                <Delta label="Yield" a={selected.yield} b={comparison.yield} />
                <Delta
                  label="Time"
                  a={selected.duration}
                  b={comparison.duration}
                />
                <Delta
                  label="Enjoyment"
                  a={selected.taste.enjoyment}
                  b={comparison.taste.enjoyment}
                />
              </div>
            )}
            {selected.notes && (
              <div className="mt-5">
                <p className="label">Notes</p>
                <p className="text-sm leading-relaxed text-muted">
                  {selected.notes}
                </p>
              </div>
            )}
            <div className="mt-6 border-t border-line pt-4">
              {deleteError && (
                <p role="alert" className="mb-3 text-sm text-coral">
                  {deleteError}
                </p>
              )}
              <button
                type="button"
                className="flex min-h-11 items-center gap-2 rounded-md px-3 font-semibold text-coral transition hover:bg-coral/5 disabled:cursor-not-allowed disabled:opacity-45"
                disabled={deleting}
                onClick={() => void removeSelected()}
              >
                <Trash2 className="h-4 w-4" />
                {deleting ? "Deleting..." : "Delete log"}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function DetailMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 px-1 py-3 text-center">
      <p className="text-[10px] font-semibold uppercase text-muted">{label}</p>
      <p className="metric truncate font-black">{value}</p>
    </div>
  );
}
function Delta({ label, a, b }: { label: string; a: number; b: number }) {
  const delta = a - b;
  return (
    <div className="px-2 py-3 text-center">
      <p className="text-[10px] font-semibold uppercase text-muted">{label}</p>
      <p className="metric font-black">
        {delta > 0 ? "+" : ""}
        {delta.toFixed(1)}
      </p>
    </div>
  );
}
