"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  Coffee,
  History,
  Home,
  Plus,
  RefreshCw,
  Settings2,
  Wifi,
  WifiOff,
} from "lucide-react";
import {
  ANONYMOUS_TRANSFER_SOURCE_MARKER_KEY,
  AnonymousTransferSummaryChangedError,
  deferAnonymousTransfer,
  getAnonymousTransferOffer,
  getAnonymousTransferSummary,
  type AnonymousTransferSummary,
} from "@/lib/anonymous-transfer";
import {
  PendingAccountSyncScheduler,
  TransferDiscoveryGuard,
  anonymousTransferErrorMessage,
  reconcileAnonymousTransferRecovery,
  recoveryForAnonymousTransferError,
  shouldPresentAnonymousTransferOffer,
  type AnonymousTransferRecovery,
} from "@/lib/anonymous-transfer-ui";
import {
  ANONYMOUS_OWNER_ID,
  db,
  getBrews,
  getCoffeeBags,
  getCoffees,
  getGrinders,
  getMachines,
  getOwnerPreference,
  setOwnerPreference,
} from "@/lib/db";
import type { AccountUser, Brew } from "@/lib/models";
import {
  isRecoverableActiveTransfer,
  requiresOnboarding,
  shouldDeferAnonymousTransfer,
} from "@/lib/onboarding-state";
import {
  AccountMismatchError,
  AuthenticationExpiredError,
  getCurrentUser,
  isCloudIdentityStorageEvent,
  moveAnonymousDataToAccount,
  ownerIdForAccount,
  OwnerCacheRebuildError,
  resetAndSynchronize,
  synchronize,
  type SyncStatus,
} from "@/lib/sync";
import { BrewLog } from "./brew-log";
import { BrewResult } from "./brew-result";
import { HistoryView } from "./history-view";
import { HomeView } from "./home-view";
import { LocalDataTransferDialog } from "./local-data-transfer-dialog";
import { Onboarding } from "./onboarding";
import { SetupView, type OwnerCacheResetResult } from "./setup-view";
import { Brand } from "./ui";

type View = "home" | "log" | "history" | "setup" | "result";

type AccountInitialization =
  | { status: "syncing" }
  | { status: "checking-transfer" }
  | { status: "offering"; summary: AnonymousTransferSummary }
  | {
      status: "consent-changed";
      summary: AnonymousTransferSummary;
      message: string;
    }
  | { status: "ready" }
  | {
      status: "transfer-error";
      summary: AnonymousTransferSummary;
      message: string;
    };

type SyncAttempt = "success" | "unavailable" | "identity-changed";

const navItems = [
  { value: "home" as const, label: "Home", icon: Home },
  { value: "history" as const, label: "History", icon: History },
  { value: "setup" as const, label: "Setup", icon: Settings2 },
];

