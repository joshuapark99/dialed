import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

const accountOwnerId = "account:alice";
const transferFixture = {
  coffeeId: "0198f06e-1620-7000-8000-000000000301",
  bagId: "0198f06e-1620-7000-8000-000000000302",
  machineId: "0198f06e-1620-7000-8000-000000000303",
  grinderId: "0198f06e-1620-7000-8000-000000000304",
  firstBrewId: "0198f06e-1620-7000-8000-000000000305",
  secondBrewId: "0198f06e-1620-7000-8000-000000000306",
  createdAt: "2026-08-22T12:00:00.000Z",
};
const addedBrewId = "0198f06e-1620-7000-8000-000000000307";
const transferFixtureEntities = [
  { store: "ownedCoffees", id: transferFixture.coffeeId },
  { store: "ownedBeans", id: transferFixture.bagId },
  { store: "ownedMachines", id: transferFixture.machineId },
  { store: "ownedGrinders", id: transferFixture.grinderId },
  { store: "ownedBrews", id: transferFixture.firstBrewId },
  { store: "ownedBrews", id: transferFixture.secondBrewId },
] as const;

type PushedOperation = {
  operationId: string;
  entity: string;
  entityId: string;
  payload?: Record<string, unknown>;
};

type TransferRecords = Record<string, Array<Record<string, unknown>>>;

const transferStoreNames = [
  "ownedCoffees",
  "ownedBeans",
  "ownedMachines",
  "ownedGrinders",
  "ownedBrews",
] as const;

function accountFixtureCopies(records: TransferRecords) {
  return transferFixtureEntities.map(({ store, id }) => ({
    store,
    id,
    records: records[store].filter(
      (record) => record.ownerId === accountOwnerId && record.id === id,
    ),
  }));
}

function expectNoAccountFixtureCopies(
  records: TransferRecords,
  exceptIds: readonly string[] = [],
) {
  for (const copy of accountFixtureCopies(records)) {
    if (exceptIds.includes(copy.id)) continue;
    expect(copy.records).toEqual([]);
  }
}

function expectOneAccountCopyPerFixtureEntity(records: TransferRecords) {
  for (const copy of accountFixtureCopies(records)) {
    expect(copy.records).toHaveLength(1);
  }
}

async function putTransferRecords(
  page: Page,
  options: { anonymous?: boolean; destinationConflict?: boolean } = {},
) {
  await expect
    .poll(
      () =>
        page.evaluate(async (requiredStores) => {
          const metadata = await indexedDB.databases();
          if (!metadata.some(({ name }) => name === "dialed-local")) {
            return false;
          }

          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open("dialed-local");
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
          });
          const ready = requiredStores.every((store) =>
            database.objectStoreNames.contains(store),
          );
          database.close();
          return ready;
        }, transferStoreNames),
      { message: "Dialed IndexedDB schema did not become ready" },
    )
    .toBe(true);

  await page.evaluate(
    async ({ accountOwnerId, fixture, options, storeNames }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("dialed-local");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      const transaction = database.transaction(storeNames, "readwrite");
      const coffees = transaction.objectStore("ownedCoffees");
      const bags = transaction.objectStore("ownedBeans");
      const machines = transaction.objectStore("ownedMachines");
      const grinders = transaction.objectStore("ownedGrinders");
      const brews = transaction.objectStore("ownedBrews");
      const accountCreatedAt = "2026-08-21T12:00:00.000Z";

      coffees.put({
        ownerId: accountOwnerId,
        id: "0198f06e-1620-7000-8000-000000000351",
        name: "Account coffee",
        roaster: "Account Roasters",
        roastLevel: "medium",
        createdAt: accountCreatedAt,
      });
      bags.put({
        ownerId: accountOwnerId,
        id: "0198f06e-1620-7000-8000-000000000352",
        coffeeId: "0198f06e-1620-7000-8000-000000000351",
        createdAt: accountCreatedAt,
      });
      machines.put({
        ownerId: accountOwnerId,
        id: "0198f06e-1620-7000-8000-000000000353",
        name: "Account machine",
        temperatureControl: "none",
        hasPressureControl: false,
        hasPreinfusion: false,
        createdAt: accountCreatedAt,
      });
      grinders.put({
        ownerId: accountOwnerId,
        id: "0198f06e-1620-7000-8000-000000000354",
        name: "Account grinder",
        finerDirection: "lower",
        createdAt: accountCreatedAt,
      });

      if (options.destinationConflict) {
        coffees.put({
          ownerId: accountOwnerId,
          id: fixture.coffeeId,
          name: "Destination conflict coffee",
          roaster: "Different Roaster",
          roastLevel: "dark",
          createdAt: fixture.createdAt,
        });
      }
      if (options.anonymous ?? true) {
        coffees.put({
          ownerId: "anonymous",
          id: fixture.coffeeId,
          name: "Anonymous coffee",
          roaster: "Anonymous Roasters",
          roastLevel: "light",
          createdAt: fixture.createdAt,
        });
        bags.put({
          ownerId: "anonymous",
          id: fixture.bagId,
          coffeeId: fixture.coffeeId,
          legacyPairedCoffee: true,
          createdAt: fixture.createdAt,
        });
        machines.put({
          ownerId: "anonymous",
          id: fixture.machineId,
          name: "Anonymous machine",
          temperatureControl: "relative",
          hasPressureControl: true,
          hasPreinfusion: true,
          createdAt: fixture.createdAt,
        });
        grinders.put({
          ownerId: "anonymous",
          id: fixture.grinderId,
          name: "Anonymous grinder",
          finerDirection: "lower",
          createdAt: fixture.createdAt,
        });
        for (const [id, grind] of [
          [fixture.firstBrewId, "0.8"],
          [fixture.secondBrewId, "0.9"],
        ]) {
          brews.put({
            ownerId: "anonymous",
            id,
            beanId: fixture.bagId,
            machineId: fixture.machineId,
            grinderId: fixture.grinderId,
            dose: 18,
            yield: 36,
            duration: 28,
            grind,
            taste: {
              acidity: 3,
              bitterness: 3,
              strength: 3,
              body: 3,
              enjoyment: 3,
            },
            ratio: 2,
            flow: 1.29,
            recommendation: {
              variable: "hold",
              direction: "hold",
              headline: "Keep it steady",
              rationale: "The shot is balanced.",
              expectedEffect: "Maintain the result.",
              confidence: "high",
              ruleVersion: "web-1",
            },
            createdAt: fixture.createdAt,
            updatedAt: fixture.createdAt,
            syncState: "local",
          });
        }
      }
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();
    },
    {
      accountOwnerId,
      fixture: transferFixture,
      options,
      storeNames: transferStoreNames,
    },
  );
}

