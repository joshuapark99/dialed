import type { ComponentType, ReactNode } from "react";
import { Check, ChevronRight } from "lucide-react";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <div className="relative h-9 w-9 shrink-0 rounded-full border-[3px] border-ink">
        <span className="absolute left-[15px] top-[5px] h-[13px] w-[3px] origin-bottom rotate-45 rounded bg-coral" />
        <span className="absolute left-[13px] top-[13px] h-2 w-2 rounded-full bg-ink" />
      </div>
      {!compact && <span className="text-xl font-black">Dialed</span>}
    </div>
  );
}

export function PageHeading({
  eyebrow,
  title,
  action,
}: {
  eyebrow?: string;
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-5 flex min-h-14 items-end justify-between gap-4">
      <div>
        {eyebrow && (
          <p className="mb-1 text-xs font-bold uppercase text-coral">
            {eyebrow}
          </p>
        )}
        <h1 className="text-2xl font-black leading-tight sm:text-3xl">
          {title}
        </h1>
      </div>
      {action}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="panel flex min-h-56 flex-col items-center justify-center px-6 py-10 text-center">
      <Icon className="mb-4 h-8 w-8 text-muted" />
      <h2 className="font-bold">{title}</h2>
      <p className="mt-1 max-w-sm text-sm text-muted">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  columns,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  columns?: number;
}) {
  return (
    <div
      className="grid gap-1 rounded-md bg-canvas p-1"
      style={{
        gridTemplateColumns: `repeat(${columns ?? options.length}, minmax(0, 1fr))`,
      }}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`min-h-10 rounded px-2 text-sm font-semibold transition ${value === option.value ? "bg-white text-ink shadow-sm" : "text-muted hover:text-ink"}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function ScorePicker({
  value,
  onChange,
  low,
  high,
}: {
  value: number;
  onChange: (value: number) => void;
  low: string;
  high: string;
}) {
  return (
    <div>
      <div className="grid grid-cols-5 gap-1.5">
        {[1, 2, 3, 4, 5].map((score) => (
          <button
            key={score}
            type="button"
            aria-label={`${score} of 5`}
            onClick={() => onChange(score)}
            className={`h-10 rounded-md border text-sm font-bold transition ${score === value ? "border-ink bg-ink text-white" : "border-line bg-white hover:border-muted"}`}
          >
            {score === value ? <Check className="mx-auto h-4 w-4" /> : score}
          </button>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-muted">
        <span>{low}</span>
        <span>{high}</span>
      </div>
    </div>
  );
}

export function RowLink({
  icon: Icon,
  title,
  detail,
  onClick,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  detail?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-14 w-full items-center gap-3 border-b border-line px-4 text-left last:border-0 hover:bg-canvas"
    >
      <Icon className="h-5 w-5 text-muted" />
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{title}</span>
        {detail && (
          <span className="block truncate text-xs text-muted">{detail}</span>
        )}
      </span>
      <ChevronRight className="h-4 w-4 text-muted" />
    </button>
  );
}

export function formatDate(value: string) {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString())
    return `Today, ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}
