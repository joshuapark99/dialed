import { applyRemoteOperation, db } from "./db";
import type { AccountUser, SyncEntity } from "./models";

const cursorKey = "sync-cursor";
const cloudEnabledKey = "dialed-cloud-enabled";

interface PullOperation {
  operationId: string;
  entity: SyncEntity;
  entityId: string;
  action: "upsert" | "delete";
  payload?: Record<string, unknown> | null;
  revision: number;
}

export type SyncStatus = "local" | "syncing" | "synced" | "offline" | "error";

export async function getCurrentUser(): Promise<AccountUser | null> {
  if (localStorage.getItem(cloudEnabledKey) !== "true") return null;
  try {
    const response = await fetch("/api/v1/me", { credentials: "include" });
    if (response.status === 401) return null;
    if (!response.ok) throw new Error("Account lookup failed");
    const body = (await response.json()) as { user: AccountUser };
    return body.user;
  } catch {
    return null;
  }
}

export async function signInWithGoogle(): Promise<void> {
  const response = await fetch("/api/auth/sign-in/social", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "google",
      callbackURL: window.location.origin,
    }),
  });
  if (!response.ok) throw new Error("Google sign-in could not be started");
  const result = (await response.json()) as {
    url?: string;
    redirect?: boolean;
  };
  if (!result.url) throw new Error("Google sign-in did not return a redirect");
  localStorage.setItem(cloudEnabledKey, "true");
  window.location.assign(result.url);
}

export async function signOut(): Promise<void> {
  await fetch("/api/auth/sign-out", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  localStorage.removeItem(cloudEnabledKey);
}

export async function deleteCloudAccount(): Promise<void> {
  const response = await fetch("/api/v1/account", {
    method: "DELETE",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmation: "DELETE" }),
  });
  if (!response.ok) throw new Error("Account deletion failed");
  localStorage.removeItem(cloudEnabledKey);
}

export async function synchronize(): Promise<void> {
  if (!navigator.onLine) return;

  const pending = await db.operations.orderBy("createdAt").limit(100).toArray();
  if (pending.length) {
    const response = await fetch("/api/v1/sync/push", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operations: pending.map(({ createdAt: _createdAt, ...item }) => item),
      }),
    });
    if (response.status === 401) return;
    if (!response.ok) throw new Error("Sync push failed");
    await db.operations.bulkDelete(pending.map((item) => item.operationId));
    for (const item of pending) {
      if (item.entity === "brew")
        await db.brews.update(item.entityId, { syncState: "synced" });
    }
  }

  let cursor = Number((await db.preferences.get(cursorKey))?.value ?? "0");
  let hasMore = true;
  while (hasMore) {
    const response = await fetch(`/api/v1/sync/pull?cursor=${cursor}`, {
      credentials: "include",
    });
    if (response.status === 401) return;
    if (!response.ok) throw new Error("Sync pull failed");
    const body = (await response.json()) as {
      operations: PullOperation[];
      cursor: number;
      hasMore: boolean;
    };
    await db.transaction(
      "rw",
      [db.beans, db.machines, db.grinders, db.brews, db.preferences],
      async () => {
        for (const item of body.operations) await applyRemoteOperation(item);
        await db.preferences.put({
          key: cursorKey,
          value: String(body.cursor),
        });
      },
    );
    cursor = body.cursor;
    hasMore = body.hasMore;
  }
}