async function transferRecords(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dialed-local");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    const stores = [
      "ownedCoffees",
      "ownedBeans",
      "ownedMachines",
      "ownedGrinders",
      "ownedBrews",
      "ownedOperations",
    ];
    const transaction = database.transaction(stores, "readonly");
    const requests = Object.fromEntries(
      stores.map((store) => [store, transaction.objectStore(store).getAll()]),
    ) as Record<string, IDBRequest<Array<Record<string, unknown>>>>;
    const records = await new Promise<
      Record<string, Array<Record<string, unknown>>>
    >((resolve, reject) => {
      transaction.oncomplete = () =>
        resolve(
          Object.fromEntries(
            stores.map((store) => [store, requests[store]!.result]),
          ),
        );
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
    return records;
  });
}

async function mockAuthenticatedTransferRoutes(
  page: Page,
  pushed: PushedOperation[],
  pushStatus: () => number | Promise<number> = () => 200,
  pushedBatches?: PushedOperation[][],
) {
  await page.addInitScript(() => {
    localStorage.setItem("dialed-cloud-enabled", "true");
  });
  await page.route("**/api/v1/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: "alice", email: "alice@example.com", name: "Alice" },
      }),
    });
  });
  await page.route("**/api/v1/sync/pull**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ operations: [], cursor: 0, hasMore: false }),
    });
  });
  await page.route("**/api/v1/sync/push", async (route) => {
    const body = route.request().postDataJSON() as {
      operations: PushedOperation[];
    };
    pushed.push(...body.operations);
    pushedBatches?.push(body.operations);
    const status = await pushStatus();
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(
        status === 200 ? { results: [] } : { error: "unavailable" },
      ),
    });
  });
}

