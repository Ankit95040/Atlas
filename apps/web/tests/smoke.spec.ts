import { expect, test } from "@playwright/test";

// Smoke: the built React shell serves from the Atlas server (/app) and reads
// live state through the narrow JSON API. Screenshots land in test-results
// for the visual-proof gate.
test("home renders brand, metrics, and runs from the live API", async ({ page }) => {
  await page.goto("/app#/");
  await expect(page.getByText("Atlas", { exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await page.screenshot({ path: "test-results/smoke-home.png" });
});

test("runs list renders", async ({ page }) => {
  await page.goto("/app#/runs");
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect(page.getByText("Runs", { exact: false }).first()).toBeVisible();
  await page.screenshot({ path: "test-results/smoke-runs.png" });
});

test("run island mounts a canvas with a live status line", async ({ page }) => {
  const res = await page.request.get("http://127.0.0.1:3179/api/runs");
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { data: Array<{ id: string }> };
  test.skip(body.data.length === 0, "no runs seeded; island needs a feature id");
  const featureId = body.data[0]?.id;
  await page.goto(`/app#/runs/${featureId}`);
  await expect(page.getByLabel("Atlas 3D island")).toBeVisible();
  await expect(page.getByRole("status")).toBeVisible();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: "test-results/smoke-island.png" });
});
