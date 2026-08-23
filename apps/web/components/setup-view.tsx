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
  discardAnonymousData,
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
  AccountMismatchError,
  deleteAccountAndClear,
  signInWithGoogle,
  signOut,
  type SyncStatus,
} from "@/lib/sync";
import { PageHeading, Segmented } from "./ui";

type SetupTab = "coffee" | "equipment" | "settings";

export type OwnerCacheResetResult =
  | { cleared: false; reason: "pending-operations"; pendingCount: number }
  | { cleared: true; rebuilt: boolean };

export function SetupView({
  ownerId,
  beans,
  machines,
  grinders,
  brews,
  pendingCount,
  account,
  syncStatus,
  onSync,
  onResetOwnerCache,
  onAccountChanged,
}: {
  ownerId: string;
  beans: Bean[];
  machines: Machine[];
  grinders: Grinder[];
  brews: Brew[];
  pendingCount: number;
  account: AccountUser | null;
  syncStatus: SyncStatus;
  onSync: () => Promise<boolean>;
  onResetOwnerCache: () => Promise<OwnerCacheResetResult | undefined>;
  onAccountChanged: () => Promise<void>;
}) {
  const [tab, setTab] = useState<SetupTab>("coffee");
  const [adding, setAdding] = useState<"bean" | "machine" | "grinder">();
  const [resetting, setResetting] = useState(false);

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
    if (!account) {
      if (
        !window.confirm(
          "Permanently delete all anonymous coffee, equipment, and brew data from this device? This cannot be undone.",
        )
      )
        return;
      setResetting(true);
      try {
        await discardAnonymousData();
      } finally {
        setResetting(false);
      }
      return;
    }

    if (
      !window.confirm(
        "Rebuild this account's local cache from the cloud? Synced local data will be removed and downloaded again.",
      )
    )
      return;
    setResetting(true);
    try {
      const result = await onResetOwnerCache();
      if (!result) {
        window.alert(
          "The local cache was not changed. Try again when account sync is available.",
        );
        return;
      }
      if (!result.cleared) {
        window.alert(
          `${result.pendingCount} unsynced operation${result.pendingCount === 1 ? "" : "s"} must be synced first. Nothing was cleared.`,
        );
        return;
      }
      if (!result.rebuilt) {
        window.alert(
          "The local cache was cleared, but it could not be rebuilt. Sync again when the connection is available.",
        );
        return;
      }
      window.alert("This account's local cache was rebuilt from the cloud.");
    } finally {
      setResetting(false);
    }
  }

  async function removeAccount() {
    if (!account) return;
    if (
      !window.confirm(
        "Delete your Dialed account and all cloud data? This cannot be undone.",
      )
    )
      return;
    try {
      await deleteAccountAndClear(ownerId, account.id);
    } catch (error) {
      if (error instanceof AccountMismatchError) {
        await onAccountChanged();
        return;
      }
      throw error;
    }
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
                    disabled={syncStatus === "syncing" || resetting}
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
                    disabled={resetting}
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
              disabled={
                resetting || (Boolean(account) && syncStatus === "syncing")
              }
            >
              <Trash2 className="h-5 w-5" />
              <span className="flex-1">
                <span className="block font-semibold">
                  {account ? "Rebuild local cache" : "Delete anonymous data"}
                </span>
                <span className="block text-xs text-muted">
                  {account
                    ? pendingCount
                      ? `${pendingCount} unsynced operation${pendingCount === 1 ? "" : "s"}; sync before rebuilding`
                      : "Replace this account's local data from the cloud"
                    : "Permanently remove local-mode data from this device"}
                </span>
              </span>
            </button>
          </section>
          {account && (
            <button
              type="button"
              className="flex min-h-12 w-full items-center justify-center gap-2 rounded-md border border-coral/30 bg-white px-4 font-semibold text-coral"
              onClick={() => void removeAccount()}
              disabled={resetting}
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
        <AddDialog
          ownerId={ownerId}
          kind={adding}
          onClose={() => setAdding(undefined)}
        />
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
  ownerId,
  kind,
  onClose,
}: {
  ownerId: string;
  kind: "bean" | "machine" | "grinder";
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [secondary, setSecondary] = useState("");
  const [roast, setRoast] = useState<RoastLevel>("medium");
  async function save() {
    const createdAt = new Date().toISOString();
    if (kind === "bean")
      await saveBean(ownerId, {
        id: makeId(),
        name: name.trim(),
        roaster: secondary.trim(),
        roastLevel: roast,
        createdAt,
      });
    if (kind === "machine")
      await saveMachine(ownerId, {
        id: makeId(),
        name: name.trim(),
        temperatureControl: "none",
        hasPressureControl: false,
        hasPreinfusion: false,
        createdAt,
      });
    if (kind === "grinder")
      await saveGrinder(ownerId, {
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