async function openTransferOffer(page: Page, pushed: PushedOperation[]) {
  await mockAuthenticatedTransferRoutes(page, pushed);
  await page.goto("/");
  await putTransferRecords(page);
  await page.reload();
  const dialog = page.getByRole("dialog", { name: /move local data/i });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("moves anonymous data only after refreshed consent", async ({ page }) => {
  const pushed: PushedOperation[] = [];
  const dialog = await openTransferOffer(page, pushed);

  await expect(
    dialog.getByText(/2 shots.*1 coffee.*1 machine.*1 grinder/i),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Move data" })).toBeFocused();
  const originalDialogElement = await dialog.elementHandle();
  expect(originalDialogElement).not.toBeNull();

  await page.evaluate(
    async ({ secondBrewId, addedBrewId }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("dialed-local");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      const transaction = database.transaction("ownedBrews", "readwrite");
      const store = transaction.objectStore("ownedBrews");
      const source = await new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          const request = store.get(["anonymous", secondBrewId]);
          request.onerror = () => reject(request.error);
          request.onsuccess = () =>
            resolve(request.result as Record<string, unknown>);
        },
      );
      store.put({
        ...source,
        id: addedBrewId,
        grind: "1.0",
      });
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();
    },
    { ...transferFixture, addedBrewId },
  );

  await dialog.getByRole("button", { name: "Move data" }).click();
  await expect(dialog).toHaveCount(1);
  await expect(dialog.getByText(/3 shots/i)).toBeVisible();
  await expect(dialog.getByText(/nothing was moved/i)).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Retry move" }),
  ).toBeVisible();
  const refreshedDialogElement = await dialog.elementHandle();
  expect(refreshedDialogElement).not.toBeNull();
  expect(
    await originalDialogElement!.evaluate(
      (original, refreshed) => original === refreshed,
      refreshedDialogElement!,
    ),
  ).toBe(true);
  expect(pushed).toEqual([]);
  const beforeRetry = await transferRecords(page);
  expectNoAccountFixtureCopies(beforeRetry);

  await dialog.getByRole("button", { name: "Retry move" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "Ready for the next shot?" }),
  ).toBeVisible();
  const afterMove = await transferRecords(page);
  for (const store of [
    "ownedCoffees",
    "ownedBeans",
    "ownedMachines",
    "ownedGrinders",
    "ownedBrews",
  ]) {
    expect(
      afterMove[store].filter((record) => record.ownerId === "anonymous"),
    ).toEqual([]);
  }
  expect(pushed).toHaveLength(transferFixtureEntities.length + 1);
  expect(
    pushed.find((operation) => operation.entity === "coffee")?.entityId,
  ).toBe(transferFixture.coffeeId);
  expect(
    pushed.find((operation) => operation.entity === "bean")?.payload,
  ).toMatchObject({ legacyPairedCoffee: true });
  const entityOrder = pushed.map((operation) => operation.entity);
  expect(entityOrder.indexOf("coffee")).toBeLessThan(
    entityOrder.indexOf("bean"),
  );
  expect(entityOrder.indexOf("bean")).toBeLessThan(entityOrder.indexOf("brew"));
});

