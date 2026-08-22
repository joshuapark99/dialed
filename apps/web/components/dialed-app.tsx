"use client";

import { useCallback, useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  Coffee,
  History,
  Home,
  Plus,
  Settings2,
  Wifi,
  WifiOff,
} from "lucide-react";
import { db } from "@/lib/db";
import type { AccountUser, Brew } from "@/lib/models";
import { getCurrentUser, synchronize, type SyncStatus } from "@/lib/sync";
import { BrewLog } from "./brew-log";
import { BrewResult } from "./brew-result";
import { HistoryView } from "./history-view";
import { HomeView } from "./home-view";
import { Onboarding } from "./onboarding";
import { SetupView } from "./setup-view";
import { Brand } from "./ui";

type View = "home" | "log" | "history" | "setup" | "result";

const navItems = [
  { value: "home" as const, label: "Home", icon: Home },
  { value: "history" as const, label: "History", icon: History },
  { value: "setup" as const, label: "Setup", icon: Settings2 },
];

export function DialedApp() {
  const beans =
    useLiveQuery(() => db.beans.orderBy("createdAt").reverse().toArray(), []) ??
    [];
  const machines =
    useLiveQuery(
      () => db.machines.orderBy("createdAt").reverse().toArray(),
      [],
    ) ?? [];
  const grinders =
    useLiveQuery(
      () => db.grinders.orderBy("createdAt").reverse().toArray(),
      [],
    ) ?? [];
  const brews =
    useLiveQuery(() => db.brews.orderBy("createdAt").reverse().toArray(), []) ??
    [];
  const pendingCount = useLiveQuery(() => db.operations.count(), []) ?? 0;
  const setupState = useLiveQuery(
    async () => ({
      onboarded: await db.preferences.get("onboarded"),
      profileCount: await db.beans.count(),
    }),
    [],
  );
  const [view, setView] = useState<View>("home");
  const [result, setResult] = useState<Brew>();
  const [online, setOnline] = useState(true);
  const [account, setAccount] = useState<AccountUser | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("local");
  const loaded = setupState !== undefined;

  const refreshAccount = useCallback(async () => {
    const current = await getCurrentUser();
    setAccount(current);
    setSyncStatus(current ? "synced" : "local");
  }, []);

  const runSync = useCallback(async () => {
    if (!navigator.onLine) {
      setSyncStatus("offline");
      return;
    }
    setSyncStatus("syncing");
    try {
      await synchronize();
      setSyncStatus("synced");
    } catch {
      setSyncStatus("error");
    }
  }, []);

  useEffect(() => {
    setOnline(navigator.onLine);
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    void refreshAccount();
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, [refreshAccount]);

  useEffect(() => {
    if (!account) return;
    const onFocus = () => void runSync();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [account, runSync]);

  useEffect(() => {
    if (account && online) void runSync();
  }, [account, online, pendingCount, runSync]);

  if (!loaded) return <Loading />;
  if (
    !setupState?.onboarded ||
    !setupState.profileCount ||
    !machines.length ||
    !grinders.length
  )
    return <Onboarding />;

  const navigate = (next: View) => {
    setView(next);
    if (next !== "result") setResult(undefined);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const content = (() => {
    if (view === "log")
      return (
        <BrewLog
          beans={beans}
          machines={machines}
          grinders={grinders}
          brews={brews}
          onCancel={() => navigate("home")}
          onSaved={(brew) => {
            setResult(brew);
            setView("result");
          }}
        />
      );
    if (view === "result" && result)
      return (
        <BrewResult
          brew={result}
          bean={beans.find((bean) => bean.id === result.beanId)}
          reference={brews.find((brew) => brew.id === result.comparisonBrewId)}
          onDone={() => navigate("home")}
          onLogAnother={() => navigate("log")}
        />
      );
    if (view === "history")
      return (
        <HistoryView
          beans={beans}
          brews={brews}
          onLog={() => navigate("log")}
        />
      );
    if (view === "setup")
      return (
        <SetupView
          beans={beans}
          machines={machines}
          grinders={grinders}
          brews={brews}
          account={account}
          syncStatus={syncStatus}
          onSync={runSync}
          onAccountChanged={refreshAccount}
        />
      );
    return (
      <HomeView
        beans={beans}
        brews={brews}
        onLog={() => navigate("log")}
        onHistory={() => navigate("history")}
      />
    );
  })();

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[14rem_minmax(0,1fr)]">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-56 flex-col border-r border-line bg-white px-4 py-6 lg:flex">
        <div className="px-2">
          <Brand />
        </div>
        <nav className="mt-10 space-y-1">
          {navItems.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => navigate(value)}
              className={`flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-sm font-bold transition ${view === value ? "bg-ink text-white" : "text-muted hover:bg-canvas hover:text-ink"}`}
            >
              <Icon className="h-5 w-5" />
              {label}
            </button>
          ))}
        </nav>
        <button
          type="button"
          onClick={() => navigate("log")}
          className="button-primary mt-5"
        >
          <Plus className="h-5 w-5" />
          Log brew
        </button>
        <div className="mt-auto flex items-center gap-2 px-2 text-xs font-semibold text-muted">
          {online ? (
            <Wifi className="h-4 w-4 text-leaf" />
          ) : (
            <WifiOff className="h-4 w-4 text-sun" />
          )}
          {!online
            ? "Working offline"
            : account
              ? syncStatus === "syncing"
                ? "Syncing changes"
                : pendingCount
                  ? `${pendingCount} pending`
                  : "Cloud synced"
              : "Local data ready"}
        </div>
      </aside>

      <div className="lg:col-start-2">
        <header className="sticky top-0 z-20 border-b border-line bg-canvas/95 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur sm:px-6 lg:px-8">
          <div className="mx-auto flex max-w-5xl items-center justify-between lg:justify-end">
            <div className="lg:hidden">
              <Brand />
            </div>
            <div
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold ${online ? "border-leaf/20 bg-leaf/5 text-leaf" : "border-sun/30 bg-sun/10 text-ink"}`}
            >
              {online ? (
                <Wifi className="h-3 w-3" />
              ) : (
                <WifiOff className="h-3 w-3" />
              )}
              {!online
                ? "Offline"
                : syncStatus === "syncing"
                  ? "Syncing"
                  : account
                    ? pendingCount
                      ? `${pendingCount} pending`
                      : "Synced"
                    : "Saved locally"}
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {content}
        </main>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-line bg-white px-2 pb-[env(safe-area-inset-bottom)] lg:hidden">
        <MobileNav
          value="home"
          current={view}
          label="Home"
          icon={Home}
          onClick={() => navigate("home")}
        />
        <MobileNav
          value="history"
          current={view}
          label="History"
          icon={History}
          onClick={() => navigate("history")}
        />
        <button
          type="button"
          onClick={() => navigate("log")}
          className="relative flex min-h-[4.5rem] flex-col items-center justify-center gap-1 text-xs font-bold text-ink"
        >
          <span className="absolute -top-4 flex h-12 w-12 items-center justify-center rounded-full border-4 border-canvas bg-coral text-white shadow-lg">
            <Plus className="h-6 w-6" />
          </span>
          <span className="mt-8">Log</span>
        </button>
        <MobileNav
          value="setup"
          current={view}
          label="Setup"
          icon={Settings2}
          onClick={() => navigate("setup")}
        />
      </nav>
    </div>
  );
}

function MobileNav({
  value,
  current,
  label,
  icon: Icon,
  onClick,
}: {
  value: View;
  current: View;
  label: string;
  icon: typeof Home;
  onClick: () => void;
}) {
  const active = value === current;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex min-h-[4.5rem] flex-col items-center justify-center gap-1 text-xs font-bold ${active ? "text-leaf" : "text-muted"}`}
    >
      <Icon className="h-5 w-5" />
      {label}
    </button>
  );
}

function Loading() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <div className="flex items-center gap-3">
        <Coffee className="h-6 w-6 animate-pulse text-leaf" />
        <span className="font-black">Loading Dialed</span>
      </div>
    </div>
  );
}