export function DialedApp() {
  const applicationFocusRef = useRef<HTMLDivElement>(null);
  const activeOwnerIdRef = useRef<string | undefined>(undefined);
  const [accountState, setAccountState] = useState<
    | { status: "loading" }
    | { status: "error" }
    | { status: "resolved"; account: AccountUser | null }
  >({ status: "loading" });

  const refreshAccount = useCallback(async () => {
    activeOwnerIdRef.current = undefined;
    setAccountState({ status: "loading" });
    try {
      const account = await getCurrentUser();
      activeOwnerIdRef.current = account
        ? ownerIdForAccount(account.id)
        : ANONYMOUS_OWNER_ID;
      setAccountState({ status: "resolved", account });
    } catch {
      setAccountState({ status: "error" });
    }
  }, []);
  const continueWithLocalData = useCallback(async () => {
    localStorage.removeItem("dialed-cloud-enabled");
    await refreshAccount();
  }, [refreshAccount]);
  const isOwnerCurrent = useCallback(
    (ownerId: string) => activeOwnerIdRef.current === ownerId,
    [],
  );

  useEffect(() => {
    void refreshAccount();
  }, [refreshAccount]);

  useEffect(() => {
    const refreshChangedIdentity = (event: StorageEvent) => {
      if (isCloudIdentityStorageEvent(event)) void refreshAccount();
    };
    window.addEventListener("storage", refreshChangedIdentity);
    return () => window.removeEventListener("storage", refreshChangedIdentity);
  }, [refreshAccount]);

  let content;
  if (accountState.status === "loading") {
    content = <Loading />;
  } else if (accountState.status === "error") {
    content = (
      <AccountLookupError
        onRetry={refreshAccount}
        onContinue={continueWithLocalData}
      />
    );
  } else {
    const { account } = accountState;
    const ownerId = account
      ? ownerIdForAccount(account.id)
      : ANONYMOUS_OWNER_ID;
    content = (
      <OwnerApplication
        key={ownerId}
        ownerId={ownerId}
        account={account}
        onAccountChanged={refreshAccount}
        isOwnerCurrent={isOwnerCurrent}
        returnFocusRef={applicationFocusRef}
      />
    );
  }
  return (
    <div
      ref={applicationFocusRef}
      tabIndex={-1}
      className="min-h-dvh outline-none"
    >
      {content}
    </div>
  );
}