test("defers anonymous data without exposing it to the account", async ({
  page,
}) => {
  const pushed: PushedOperation[] = [];
  const dialog = await openTransferOffer(page, pushed);

  await dialog.getByRole("button", { name: "Not now" }).click();
  await expect(
    page.getByRole("heading", { name: "Ready for the next shot?" }),
  ).toBeVisible();
  await expect(page.getByText("Anonymous coffee")).toHaveCount(0);
  const deferredRecords = await transferRecords(page);
  expect(
    deferredRecords.ownedCoffees.filter(
      (record) =>
        record.ownerId === "anonymous" &&
        record.id === transferFixture.coffeeId,
    ),
  ).toHaveLength(1);
  expect(pushed).toEqual([]);

  await page.reload();
  await expect(
    page.getByRole("dialog", { name: /move local data/i }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Setup" }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(
    page.getByRole("button", { name: "Move local data" }),
  ).toBeVisible();
});

test("retries anonymous transfer from Settings after a failed push", async ({
  page,
}) => {
  const pushed: PushedOperation[] = [];
  const pushedBatches: PushedOperation[][] = [];
  let releaseFirstPush: ((status: number) => void) | undefined;
  let startedFirstPush: (() => void) | undefined;
  const firstPushStarted = new Promise<void>((resolve) => {
    startedFirstPush = resolve;
  });
  let firstPush = true;
  await mockAuthenticatedTransferRoutes(
    page,
    pushed,
    () => {
      if (!firstPush) return 200;
      firstPush = false;
      startedFirstPush?.();
      return new Promise<number>((resolve) => {
        releaseFirstPush = resolve;
      });
    },
    pushedBatches,
  );
  await page.goto("/");
  await putTransferRecords(page);
  await page.reload();
  const dialog = page.getByRole("dialog", { name: /move local data/i });
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Move data" }).click();
  await expect(dialog.getByText(/moving local data/i)).toBeVisible();
  await firstPushStarted;
  await expect(dialog.getByRole("button", { name: "Not now" })).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "Move data" }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  releaseFirstPush?.(503);

  await expect(dialog.getByRole("alert")).toContainText(
    /local data was preserved/i,
  );
  const failedRecords = await transferRecords(page);
  expect(
    failedRecords.ownedCoffees.filter(
      (record) =>
        record.ownerId === "anonymous" &&
        record.id === transferFixture.coffeeId,
    ),
  ).toHaveLength(1);
  expect(
    failedRecords.ownedCoffees.filter(
      (record) =>
        record.ownerId === accountOwnerId &&
        record.id === transferFixture.coffeeId,
    ),
  ).toHaveLength(1);

  await dialog.getByRole("button", { name: "Not now" }).click();
  await page.getByRole("button", { name: "Setup" }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  const recovery = page.getByRole("alert").filter({
    hasText: "Local data move needs recovery",
  });
  await expect(recovery).toContainText(
    /2 shots.*1 coffee.*1 machine.*1 grinder/i,
  );
  await recovery.getByRole("button", { name: "Retry local data move" }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Move data" }).click();
  await expect(
    page.getByText("Local data was moved to this account."),
  ).toBeVisible();

  const retriedRecords = await transferRecords(page);
  expectOneAccountCopyPerFixtureEntity(retriedRecords);
  expect(pushedBatches).toHaveLength(2);
  expect(pushedBatches[1]!.map((operation) => operation.operationId)).toEqual(
    pushedBatches[0]!.map((operation) => operation.operationId),
  );
  expect(
    retriedRecords.ownedOperations.filter(
      (record) => record.ownerId === accountOwnerId,
    ),
  ).toEqual([]);
  expect(
    retriedRecords.ownedCoffees.filter(
      (record) => record.ownerId === "anonymous",
    ),
  ).toEqual([]);
});

test("rejects transfer conflicts without writes or source deletion", async ({
  page,
}) => {
  const pushed: PushedOperation[] = [];
  await mockAuthenticatedTransferRoutes(page, pushed);
  await page.goto("/");
  await putTransferRecords(page, { destinationConflict: true });
  await page.reload();
  const dialog = page.getByRole("dialog", { name: /move local data/i });
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Move data" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    /conflicts with this account/i,
  );
  expect(pushed).toEqual([]);
  const records = await transferRecords(page);
  expect(
    records.ownedCoffees.find(
      (record) =>
        record.ownerId === accountOwnerId &&
        record.id === transferFixture.coffeeId,
    ),
  ).toMatchObject({ name: "Destination conflict coffee" });
  expectNoAccountFixtureCopies(records, [transferFixture.coffeeId]);
  expect(
    records.ownedCoffees.find(
      (record) =>
        record.ownerId === "anonymous" &&
        record.id === transferFixture.coffeeId,
    ),
  ).toMatchObject({ name: "Anonymous coffee" });
});

test("discovers one offline-created local transfer offer after reconnecting", async ({
  page,
}) => {
  const pushed: PushedOperation[] = [];
  await mockAuthenticatedTransferRoutes(page, pushed);
  await page.goto("/");
  await putTransferRecords(page, { anonymous: false });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Ready for the next shot?" }),
  ).toBeVisible();

  await page.context().setOffline(true);
  await putTransferRecords(page);
  await page.context().setOffline(false);

  const dialog = page.getByRole("dialog", { name: /move local data/i });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCount(1);
  await expect(
    dialog.getByText(/2 shots.*1 coffee.*1 machine.*1 grinder/i),
  ).toBeVisible();
  expect(pushed).toEqual([]);
});

test("keeps a deferred transfer scoped to the signed-in account", async ({
  page,
}) => {
  const pushed: PushedOperation[] = [];
  const dialog = await openTransferOffer(page, pushed);
  await dialog.getByRole("button", { name: "Not now" }).click();
  await expect(
    page.getByRole("heading", { name: "Ready for the next shot?" }),
  ).toBeVisible();

  await page.unroute("**/api/v1/me");
  await page.route("**/api/v1/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: "bob", email: "bob@example.com", name: "Bob" },
      }),
    });
  });
  await page.reload();
  await expect(
    page.getByRole("dialog", { name: /move local data/i }),
  ).toBeVisible();
  expect(pushed).toEqual([]);
});

async function completeOnboarding(page: Page, roastedOn?: string) {
  await page.getByLabel("Coffee").fill("Hualalai Kona");
  await page.getByLabel("Roaster").fill("Coffee Purveyors");
  if (roastedOn) await page.getByLabel("Roast date (optional)").fill(roastedOn);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Machine").fill("Gaggia Classic Pro E24");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Grinder").fill("Fellow Opus");
  await page.getByRole("button", { name: "Start dialing in" }).click();
  await expect(
    page.getByRole("heading", { name: "Ready for the next shot?" }),
  ).toBeVisible();
}

