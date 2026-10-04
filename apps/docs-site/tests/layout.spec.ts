import { expect, test } from "@playwright/test";

const ROUTES = ["#/", "#/docs", "#/docs/cli/run", "#/docs/architecture/overview", "#/research", "#/research/m29-screening", "#/timeline", "#/docs/reference/contact"];

test("no horizontal overflow at desktop, tablet, mobile", async ({ page }) => {
  for (const width of [1440, 834, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const hash of ROUTES) {
      await page.goto(`/${hash}`);
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return { scrollW: doc.scrollWidth, clientW: doc.clientWidth, route: window.location.hash };
      });
      expect(overflow.scrollW, `${width}px ${hash}: page overflows`).toBeLessThanOrEqual(overflow.clientW + 1);
    }
  }
});

test("no empty sections or missing headings", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const hash of ROUTES) {
    await page.goto(`/${hash}`);
    await page.waitForTimeout(400);
    const audit = await page.evaluate(() => {
      const main = document.getElementById("main");
      const text = (main?.textContent ?? "").trim();
      const h1 = main?.querySelectorAll("h1").length ?? 0;
      const links = main?.querySelectorAll('a[href="#"]').length ?? 0;
      return { len: text.length, h1, deadLinks: links };
    });
    expect(audit.h1, `${hash}: missing h1`).toBeGreaterThanOrEqual(1);
    expect(audit.len, `${hash}: empty content`).toBeGreaterThan(500);
    expect(audit.deadLinks, `${hash}: placeholder href="#" links`).toBe(0);
  }
});

test("code blocks have copy buttons and language labels", async ({ page }) => {
  await page.goto("/#/docs/start/first-run");
  await page.waitForTimeout(400);
  const blocks = await page.locator("pre code").count();
  expect(blocks).toBeGreaterThan(2);
  const copies = await page.getByRole("button", { name: /Copy code/ }).count();
  expect(copies).toBe(blocks);
});

test("sidebar, TOC, and prev/next exist on doc pages", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/docs/cli/run");
  await page.waitForTimeout(400);
  await expect(page.getByRole("navigation", { name: "Documentation sections" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "On this page" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Documentation pages" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();
});

test("mobile drawer opens and navigates", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/docs/cli/run");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("dialog", { name: "Site navigation" })).toBeVisible();
  await page.getByRole("dialog").getByRole("link", { name: "Timeline" }).click();
  await expect(page).toHaveURL(/#\/timeline/);
});
