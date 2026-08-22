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
