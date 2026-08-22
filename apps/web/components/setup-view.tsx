"use client";

import { useState } from "react";
import {
  Cloud,
  Coffee,
  Database,
  Download,
  Gauge,
  LogOut,
  Plus,
  RefreshCw,
  RotateCw,
  Settings,
  Trash2,
  UserRound,
} from "lucide-react";
import {
  clearLocalData,
  makeId,
  saveBean,
  saveGrinder,
  saveMachine,
} from "@/lib/db";
import type {
  AccountUser,
  Bean,
  Brew,
  Grinder,
  Machine,
  RoastLevel,
} from "@/lib/models";
import {
  deleteCloudAccount,
  signInWithGoogle,
  signOut,
  type SyncStatus,
} from "@/lib/sync";
import { PageHeading, Segmented } from "./ui";

type SetupTab = "coffee" | "equipment" | "settings";

export function SetupView({
  beans,
  machines,
  grinders,
  brews,
  account,
  syncStatus,
  onSync,
  onAccountChanged,
}: {
  beans: Bean[];
  machines: Machine[];
  grinders: Grinder[];
  brews: Brew[];
  account: AccountUser | null;
  syncStatus: SyncStatus;
  onSync: () => Promise<void>;
  onAccountChanged: () => Promise<void>;
}) {
  const [tab, setTab] = useState<SetupTab>("coffee");
  const [adding, setAdding] = useState<"bean" | "machine" | "grinder">();

  function download(format: "json" | "csv") {
    const data =
      format === "json"
        ? JSON.stringify({ beans, machines, grinders, brews }, null, 2)
        : toCsv(brews, beans);
    const blob = new Blob([data], {
      type: format === "json" ? "application/json" : "text/csv",
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `dialed-export.${format}`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  async function clear() {
    if (
      window.confirm(
        "Clear all local coffee, equipment, and brew data? This cannot be undone.",
      )
    )
      await clearLocalData();
  }

  async function removeAccount() {
    if (
      !window.confirm(
        "Delete your Dialed account and all cloud data? This cannot be undone.",
      )
    )
      return;
    await deleteCloudAccount();
    await clearLocalData();
    await onAccountChanged();
  }

  return (
    <div className="view-enter pb-28 lg:pb-8">
      <PageHeading title="Your setup" />
      <div className="mb-5 grid grid-cols-3 rounded-md border border-line bg-white p-1">
        {(
          [
            { value: "coffee", label: "Coffee" },
            { value: "equipment", label: "Equipment" },
            { value: "settings", label: "Settings" },
          ] as const
        ).map((item) => (
          <button
            type="button"
            key={item.value}
            onClick={() => setTab(item.value)}
            className={`min-h-10 rounded text-sm font-bold ${tab === item.value ? "bg-ink text-white" : "text-muted hover:text-ink"}`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === "coffee" && (
        <LibrarySection
          title="Coffee"
          onAdd={() => setAdding("bean")}
          items={beans.map((bean) => ({
            id: bean.id,
            icon: Coffee,
            title: bean.name,
            detail: `${bean.roaster} / ${bean.roastLevel} roast`,
          }))}
        />
      )}
      {tab === "equipment" && (
        <div className="space-y-6">
          <LibrarySection
            title="Machines"
            onAdd={() => setAdding("machine")}
            items={machines.map((item) => ({
              id: item.id,
              icon: Gauge,
              title: item.name,
              detail:
                item.temperatureControl === "none"
                  ? "Thermostat control"
                  : `${item.temperatureControl} temperature control`,
            }))}
          />
          <LibrarySection
            title="Grinders"
            onAdd={() => setAdding("grinder")}
            items={grinders.map((item) => ({
              id: item.id,
              icon: RotateCw,
              title: item.name,
              detail: `Finer = ${item.finerDirection} number`,
            }))}
          />
        </div>
      )}
      {tab === "settings" && (
        <div className="space-y-5">
          <section className="panel overflow-hidden">
            <div className="border-b border-line p-4">
              <h2 className="font-bold">Sync</h2>
              <p className="mt-1 text-sm text-muted">
                Local-first storage with optional private cloud backup.
              </p>
            </div>
            {account ? (
              <div className="p-4">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-md bg-leaf/10">
                    <UserRound className="h-5 w-5 text-leaf" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">
                      {account.name}
                    </span>
                    <span className="block truncate text-xs text-muted">
                      {account.email} / {syncStatus}
                    </span>
                  </span>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    className="button-secondary"
                    onClick={() => void onSync()}
                    disabled={syncStatus === "syncing"}
                  >
                    <RefreshCw
                      className={`h-4 w-4 ${syncStatus === "syncing" ? "animate-spin" : ""}`}
                    />
                    Sync now
                  </button>
                  <button
                    type="button"
                    className="button-secondary"
                    onClick={() => void signOut().then(onAccountChanged)}
                  >
                    <LogOut className="h-4 w-4" />
                    Sign out
                  </button>
                </div>
              </div>
            ) : (
              <div className="p-4">
                <div className="mb-4 flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-md bg-sky/10">
                    <Cloud className="h-5 w-5 text-sky" />
                  </span>
                  <span className="flex-1">
                    <span className="block font-semibold">Local mode</span>
                    <span className="block text-xs text-muted">
                      Your brews remain on this device
                    </span>
                  </span>
                </div>
                <button
                  type="button"
                  className="button-primary w-full"
                  onClick={() => void signInWithGoogle()}
                >
                  Continue with Google
                </button>
              </div>
            )}
          </section>
          <section className="panel overflow-hidden">
            <div className="border-b border-line p-4">
              <h2 className="font-bold">Your data</h2>
              <p className="mt-1 text-sm text-muted">
                {brews.length} brews stored locally
              </p>
            </div>
            <button
              type="button"
              className="flex min-h-14 w-full items-center gap-3 border-b border-line px-4 text-left hover:bg-canvas"
              onClick={() => download("json")}
            >
              <Download className="h-5 w-5 text-muted" />
              <span className="flex-1 font-semibold">Export JSON</span>
            </button>
            <button
              type="button"
              className="flex min-h-14 w-full items-center gap-3 border-b border-line px-4 text-left hover:bg-canvas"
              onClick={() => download("csv")}
            >
              <Database className="h-5 w-5 text-muted" />
              <span className="flex-1 font-semibold">Export brew CSV</span>
            </button>
            <button
              type="button"
              className="flex min-h-14 w-full items-center gap-3 px-4 text-left text-coral hover:bg-coral/5"
              onClick={() => void clear()}
            >
              <Trash2 className="h-5 w-5" />
              <span className="flex-1 font-semibold">Clear local data</span>
            </button>
          </section>
          {account && (
            <button
              type="button"
              className="flex min-h-12 w-full items-center justify-center gap-2 rounded-md border border-coral/30 bg-white px-4 font-semibold text-coral"
              onClick={() => void removeAccount()}
            >
              <Trash2 className="h-4 w-4" />
              Delete cloud account
            </button>
          )}
          <p className="text-center text-xs text-muted">
            Dialed web v0.1 / recommendation rules web-1
          </p>
        </div>
      )}
      {adding && (
        <AddDialog kind={adding} onClose={() => setAdding(undefined)} />
      )}
    </div>
  );
}

function LibrarySection({
  title,
  onAdd,
  items,
}: {
  title: string;
  onAdd: () => void;
  items: Array<{
    id: string;
    icon: typeof Coffee;
    title: string;
    detail: string;
  }>;
}) {
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-bold">{title}</h2>
        <button
          type="button"
          className="button-secondary min-h-9 px-2.5 text-sm"
          onClick={onAdd}
        >
          <Plus className="h-4 w-4" />
          Add
        </button>
      </div>
      <div className="panel divide-y divide-line">
        {items.map(({ id, icon: Icon, title: itemTitle, detail }) => (
          <div className="flex min-h-16 items-center gap-3 px-4" key={id}>
            <span className="flex h-9 w-9 items-center justify-center rounded-md bg-canvas">
              <Icon className="h-4 w-4 text-muted" />
            </span>
            <span>
              <span className="block font-semibold">{itemTitle}</span>
              <span className="block text-xs capitalize text-muted">
                {detail}
              </span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function AddDialog({
  kind,
  onClose,
}: {
  kind: "bean" | "machine" | "grinder";
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [secondary, setSecondary] = useState("");
  const [roast, setRoast] = useState<RoastLevel>("medium");
  async function save() {
    const createdAt = new Date().toISOString();
    if (kind === "bean")
      await saveBean({
        id: makeId(),
        name: name.trim(),
        roaster: secondary.trim(),
        roastLevel: roast,
        createdAt,
      });
    if (kind === "machine")
      await saveMachine({
        id: makeId(),
        name: name.trim(),
        temperatureControl: "none",
        hasPressureControl: false,
        hasPreinfusion: false,
        createdAt,
      });
    if (kind === "grinder")
      await saveGrinder({
        id: makeId(),
        name: name.trim(),
        finerDirection: "lower",
        createdAt,
      });
    onClose();
  }
  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-ink/35 sm:items-center sm:justify-center sm:p-5"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        className="w-full rounded-t-lg bg-white p-5 sm:max-w-md sm:rounded-lg"
      >
        <div className="mb-5 flex items-center gap-3">
          <Settings className="h-5 w-5 text-leaf" />
          <h2 className="text-lg font-black capitalize">Add {kind}</h2>
        </div>
        <label>
          <span className="label">Name</span>
          <input
            className="field mb-4"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </label>
        {kind === "bean" && (
          <>
            <label>
              <span className="label">Roaster</span>
              <input
                className="field mb-4"
                value={secondary}
                onChange={(e) => setSecondary(e.target.value)}
              />
            </label>
            <span className="label">Roast</span>
            <Segmented
              value={roast}
              onChange={setRoast}
              options={[
                { value: "light", label: "Light" },
                { value: "medium", label: "Medium" },
                { value: "dark", label: "Dark" },
              ]}
            />
          </>
        )}
        <div className="mt-6 grid grid-cols-2 gap-3">
          <button className="button-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button-primary"
            type="button"
            disabled={!name.trim() || (kind === "bean" && !secondary.trim())}
            onClick={() => void save()}
          >
            Add
          </button>
        </div>
      </section>
    </div>
  );
}

function toCsv(brews: Brew[], beans: Bean[]) {
  const rows = [
    [
      "date",
      "coffee",
      "dose_g",
      "yield_g",
      "duration_s",
      "grind",
      "ratio",
      "enjoyment",
      "dialed",
    ],
    ...brews.map((brew) => [
      brew.createdAt,
      beans.find((bean) => bean.id === brew.beanId)?.name ?? "",
      brew.dose,
      brew.yield,
      brew.duration,
      brew.grind,
      brew.ratio,
      brew.taste.enjoyment,
      Boolean(brew.dialedAt),
    ]),
  ];
  return rows
    .map((row) =>
      row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","),
    )
    .join("\n");
}