test("groups repeat bags and keeps comparisons bag-specific", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await completeOnboarding(page, "2026-08-01");

  await page.getByRole("button", { name: "Setup" }).click();
  await page
    .getByRole("button", { name: "Add another bag", exact: true })
    .click();
  const bagDialog = page.getByRole("dialog", { name: "Add another bag" });
  await expect(bagDialog).toBeVisible();
  const roastDate = bagDialog.getByLabel("Roast date");
  await expect(roastDate).toBeFocused();
  await roastDate.fill("2026-08-15");
  await bagDialog.getByRole("button", { name: "Save bag" }).click();

  await page.getByRole("button", { name: "Log brew", exact: true }).click();
  const coffeeSelect = page.getByLabel("Coffee");
  const olderBagId = await page
    .getByRole("option", { name: /Hualalai Kona.*Aug 1, 2026$/ })
    .getAttribute("value");
  expect(olderBagId).not.toBeNull();
  await coffeeSelect.selectOption(olderBagId!);
  await page
    .getByRole("textbox", { name: "Grind (required)", exact: true })
    .fill("0.8");
  await page.getByRole("button", { name: "Save and see next move" }).click();

  await page.getByRole("button", { name: "Log the next shot" }).click();
  // Chromium renders a closed select's native popup outside Playwright's
  // visibility tree, so expand it before asserting the accessible option.
  await coffeeSelect.evaluate((select) => {
    if (select instanceof HTMLSelectElement)
      select.size = select.options.length;
  });
  await expect(
    page.getByRole("option", { name: /Hualalai Kona.*Aug 15/ }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Grind (required)", exact: true })
    .fill("0.9");
  await page.getByRole("button", { name: "Save and see next move" }).click();
  await expect(page.getByText(/Hualalai Kona.*Aug 15/)).toBeVisible();

  const secondBrew = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dialed-local");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    const result = await new Promise<Record<string, unknown> | undefined>(
      (resolve, reject) => {
        const transaction = database.transaction(
          ["ownedBeans", "ownedBrews"],
          "readonly",
        );
        const bagsRequest = transaction.objectStore("ownedBeans").getAll();
        const brewsRequest = transaction.objectStore("ownedBrews").getAll();
        transaction.oncomplete = () => {
          const newerBag = (
            bagsRequest.result as Array<{ id: string; roastedOn?: string }>
          ).find((bag) => bag.roastedOn === "2026-08-15");
          resolve(
            (brewsRequest.result as Array<Record<string, unknown>>).find(
              (brew) => brew.beanId === newerBag?.id,
            ),
          );
        };
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      },
    );
    database.close();
    return result;
  });
  expect(secondBrew).toBeDefined();
  expect(secondBrew).not.toHaveProperty("comparisonBrewId");

  await page.getByRole("button", { name: "History" }).click();
  await expect(page.getByText("Roasted Aug 1, 2026")).toBeVisible();
  await expect(page.getByText("Roasted Aug 15, 2026")).toBeVisible();
});

