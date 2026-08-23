"use client";

import {
  ArrowRight,
  CheckCircle2,
  Gauge,
  RotateCcw,
  Sparkles,
  Target,
} from "lucide-react";
import { updateBrew } from "@/lib/db";
import type { Bean, Brew } from "@/lib/models";
import { formatDate } from "./ui";

export function BrewResult({
  ownerId,
  brew,
  bean,
  reference,
  onDone,
  onLogAnother,
}: {
  ownerId: string;
  brew: Brew;
  bean?: Bean;
  reference?: Brew;
  onDone: () => void;
  onLogAnother: () => void;
}) {
  async function toggleDialed() {
    await updateBrew(ownerId, brew.id, {
      dialedAt: brew.dialedAt ? undefined : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    onDone();
  }

  return (
    <div className="view-enter mx-auto max-w-3xl pb-28 lg:pb-8">
      <div className="mb-8 flex items-center gap-3 text-sm font-semibold text-leaf">
        <CheckCircle2 className="h-5 w-5" />
        Shot saved locally
      </div>
      <p className="text-xs font-bold uppercase text-coral">Your next move</p>
      <h1 className="mt-2 text-3xl font-black leading-tight sm:text-4xl">
        {brew.recommendation.headline}
      </h1>
      <p className="mt-3 max-w-xl text-base leading-relaxed text-muted">
        {brew.recommendation.rationale}
      </p>

      <section className="panel mt-7 overflow-hidden border-ink bg-ink text-white">
        <div className="grid grid-cols-3 divide-x divide-white/15">
          <Metric label="Dose" value={`${brew.dose} g`} />
          <Metric label="Yield" value={`${brew.yield} g`} />
          <Metric label="Time" value={`${brew.duration}s`} />
        </div>
        <div className="flex items-center gap-3 border-t border-white/15 px-4 py-3 text-sm text-white/75">
          <Target className="h-4 w-4 text-sun" />
          <span>Expected: {brew.recommendation.expectedEffect}</span>
        </div>
      </section>

      {reference && (
        <section className="mt-5">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-bold">Compared with last shot</h2>
            <span className="text-xs text-muted">
              {formatDate(reference.createdAt)}
            </span>
          </div>
          <div className="panel grid grid-cols-3 divide-x divide-line p-0">
            <Delta
              label="Yield"
              current={brew.yield}
              previous={reference.yield}
              unit="g"
            />
            <Delta
              label="Time"
              current={brew.duration}
              previous={reference.duration}
              unit="s"
            />
            <Delta
              label="Enjoyment"
              current={brew.taste.enjoyment}
              previous={reference.taste.enjoyment}
              unit="/5"
            />
          </div>
        </section>
      )}

      <div className="mt-6 flex items-center gap-2 rounded-md border border-line bg-white p-3 text-sm text-muted">
        <Sparkles className="h-5 w-5 shrink-0 text-coral" />
        <p>
          Change one variable, taste again, and let the next shot confirm the
          direction.
        </p>
      </div>

      <div className="mt-7 grid gap-3 sm:grid-cols-2">
        <button type="button" className="button-primary" onClick={onLogAnother}>
          Log the next shot <ArrowRight className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="button-secondary"
          onClick={() => void toggleDialed()}
        >
          <Gauge className="h-4 w-4" />
          Mark this recipe dialed
        </button>
      </div>
      <button
        type="button"
        className="mx-auto mt-5 flex min-h-10 items-center gap-2 px-3 text-sm font-semibold text-muted hover:text-ink"
        onClick={onDone}
      >
        <RotateCcw className="h-4 w-4" />
        Back to dashboard
      </button>
      {bean && (
        <p className="mt-5 text-center text-xs text-muted">
          {bean.roaster} / {bean.name}
        </p>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-5 text-center">
      <p className="text-[11px] font-semibold uppercase text-white/55">
        {label}
      </p>
      <p className="metric mt-1 text-2xl font-black">{value}</p>
    </div>
  );
}

function Delta({
  label,
  current,
  previous,
  unit,
}: {
  label: string;
  current: number;
  previous: number;
  unit: string;
}) {
  const difference = current - previous;
  return (
    <div className="px-2 py-4 text-center">
      <p className="text-[11px] font-semibold uppercase text-muted">{label}</p>
      <p className="metric mt-1 font-black">
        {current}
        {unit}
      </p>
      <p
        className={`metric text-xs font-semibold ${difference > 0 ? "text-leaf" : difference < 0 ? "text-coral" : "text-muted"}`}
      >
        {difference > 0 ? "+" : ""}
        {Number.isInteger(difference) ? difference : difference.toFixed(1)}
      </p>
    </div>
  );
}