function OwnerApplication({
  ownerId,
  account,
  onAccountChanged,
  isOwnerCurrent,
  returnFocusRef,
}: {
  ownerId: string;
  account: AccountUser | null;
  onAccountChanged: () => Promise<void>;
  isOwnerCurrent: (ownerId: string) => boolean;
  returnFocusRef: React.RefObject<HTMLElement | null>;
}) {
  const coffees = useLiveQuery(
    async () => (await getCoffees(ownerId)).reverse(),
    [ownerId],
  );
  const bags = useLiveQuery(
    async () => (await getCoffeeBags(ownerId)).reverse(),
    [ownerId],
  );
  const machines = useLiveQuery(
    async () => (await getMachines(ownerId)).reverse(),
    [ownerId],
  );
  const grinders = useLiveQuery(
    async () => (await getGrinders(ownerId)).reverse(),
    [ownerId],
  );
  const brews = useLiveQuery(
    async () => (await getBrews(ownerId)).reverse(),
    [ownerId],
  );
  const pendingCount = useLiveQuery(
    () => db.operations.where("ownerId").equals(ownerId).count(),
    [ownerId],
  );
  const setupState = useLiveQuery(
    async () => ({
      onboarded: await getOwnerPreference(ownerId, "onboarded"),
      profileCount: await db.bags.where("ownerId").equals(ownerId).count(),
    }),
    [ownerId],
  );
  const anonymousTransferSummary = useLiveQuery(
    () => getAnonymousTransferSummary(),
    [],
  );
  const [view, setView] = useState<View>("home");
  const [result, setResult] = useState<Brew>();
  const [online, setOnline] = useState(true);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("local");
  const [resettingOwner, setResettingOwner] = useState(false);
  const [accountInitialization, setAccountInitialization] =
    useState<AccountInitialization>(
      account ? { status: "syncing" } : { status: "ready" },
    );
  const [transferInFlight, setTransferInFlight] = useState(false);
  const [anonymousTransferRecovery, setAnonymousTransferRecovery] =
    useState<AnonymousTransferRecovery>();
  const accountInitializationRef = useRef(accountInitialization);
  const transferInFlightRef = useRef(false);
  const anonymousTransferRecoveryRef = useRef<
    AnonymousTransferRecovery | undefined
  >(undefined);
  const initializationStartedRef = useRef(false);
  const pendingSyncSchedulerRef = useRef(new PendingAccountSyncScheduler());
  const transferDiscoveryGuardRef = useRef(new TransferDiscoveryGuard(ownerId));
  const presentedAnonymousTransferRecovery = reconcileAnonymousTransferRecovery(
    anonymousTransferRecovery,
    anonymousTransferSummary,
  );

  const updateAccountInitialization = useCallback(
    (next: AccountInitialization) => {
      accountInitializationRef.current = next;
      setAccountInitialization(next);
    },
    [],
  );
  const updateTransferInFlight = useCallback((next: boolean) => {
    transferInFlightRef.current = next;
    setTransferInFlight(next);
  }, []);
  const updateAnonymousTransferRecovery = useCallback(
    (next: AnonymousTransferRecovery | undefined) => {
      anonymousTransferRecoveryRef.current = next;
      setAnonymousTransferRecovery(next);
    },
    [],
  );
  const loaded =
    setupState !== undefined &&
    coffees !== undefined &&
    bags !== undefined &&
    machines !== undefined &&
    grinders !== undefined &&
    brews !== undefined &&
    pendingCount !== undefined;

  const runSync = useCallback(async (): Promise<SyncAttempt> => {
    if (!account) {
      setSyncStatus("local");
      return "unavailable";
    }
    if (!navigator.onLine) {
      setSyncStatus("offline");
      return "unavailable";
    }
    setSyncStatus("syncing");
    try {
      await synchronize(ownerId);
      setSyncStatus("synced");
      return "success";
    } catch (error) {
      if (
        error instanceof AuthenticationExpiredError ||
        error instanceof AccountMismatchError
      ) {
        setSyncStatus("local");
        await onAccountChanged();
        return "identity-changed";
      }
      setSyncStatus("error");
      return "unavailable";
    }
  }, [account, onAccountChanged, ownerId]);

  const discoverTransferOffer = useCallback(
    async (
      ticket: ReturnType<TransferDiscoveryGuard["beginDiscovery"]>,
      mode: "initial" | "background",
    ) => {
      const guard = transferDiscoveryGuardRef.current;
      if (!isOwnerCurrent(ownerId) || !guard.canCommit(ticket, ownerId)) return;
      if (mode === "initial") {
        updateAccountInitialization({ status: "checking-transfer" });
      }
      try {
        let summary = await getAnonymousTransferOffer(ownerId);
        if (!summary) {
          const activeDestinationOwnerId = await getOwnerPreference(
            ANONYMOUS_OWNER_ID,
            ANONYMOUS_TRANSFER_SOURCE_MARKER_KEY,
          );
          if (isRecoverableActiveTransfer(activeDestinationOwnerId, ownerId)) {
            const activeSummary = await getAnonymousTransferSummary();
            if (activeSummary.hasData) summary = activeSummary;
          }
        }
        if (!isOwnerCurrent(ownerId) || !guard.canCommit(ticket, ownerId)) {
          return;
        }
        updateAccountInitialization(
          shouldPresentAnonymousTransferOffer(
            summary,
            anonymousTransferRecoveryRef.current,
          )
            ? { status: "offering", summary }
            : { status: "ready" },
        );
      } catch {
        if (!isOwnerCurrent(ownerId) || !guard.canCommit(ticket, ownerId)) {
          return;
        }
        setSyncStatus("error");
        updateAccountInitialization({ status: "ready" });
      }
    },
    [isOwnerCurrent, ownerId, updateAccountInitialization],
  );

  const syncAndDiscoverTransfer = useCallback(
    async (mode: "initial" | "background" = "background") => {
      if (mode === "background" && transferInFlightRef.current) {
        return "unavailable" as const;
      }
      const guard = transferDiscoveryGuardRef.current;
      const ticket = guard.beginDiscovery();
      const result = await runSync();
      if (result === "success") {
        await discoverTransferOffer(ticket, mode);
      } else if (
        mode === "initial" &&
        result === "unavailable" &&
        isOwnerCurrent(ownerId) &&
        guard.canCommit(ticket, ownerId)
      ) {
        updateAccountInitialization({ status: "ready" });
      }
      return result;
    },
    [
      discoverTransferOffer,
      isOwnerCurrent,
      ownerId,
      runSync,
      updateAccountInitialization,
    ],
  );

  const syncFromUi = useCallback(
    async () => (await syncAndDiscoverTransfer()) === "success",
    [syncAndDiscoverTransfer],
  );

  const moveAnonymousData = useCallback(
    async (summary: AnonymousTransferSummary) => {
      if (!account) throw new Error("Transfer destination must be an account");
      const guard = transferDiscoveryGuardRef.current;
      guard.beginTransfer();
      updateTransferInFlight(true);
      setSyncStatus("syncing");
      try {
        const result = await moveAnonymousDataToAccount(ownerId, summary);
        if (!result.completed) {
          throw new Error(
            `Local data is still syncing (${result.pendingCount} pending). Try again.`,
          );
        }
        updateAnonymousTransferRecovery(undefined);
        setSyncStatus("synced");
      } catch (error) {
        if (
          error instanceof AuthenticationExpiredError ||
          error instanceof AccountMismatchError
        ) {
          setSyncStatus("local");
          await onAccountChanged();
          throw error;
        }
        const recovery = recoveryForAnonymousTransferError(error, summary);
        updateAnonymousTransferRecovery(recovery);
        setSyncStatus("error");
        throw error;
      } finally {
        guard.finishTransfer();
        updateTransferInFlight(false);
      }
    },
    [
      account,
      onAccountChanged,
      ownerId,
      updateAnonymousTransferRecovery,
      updateTransferInFlight,
    ],
  );

  const resetOwnerCache = useCallback(async (): Promise<
    OwnerCacheResetResult | undefined
  > => {
    if (!account) return undefined;
    if (!navigator.onLine) {
      setSyncStatus("offline");
      return undefined;
    }
    setResettingOwner(true);
    setSyncStatus("syncing");
    let cacheCleared = false;
    try {
      const result = await resetAndSynchronize(ownerId);
      if (!result.cleared) {
        setSyncStatus("local");
        return result;
      }
      cacheCleared = true;
      await setOwnerPreference(ownerId, "onboarded", "true");
      setSyncStatus("synced");
      return { cleared: true, rebuilt: true };
    } catch (error) {
      const syncError =
        error instanceof OwnerCacheRebuildError ? error.cause : error;
      if (
        syncError instanceof AuthenticationExpiredError ||
        syncError instanceof AccountMismatchError
      ) {
        setSyncStatus("local");
        await onAccountChanged();
      } else {
        setSyncStatus("error");
      }
      return error instanceof OwnerCacheRebuildError || cacheCleared
        ? { cleared: true, rebuilt: false }
        : undefined;
    } finally {
      setResettingOwner(false);
    }
  }, [account, onAccountChanged, ownerId]);

  useEffect(() => {
    if (!loaded || !account || initializationStartedRef.current) return;
    initializationStartedRef.current = true;
    void syncAndDiscoverTransfer("initial");
  }, [account, loaded, syncAndDiscoverTransfer]);

  useEffect(() => {
    const current = anonymousTransferRecoveryRef.current;
    const next = reconcileAnonymousTransferRecovery(
      current,
      anonymousTransferSummary,
    );
    if (next !== current) updateAnonymousTransferRecovery(next);
  }, [
    anonymousTransferRecovery,
    anonymousTransferSummary,
    updateAnonymousTransferRecovery,
  ]);

  useEffect(() => {
    setOnline(navigator.onLine);
    const update = () => {
      const nextOnline = navigator.onLine;
      setOnline(nextOnline);
      if (
        nextOnline &&
        account &&
        !transferInFlightRef.current &&
        accountInitializationRef.current.status === "ready"
      ) {
        void syncAndDiscoverTransfer();
      }
    };
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, [account, syncAndDiscoverTransfer]);

  useEffect(() => {
    if (!account) return;
    const onFocus = () => {
      if (
        !transferInFlightRef.current &&
        accountInitializationRef.current.status === "ready"
      ) {
        void syncAndDiscoverTransfer();
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [account, syncAndDiscoverTransfer]);

  useEffect(() => {
    if (pendingCount === undefined) return;
    if (
      pendingSyncSchedulerRef.current.observe({
        authenticated: Boolean(account),
        ready: accountInitialization.status === "ready",
        online,
        transferInFlight,
        pendingCount,
      })
    ) {
      void syncAndDiscoverTransfer();
    }
  }, [
    account,
    accountInitialization.status,
    online,
    pendingCount,
    syncAndDiscoverTransfer,
    transferInFlight,
  ]);

  async function startInitialTransfer() {
    if (
      transferInFlightRef.current ||
      (accountInitialization.status !== "offering" &&
        accountInitialization.status !== "consent-changed" &&
        accountInitialization.status !== "transfer-error")
    )
      return;
    const summary = accountInitialization.summary;
    try {
      await moveAnonymousData(summary);
      updateAccountInitialization({ status: "ready" });
    } catch (error) {
      if (
        error instanceof AuthenticationExpiredError ||
        error instanceof AccountMismatchError
      )
        return;
      const recovery = recoveryForAnonymousTransferError(error, summary);
      updateAccountInitialization({
        status:
          error instanceof AnonymousTransferSummaryChangedError
            ? "consent-changed"
            : "transfer-error",
        summary: recovery.summary,
        message: recovery.message,
      });
    }
  }

  async function dismissInitialTransfer() {
    if (transferInFlightRef.current) return;
    transferDiscoveryGuardRef.current.invalidate();
    if (
      accountInitialization.status === "transfer-error" &&
      !shouldDeferAnonymousTransfer(accountInitialization.status)
    ) {
      updateAnonymousTransferRecovery({
        summary: accountInitialization.summary,
        message: accountInitialization.message,
      });
      updateAccountInitialization({ status: "ready" });
      return;
    }
    if (
      accountInitialization.status !== "offering" &&
      accountInitialization.status !== "consent-changed"
    )
      return;
    try {
      await deferAnonymousTransfer(ownerId);
      updateAnonymousTransferRecovery(undefined);
      updateAccountInitialization({ status: "ready" });
    } catch (error) {
      const message = anonymousTransferErrorMessage(error);
      updateAnonymousTransferRecovery({
        summary: accountInitialization.summary,
        message,
      });
      updateAccountInitialization({
        status: "transfer-error",
        summary: accountInitialization.summary,
        message,
      });
    }
  }

  if (!loaded || resettingOwner) return <Loading />;
  if (
    account &&
    (accountInitialization.status === "syncing" ||
      accountInitialization.status === "checking-transfer")
  )
    return <Loading />;
  if (
    accountInitialization.status === "offering" ||
    accountInitialization.status === "consent-changed" ||
    accountInitialization.status === "transfer-error"
  ) {
    return (
      <LocalDataTransferDialog
        summary={accountInitialization.summary}
        status={
          transferInFlight
            ? "moving"
            : accountInitialization.status === "transfer-error" ||
                accountInitialization.status === "consent-changed"
              ? "error"
              : "offering"
        }
        error={
          accountInitialization.status === "transfer-error" ||
          accountInitialization.status === "consent-changed"
            ? accountInitialization.message
            : undefined
        }
        onMove={() => void startInitialTransfer()}
        onNotNow={() => void dismissInitialTransfer()}
        returnFocusRef={returnFocusRef}
      />
    );
  }
  if (
    requiresOnboarding({
      authenticated: Boolean(account),
      accountInitialization: accountInitialization.status,
      onboarded: setupState?.onboarded,
      beanCount: setupState?.profileCount ?? 0,
      machineCount: machines.length,
      grinderCount: grinders.length,
    })
  )
    return <Onboarding ownerId={ownerId} />;

  const navigate = (next: View) => {
    setView(next);
    if (next !== "result") setResult(undefined);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const content = (() => {
    if (view === "log")
      return (
        <BrewLog
          ownerId={ownerId}
          coffees={coffees}
          bags={bags}
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
    if (view === "result" && result) {
      const bag = bags.find((item) => item.id === result.beanId);
      const coffee = bag
        ? coffees.find((item) => item.id === bag.coffeeId)
        : undefined;
      return (
        <BrewResult
          ownerId={ownerId}
          brew={result}
          coffee={coffee}
          bag={bag}
          reference={brews.find(
            (brew) =>
              brew.id === result.comparisonBrewId &&
              brew.beanId === result.beanId,
          )}
          onDone={() => navigate("home")}
          onLogAnother={() => navigate("log")}
        />
      );
    }
    if (view === "history")
      return (
        <HistoryView
          ownerId={ownerId}
          coffees={coffees}
          bags={bags}
          brews={brews}
          onLog={() => navigate("log")}
        />
      );
    if (view === "setup")
      return (
        <SetupView
          ownerId={ownerId}
          coffees={coffees}
          bags={bags}
          machines={machines}
          grinders={grinders}
          brews={brews}
          pendingCount={pendingCount}
          account={account}
          syncStatus={syncStatus}
          onSync={syncFromUi}
          onResetOwnerCache={resetOwnerCache}
          onAccountChanged={onAccountChanged}
          anonymousTransferSummary={anonymousTransferSummary}
          anonymousTransferRecovery={presentedAnonymousTransferRecovery}
          onMoveAnonymousData={moveAnonymousData}
        />
      );
    return (
      <HomeView
        coffees={coffees}
        bags={bags}
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
          {desktopStatusLabel(online, account, syncStatus, pendingCount)}
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
              {compactStatusLabel(online, account, syncStatus, pendingCount)}
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

function AccountLookupError({
  onRetry,
  onContinue,
}: {
  onRetry: () => Promise<void>;
  onContinue: () => Promise<void>;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-5">
      <section role="alert" className="max-w-md text-center">
        <Coffee className="mx-auto h-8 w-8 text-coral" />
        <h1 className="mt-4 text-2xl font-black">Account unavailable</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Dialed could not confirm which account owns this device's data. Try
          again before continuing.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          You can also continue with local data. Account data will stay hidden
          on this device.
        </p>
        <div className="mt-5 flex flex-col items-center gap-3">
          <button
            type="button"
            className="button-primary"
            onClick={() => void onRetry()}
          >
            <RefreshCw className="h-4 w-4" />
            Retry
          </button>
          <button
            type="button"
            className="button-secondary"
            onClick={() => void onContinue()}
          >
            Continue with local data
          </button>
        </div>
      </section>
    </main>
  );
}

function desktopStatusLabel(
  online: boolean,
  account: AccountUser | null,
  syncStatus: SyncStatus,
  pendingCount: number,
): string {
  if (!online || syncStatus === "offline") return "Working offline";
  if (!account) return "Local data ready";
  if (syncStatus === "syncing") return "Syncing changes";
  if (syncStatus === "error") return "Sync error";
  if (syncStatus === "local") return "Cloud not synced";
  return pendingCount ? `${pendingCount} pending` : "Cloud synced";
}

function compactStatusLabel(
  online: boolean,
  account: AccountUser | null,
  syncStatus: SyncStatus,
  pendingCount: number,
): string {
  if (!online || syncStatus === "offline") return "Offline";
  if (!account) return "Saved locally";
  if (syncStatus === "syncing") return "Syncing";
  if (syncStatus === "error") return "Sync error";
  if (syncStatus === "local") return "Not synced";
  return pendingCount ? `${pendingCount} pending` : "Synced";
}