test("adds fixed Coffee fields and a first bag with recoverable validation errors", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await completeOnboarding(page);
  await page.getByRole("button", { name: "Setup" }).click();
  await page.getByRole("button", { name: "Add coffee", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Add coffee" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Coffee name")).toBeFocused();
  await dialog.getByLabel("Coffee name").fill("Suke Quto");
  await dialog.getByLabel("Roaster").fill("Tim Wendelboe");
  const startingWeight = dialog.getByLabel("Starting weight (grams)");
  expect(Number(await startingWeight.getAttribute("min"))).toBeGreaterThan(0);
  await startingWeight.fill("0");
  await startingWeight.blur();
  await expect(
    dialog.getByRole("alert").filter({
      hasText:
        "Starting weight must be greater than 0 and at most 100,000 grams",
    }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Save coffee" }),
  ).toBeDisabled();

  await dialog.getByLabel("Origin country").fill("Ethiopia");
  await dialog.getByLabel("Origin region").fill("Guji");
  await dialog.getByLabel("Producer").fill("Tesfaye Bekele");
  await dialog.getByLabel("Process").fill("Washed");
  await dialog.getByLabel("Varietal").fill("Kurume");
  await dialog.getByLabel("Elevation (meters)").fill("2100");
  await dialog.getByLabel("Roast level").selectOption("light");
  await dialog.getByLabel("Coffee notes").fill("Floral and citrus");
  await dialog.getByLabel("Roast date").fill("2026-08-18");
  await dialog.getByLabel("Purchase date").fill("2026-08-20");
  await dialog.getByLabel("Opened date").fill("2026-08-22");
  await startingWeight.fill("250");
  await dialog.getByLabel("Bag notes").fill("Competition lot");

  await page.evaluate(() => {
    const originalAdd = IDBObjectStore.prototype.add;
    (
      globalThis as typeof globalThis & {
        __dialedOriginalAdd?: typeof IDBObjectStore.prototype.add;
      }
    ).__dialedOriginalAdd = originalAdd;
    IDBObjectStore.prototype.add = function (
      value: unknown,
      key?: IDBValidKey,
    ): IDBRequest<IDBValidKey> {
      if (this.name === "ownedOperations") {
        throw new DOMException("Storage full", "QuotaExceededError");
      }
      return key === undefined
        ? originalAdd.call(this, value)
        : originalAdd.call(this, value, key);
    };
  });
  await dialog.getByRole("button", { name: "Save coffee" }).click();
  await expect(
    dialog
      .getByRole("alert")
      .filter({ hasText: "Could not save. Please try again." }),
  ).toBeVisible();
  await expect(dialog).toBeVisible();

  await page.evaluate(() => {
    const target = globalThis as typeof globalThis & {
      __dialedOriginalAdd?: typeof IDBObjectStore.prototype.add;
    };
    if (target.__dialedOriginalAdd) {
      IDBObjectStore.prototype.add = target.__dialedOriginalAdd;
      delete target.__dialedOriginalAdd;
    }
  });
  await dialog.getByRole("button", { name: "Save coffee" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Suke Quto", { exact: true })).toBeVisible();
  await expect(page.getByText("Roasted Aug 18, 2026")).toBeVisible();

  const saved = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dialed-local");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    const records = await new Promise<{
      coffee?: Record<string, unknown>;
      bag?: Record<string, unknown>;
    }>((resolve, reject) => {
      const transaction = database.transaction(
        ["ownedCoffees", "ownedBeans"],
        "readonly",
      );
      const coffeesRequest = transaction.objectStore("ownedCoffees").getAll();
      const bagsRequest = transaction.objectStore("ownedBeans").getAll();
      transaction.oncomplete = () => {
        const coffee = (
          coffeesRequest.result as Array<Record<string, unknown>>
        ).find((candidate) => candidate.name === "Suke Quto");
        const bag = (bagsRequest.result as Array<Record<string, unknown>>).find(
          (candidate) => candidate.coffeeId === coffee?.id,
        );
        resolve({ coffee, bag });
      };
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
    return records;
  });

  expect(saved.coffee).toMatchObject({
    name: "Suke Quto",
    roaster: "Tim Wendelboe",
    originCountry: "Ethiopia",
    originRegion: "Guji",
    producer: "Tesfaye Bekele",
    process: "Washed",
    varietal: "Kurume",
    elevationMeters: 2100,
    roastLevel: "light",
    notes: "Floral and citrus",
  });
  expect(saved.bag).toMatchObject({
    roastedOn: "2026-08-18",
    purchasedOn: "2026-08-20",
    openedOn: "2026-08-22",
    startingWeightGrams: 250,
    notes: "Competition lot",
  });
});

test("explains why brew save is disabled on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await completeOnboarding(page);

  await page.getByRole("button", { name: "Log", exact: true }).click();

  const grindInput = page.getByRole("textbox", {
    name: /grind.*required/i,
  });
  const saveButton = page.getByRole("button", {
    name: "Save and see next move",
  });
  const grindRequirement = page.getByText(/grind setting.*save/i);
  await expect(grindInput).toBeVisible();
  await expect(saveButton).toBeDisabled();
  await expect(saveButton).toHaveAttribute(
    "aria-describedby",
    "grind-save-requirement",
  );
  await expect(grindRequirement).toBeVisible();

  await grindInput.fill("0.8");

  await expect(saveButton).toBeEnabled();
  await expect(saveButton).not.toHaveAttribute("aria-describedby");
  await expect(grindRequirement).toBeHidden();
});

test("keeps the mobile brew form above the fixed save action", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 667 });
  await page.goto("/");
  await completeOnboarding(page);

  await page.getByRole("button", { name: "Log", exact: true }).click();
  await page.evaluate(() =>
    window.scrollTo({ top: document.documentElement.scrollHeight }),
  );

  const formBounds = await page.locator("details").boundingBox();
  const saveBounds = await page
    .getByRole("button", { name: "Save and see next move" })
    .boundingBox();
  expect(formBounds).not.toBeNull();
  expect(saveBounds).not.toBeNull();
  expect(formBounds!.y + formBounds!.height).toBeLessThanOrEqual(saveBounds!.y);
});

