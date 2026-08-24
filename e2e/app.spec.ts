import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

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
  await page.getByRole("textbox", { name: "Grind", exact: true }).fill("0.8");
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
  await page.getByRole("textbox", { name: "Grind", exact: true }).fill("0.9");
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
  await page.getByRole("textbox", { name: "Grind", exact: true }).fill("0.8");
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
  await page.getByRole("textbox", { name: "Grind", exact: true }).fill("0.8");
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
  await page.getByRole("textbox", { name: "Grind", exact: true }).fill("0.8");
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
