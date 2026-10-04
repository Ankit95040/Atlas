import { expect, test } from "@playwright/test";

const SCREENS = [
  { name: "landing", hash: "#/" },
  { name: "docs-cli-run", hash: "#/docs/cli/run" },
  { name: "docs-arch", hash: "#/docs/architecture/overview" },
  { name: "research", hash: "#/research" },
  { name: "experiment", hash: "#/research/m29-screening" },
  { name: "timeline", hash: "#/timeline" },
];

test.describe("docs-site visual verification", () => {
  for (const screen of SCREENS) {
    test(`${screen.name} renders without errors @desktop`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (err) => {
        errors.push(err.message);
      });
      page.on("console", (msg) => {
        if (msg.type() === "error") {
          errors.push(msg.text());
        }
      });
      await page.goto(`/${screen.hash}`);
      await expect(page.locator("#root").first()).toBeVisible();
      await page.waitForTimeout(800);
      await page.screenshot({ path: `test-results/m30-${screen.name}-desktop.png` });
      expect(errors, `console/page errors on ${screen.hash}`).toEqual([]);
    });
  }

  test("mobile: landing + docs + research render @mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const hash of ["#/", "#/docs/cli/run", "#/research/m29-screening"]) {
      await page.goto(`/${hash}`);
      await expect(page.locator("#root").first()).toBeVisible();
      await page.waitForTimeout(600);
    }
    await page.screenshot({ path: "test-results/m30-mobile-docs.png" });
  });

  test("tablet: research archive @tablet", async ({ page }) => {
    await page.setViewportSize({ width: 834, height: 1112 });
    await page.goto("/#/research");
    await expect(page.locator("#root").first()).toBeVisible();
    await page.waitForTimeout(600);
    await page.screenshot({ path: "test-results/m30-research-tablet.png" });
  });

  test("search finds commands, concepts, experiments", async ({ page }) => {
    await page.goto("/#/");
    await page.getByRole("banner").getByRole("button", { name: /Search documentation/ }).click();
    const box = page.getByLabel("Search query");
    await box.fill("merge train");
    await expect(page.getByRole("option").first()).toBeVisible();
    const first = await page.getByRole("option").first().textContent();
    expect(first?.toLowerCase()).toContain("merge");
    await box.fill("M29");
    await expect(page.getByRole("option").first()).toBeVisible();
  });

  test("every primary nav item leads somewhere meaningful", async ({ page }) => {
    for (const hash of ["#/", "#/docs", "#/research", "#/timeline", "#/docs/reference/contact"]) {
      await page.goto(`/${hash}`);
      await expect(page.locator("#root").first()).toBeVisible();
      const text = (await page.locator("#main").textContent()) ?? "";
      expect(text.trim().length, hash).toBeGreaterThan(200);
    }
  });

  test("docs index links all resolve to real pages", async ({ page }) => {
    await page.goto("/#/docs");
    const hrefs = await page.$$eval('a[href^="#/docs/"]', (els) =>
      els.map((el) => el.getAttribute("href") ?? ""),
    );
    expect(hrefs.length).toBeGreaterThanOrEqual(6);
    const broken: string[] = [];
    for (const href of [...new Set(hrefs)].slice(0, 60)) {
      await page.goto(`/${href}`);
      const body = ((await page.locator("#main").textContent()) ?? "").trim();
      if (body.length < 200 || body.includes("Page not found")) {
        broken.push(href);
      }
    }
    expect(broken, `broken doc links: ${broken.join(", ")}`).toEqual([]);
  });
});