test("onboards, logs a shot, and returns one next move on mobile", async ({
  page,
}, testInfo) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await completeOnboarding(page);

  await page.getByRole("button", { name: "Log", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Grind (required)", exact: true })
    .fill("0.8");
  await page.getByRole("button", { name: "Save and see next move" }).click();

  await expect(page.getByText("Your next move")).toBeVisible();
  await expect(
    page.getByText("Change one variable", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("Shot saved locally")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(consoleErrors).toEqual([]);
  await page.waitForTimeout(300);
  await page.screenshot({
    path: testInfo.outputPath("mobile-result.png"),
    fullPage: true,
  });
});

test("requires confirmation before deleting a brew log", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await completeOnboarding(page);
  await page.getByRole("button", { name: "Log", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Grind (required)", exact: true })
    .fill("0.8");
  await page.getByRole("button", { name: "Save and see next move" }).click();
  await page.getByRole("button", { name: "History" }).click();
  await page.getByRole("button", { name: /Hualalai Kona/ }).click();

  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Delete log" }).click();
  await expect(
    page.getByRole("dialog", { name: "Shot details" }),
  ).toBeVisible();
  await expect(page.getByText("1 shot", { exact: true })).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete log" }).click();
  await expect(
    page.getByRole("heading", { name: "No shots yet" }),
  ).toBeVisible();
});

test("keeps the brew log and reports a deletion failure", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await completeOnboarding(page);
  await page.getByRole("button", { name: "Log", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Grind (required)", exact: true })
    .fill("0.8");
  await page.getByRole("button", { name: "Save and see next move" }).click();
  await page.getByRole("button", { name: "History" }).click();
  await page.getByRole("button", { name: /Hualalai Kona/ }).click();
  await page.evaluate(() => {
    const originalAdd = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (
      value: unknown,
      key?: IDBValidKey,
    ): IDBRequest<IDBValidKey> {
      if (this.name === "ownedOperations") {
        throw new DOMException("Storage full", "QuotaExceededError");
      }
      return key === undefined
        ? originalAdd.call(this, value)
        : originalAdd.call(this, value, key);
    };
  });

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete log" }).click();

  await expect(
    page.getByRole("alert").filter({
      hasText: "Couldn't delete this log. Your brew is still saved. Try again.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Shot details" }),
  ).toBeVisible();
  await expect(page.getByText("1 shot", { exact: true })).toBeVisible();
});

test("onboarding and the empty dashboard fit a desktop viewport", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await completeOnboarding(page);

  await expect(page.getByRole("button", { name: "Log brew" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.waitForTimeout(300);
  await page.screenshot({
    path: testInfo.outputPath("desktop-home.png"),
    fullPage: true,
  });
});

test("anonymous views and exports exclude another owner's records", async ({
  page,
}) => {
  const foreignOwnerId = "account:foreign-account";
  const foreignCoffeeId = "0198f06e-1620-7000-8000-000000000001";
  const foreignBagId = "0198f06e-1620-7000-8000-000000000002";
  const foreignCreatedAt = "2026-08-22T12:00:00.000Z";
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await completeOnboarding(page);

  const { anonymousCoffeeId, anonymousBagId } = await page.evaluate(
    async ({
      foreignOwnerId,
      foreignCoffeeId,
      foreignBagId,
      foreignCreatedAt,
    }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("dialed-local");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      const ids = await new Promise<{
        anonymousCoffeeId: string;
        anonymousBagId: string;
      }>((resolve, reject) => {
        const transaction = database.transaction(
          ["ownedCoffees", "ownedBeans"],
          "readwrite",
        );
        const coffees = transaction.objectStore("ownedCoffees");
        const bags = transaction.objectStore("ownedBeans");
        const coffeeRecords = coffees.getAll();
        const bagRecords = bags.getAll();
        coffees.put({
          id: foreignCoffeeId,
          ownerId: foreignOwnerId,
          name: "Foreign owner coffee",
          roaster: "Partition Roasters",
          roastLevel: "light",
          createdAt: foreignCreatedAt,
        });
        bags.put({
          id: foreignBagId,
          ownerId: foreignOwnerId,
          coffeeId: foreignCoffeeId,
          roastedOn: "2026-08-10",
          createdAt: foreignCreatedAt,
        });
        transaction.oncomplete = () => {
          const anonymousCoffee = (
            coffeeRecords.result as Array<{ id: string; ownerId: string }>
          ).find((coffee) => coffee.ownerId === "anonymous");
          const anonymousBag = (
            bagRecords.result as Array<{ id: string; ownerId: string }>
          ).find((bag) => bag.ownerId === "anonymous");
          if (!anonymousCoffee || !anonymousBag) {
            reject(new Error("Onboarding records were not persisted"));
            return;
          }
          resolve({
            anonymousCoffeeId: anonymousCoffee.id,
            anonymousBagId: anonymousBag.id,
          });
        };
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();
      return ids;
    },
    {
      foreignOwnerId,
      foreignCoffeeId,
      foreignBagId,
      foreignCreatedAt,
    },
  );

  await page.reload();
  await page.getByRole("button", { name: "Setup" }).click();
  await expect(page.getByText("Hualalai Kona")).toBeVisible();
  await expect(page.getByText("Foreign owner coffee")).toHaveCount(0);

  await page.getByRole("button", { name: "History" }).click();
  await expect(page.getByText("Foreign owner coffee")).toHaveCount(0);

  await page.getByRole("button", { name: "Setup" }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON" }).click();
  const download = await downloadPromise;
  const contents = JSON.parse(
    await readFile(await download.path(), "utf8"),
  ) as {
    coffees: Array<{ id: string }>;
    bags: Array<{ id: string; coffeeId: string }>;
  };
  expect(contents.coffees.map((coffee) => coffee.id)).toContain(
    anonymousCoffeeId,
  );
  expect(contents.coffees.map((coffee) => coffee.id)).not.toContain(
    foreignCoffeeId,
  );
  expect(contents.bags.map((bag) => bag.id)).toContain(anonymousBagId);
  expect(contents.bags.map((bag) => bag.id)).not.toContain(foreignBagId);
  expect(contents.bags.find((bag) => bag.id === anonymousBagId)?.coffeeId).toBe(
    anonymousCoffeeId,
  );
});

test("blocks local partitions when account lookup fails and allows retry", async ({
  page,
}) => {
  let lookupFails = true;
  await page.addInitScript(() => {
    localStorage.setItem("dialed-cloud-enabled", "true");
  });
  await page.route("**/api/v1/me", async (route) => {
    await route.fulfill({ status: lookupFails ? 503 : 401 });
  });

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Account unavailable" }),
  ).toBeVisible();
  await expect(page.getByLabel("Coffee")).toHaveCount(0);

  lookupFails = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByLabel("Coffee")).toBeVisible();
});

test("allows explicit local mode when account lookup remains unavailable", async ({
  page,
}) => {
  await page.goto("/");
  await completeOnboarding(page);
  await putTransferRecords(page, { anonymous: false });
  const accountRecordsBefore = Object.fromEntries(
    Object.entries(await transferRecords(page)).map(([store, records]) => [
      store,
      records.filter((record) => record.ownerId === accountOwnerId),
    ]),
  );
  await page.route("**/api/v1/me", async (route) => {
    await route.fulfill({ status: 503 });
  });
  await page.evaluate(() => {
    localStorage.setItem("dialed-cloud-enabled", "true");
  });

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Account unavailable" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Continue with local data" }).click();

  await page.getByRole("button", { name: "Setup" }).click();
  await expect(page.getByText("Hualalai Kona")).toBeVisible();
  await expect(page.getByText("Account coffee")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("dialed-cloud-enabled")),
    )
    .toBeNull();
  const accountRecordsAfter = Object.fromEntries(
    Object.entries(await transferRecords(page)).map(([store, records]) => [
      store,
      records.filter((record) => record.ownerId === accountOwnerId),
    ]),
  );
  expect(accountRecordsAfter).toEqual(accountRecordsBefore);
});

test("shows sync errors instead of a synced account label", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem("dialed-cloud-enabled", "true");
  });
  await page.route("**/api/v1/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: {
          id: "alice",
          email: "alice@example.com",
          name: "Alice",
        },
      }),
    });
  });
  await page.route("**/api/v1/sync/push", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ results: [] }),
    });
  });
  await page.route("**/api/v1/sync/pull**", async (route) => {
    await route.fulfill({ status: 503 });
  });

  await page.goto("/");
  await completeOnboarding(page);

  await expect(
    page.getByText("Sync error", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText("Cloud synced", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Synced", { exact: true })).toHaveCount(0);
});

test("authenticated cloud setup bypasses the local onboarding marker", async ({
  page,
}) => {
  const createdAt = "2026-08-22T12:00:00.000Z";
  const beanId = "0198f06e-1620-7000-8000-000000000101";
  const machineId = "0198f06e-1620-7000-8000-000000000102";
  const grinderId = "0198f06e-1620-7000-8000-000000000103";
  await page.addInitScript(() => {
    localStorage.setItem("dialed-cloud-enabled", "true");
  });
  await page.route("**/api/v1/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: {
          id: "alice",
          email: "alice@example.com",
          name: "Alice",
        },
      }),
    });
  });
  await page.route("**/api/v1/sync/pull**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        operations: [
          {
            operationId: "0198f06e-1620-7000-8000-000000000201",
            entity: "bean",
            entityId: beanId,
            action: "upsert",
            payload: {
              id: beanId,
              name: "Cloud coffee",
              roaster: "Cloud Roasters",
              roastLevel: "medium",
              createdAt,
            },
            revision: 1,
          },
          {
            operationId: "0198f06e-1620-7000-8000-000000000202",
            entity: "machine",
            entityId: machineId,
            action: "upsert",
            payload: {
              id: machineId,
              name: "Cloud machine",
              temperatureControl: "none",
              hasPressureControl: false,
              hasPreinfusion: false,
              createdAt,
            },
            revision: 2,
          },
          {
            operationId: "0198f06e-1620-7000-8000-000000000203",
            entity: "grinder",
            entityId: grinderId,
            action: "upsert",
            payload: {
              id: grinderId,
              name: "Cloud grinder",
              finerDirection: "lower",
              createdAt,
            },
            revision: 3,
          },
        ],
        cursor: 3,
        hasMore: false,
      }),
    });
  });

  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Ready for the next shot?" }),
  ).toBeVisible();
  await expect(page.getByLabel("Coffee")).toHaveCount(0);
});
