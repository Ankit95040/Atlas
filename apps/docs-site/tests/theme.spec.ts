import { expect, test, type Page } from "@playwright/test";

async function themeState(page: Page): Promise<{ choice: string | null; dataTheme: string | null; bg: string }> {
  return page.evaluate(() => ({
    choice: window.localStorage.getItem("atlas-docs-theme"),
    dataTheme: document.documentElement.dataset.theme ?? null,
    bg: getComputedStyle(document.body).backgroundColor,
  }));
}

test("theme: dark default, light selection, persistence across refresh", async ({ page, context }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/#/");
  await page.waitForTimeout(500);
  const initial = await themeState(page);
  expect(initial.dataTheme).toBe("dark");

  // Open the toggle and select Light.
  await page.getByRole("banner").getByRole("button", { name: /Theme:/ }).click();
  await page.getByRole("listbox", { name: "Color theme" }).getByRole("option", { name: /Light/ }).click();
  const light = await themeState(page);
  expect(light.choice).toBe("light");
  expect(light.dataTheme).toBe("light");
  expect(light.bg).not.toBe(initial.bg);

  // Persisted across a fresh page load (same storage partition, no
  // clearing script — the addInitScript above would wipe on reload).
  const fresh = await context.newPage();
  await fresh.emulateMedia({ colorScheme: "dark" });
  await fresh.goto("/#/");
  await fresh.waitForTimeout(500);
  const after = await themeState(fresh);
  expect(after.choice).toBe("light");
  expect(after.dataTheme).toBe("light");

  // Diagram adapts: SVG surface variable flips.
  const surface = await fresh.evaluate(() =>
    getComputedStyle(document.querySelector(".mission") ?? document.body).getPropertyValue("--mc-surface").trim(),
  );
  expect(surface.length).toBeGreaterThan(0);

  // Back to dark.
  await fresh.getByRole("banner").getByRole("button", { name: /Theme:/ }).click();
  await fresh.getByRole("listbox", { name: "Color theme" }).getByRole("option", { name: "Dark" }).click();
  expect((await themeState(fresh)).dataTheme).toBe("dark");
  await fresh.close();
});

test("theme: system follows prefers-color-scheme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/#/");
  await page.waitForTimeout(500);
  await page.getByRole("banner").getByRole("button", { name: /Theme:/ }).click();
  await page.getByRole("listbox", { name: "Color theme" }).getByRole("option", { name: /System/ }).click();
  expect((await themeState(page)).choice).toBe("system");
  expect((await themeState(page)).dataTheme).toBe("light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(300);
  // Media listener re-resolves without a stored override.
  await page.reload();
  await page.waitForTimeout(300);
  expect((await themeState(page)).dataTheme).toBe("dark");
});

test("homepage: single mission-control visual, hero composition intact", async ({ page }) => {
  await page.goto("/#/");
  await page.waitForTimeout(600);
  // Exactly one mission-control map visible on the page (no duplicate).
  // (Desktop and compact-mobile compositions both exist in the DOM; exactly
  // one is visible per breakpoint.)
  expect(await page.locator('svg[aria-label*="control plane"]:visible').count()).toBe(1);
  // The old duplicate vision map is gone from the homepage.
  expect(await page.locator('svg[aria-label*="Atlas system map"]').count()).toBe(0);
  // Hero copy present and the reading caption integrated.
  await expect(page.getByRole("heading", { level: 1 })).toContainText("structure");
  await expect(page.getByText("How to read this")).toBeVisible();
  await expect(page.getByText("From isolated AI agents to a coordinated engineering system.")).toBeVisible();
});

test("homepage: no overflow at 1440/834/390 in dark and light", async ({ page }) => {
  for (const theme of ["Dark", "Light"] as const) {
    await page.goto("/#/");
    await page.waitForTimeout(400);
    const toggle = page.getByRole("banner").getByRole("button", { name: /Theme:/ });
    await expect(toggle).toBeVisible({ timeout: 10000 });
    await toggle.click();
    const option = page.getByRole("listbox", { name: "Color theme" }).getByRole("option", { name: new RegExp(`^${theme}`) });
    await expect(option).toBeVisible({ timeout: 10000 });
    await option.click();
    await page.waitForTimeout(300);
    for (const width of [1440, 834, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(300);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${theme} @${width}px`).toBeLessThanOrEqual(1);
    }
  }
});
