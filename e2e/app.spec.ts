import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

async function completeOnboarding(page: Page) {
  await page.getByLabel("Coffee").fill("Hualalai Kona");
  await page.getByLabel("Roaster").fill("Coffee Purveyors");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Machine").fill("Gaggia Classic Pro E24");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Grinder").fill("Fellow Opus");
  await page.getByRole("button", { name: "Start dialing in" }).click();
  await expect(
    page.getByRole("heading", { name: "Ready for the next shot?" }),
  ).toBeVisible();
}

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
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await completeOnboarding(page);

  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dialed-local");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("ownedBeans", "readwrite");
      transaction.objectStore("ownedBeans").put({
        id: "0198f06e-1620-7000-8000-000000000001",
        ownerId: "account:foreign-account",
        name: "Foreign owner coffee",
        roaster: "Partition Roasters",
        roastLevel: "light",
        createdAt: "2026-08-22T12:00:00.000Z",
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  });

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
    beans: Array<{ name: string }>;
  };
  expect(contents.beans.map((bean) => bean.name)).toContain("Hualalai Kona");
  expect(contents.beans.map((bean) => bean.name)).not.toContain(
    "Foreign owner coffee",
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
