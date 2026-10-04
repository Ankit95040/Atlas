import { expect, test } from "@playwright/test";

test("navbar: desktop three-zone geometry + links", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/");
  await page.waitForTimeout(600);
  const geo = await page.evaluate(() => {
    const header = document.querySelector('header[role="banner"]');
    const nav = header?.querySelector('nav[aria-label="Primary"]');
    const headerBox = header?.getBoundingClientRect();
    const navBox = nav?.getBoundingClientRect();
    if (!headerBox || !navBox) {
      return null;
    }
    return {
      headerCx: headerBox.left + headerBox.width / 2,
      navCx: navBox.left + navBox.width / 2,
      navRole: nav?.getAttribute("role") ?? "none-implicit",
    };
  });
  expect(geo).not.toBeNull();
  expect(Math.abs((geo?.headerCx ?? 0) - (geo?.navCx ?? 999)), "nav geometrically centered").toBeLessThanOrEqual(8);
  // Contact us reaches the contact page
  await page.getByRole("banner").getByRole("link", { name: "Contact us" }).click();
  await expect(page).toHaveURL(/#\/docs\/reference\/contact/);
  await expect(page.locator("#main").getByRole("heading", { level: 1 })).toContainText("Contact");
  // GitHub opens the real repository
  await page.goto("/#/");
  const href = await page.getByRole("banner").getByRole("link", { name: "GitHub" }).getAttribute("href");
  expect(href).toBe("https://github.com/Ankit95040/Atlas");
  // No overflow
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("navbar: tablet balance, no collisions", async ({ page }) => {
  await page.setViewportSize({ width: 834, height: 1112 });
  await page.goto("/#/");
  await page.waitForTimeout(600);
  const audit = await page.evaluate(() => {
    const header = document.querySelector('header[role="banner"]');
    const btns = [...(header?.querySelectorAll("a,button") ?? [])].map((el) => el.getBoundingClientRect());
    let overlap = 0;
    for (let i = 0; i < btns.length; i++) {
      for (let j = i + 1; j < btns.length; j++) {
        const a = btns[i];
        const b = btns[j];
        if (!a || !b) {
          continue;
        }
        if (a.left < b.right - 2 && b.left < a.right - 2 && a.top < b.bottom - 2 && b.top < a.bottom - 2) {
          overlap += 1;
        }
      }
    }
    return { overlap, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  expect(audit.overlap, "header collisions").toBe(0);
  expect(audit.overflow, "overflow").toBeLessThanOrEqual(1);
});

test("navbar: mobile menu keyboard + pointer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/docs/cli/run");
  // Pointer path
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("dialog", { name: "Site navigation" })).toBeVisible();
  await page.getByRole("dialog").getByRole("link", { name: "Architecture" }).click();
  await expect(page).toHaveURL(/#\/docs\/architecture\/overview/);
  // Keyboard path: Escape closes (focus moves into the dialog on open)
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect
    .poll(async () => page.evaluate(() => document.activeElement?.getAttribute("aria-label")), { timeout: 5000 })
    .toBe("Close navigation");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Drawer contact + github discoverable
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("dialog").getByRole("link", { name: "Contact us" })).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("link", { name: "GitHub repository" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
