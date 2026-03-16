import { expect, test, type Locator, type Page } from "@playwright/test";

const TEST_EMAIL = process.env.E2E_EMAIL;
const TEST_PASSWORD = process.env.E2E_PASSWORD;

function parseClock(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/(\d+):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trackClientFailures(page: Page) {
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const consoleErrors: string[] = [];

  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    consoleErrors.push(message.text());
  });

  page.on("response", async (response) => {
    const url = response.url();
    if (!url.includes("/api/")) return;
    if (response.status() < 500) return;
    requestFailures.push(`${response.status()} ${url}`);
  });

  return { pageErrors, requestFailures, consoleErrors };
}

async function login(page: Page) {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    test.skip(true, "E2E_EMAIL and E2E_PASSWORD are required");
  }

  await page.goto("/login");
  await page.getByLabel("Email").fill(TEST_EMAIL!);
  await page.getByLabel("Password").fill(TEST_PASSWORD!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 15000,
  });
}

async function gotoAndWaitFor(page: Page, path: string, visibleText: RegExp | string) {
  await page.goto(path, { waitUntil: "networkidle" });
  const marker = page.getByText(visibleText).first();
  try {
    await expect(marker).toBeVisible({ timeout: 15000 });
  } catch {
    await page.reload({ waitUntil: "networkidle" });
    await expect(marker).toBeVisible({ timeout: 15000 });
  }
}

async function expectAfterReload(
  page: Page,
  locatorFactory: () => Locator,
  timeout = 15000
) {
  try {
    await expect(locatorFactory()).toBeVisible({ timeout });
  } catch {
    await page.reload({ waitUntil: "networkidle" });
    await expect(locatorFactory()).toBeVisible({ timeout });
  }
}

test.describe("authenticated app flows", () => {
  test("desktop main flows stay usable", async ({ page }) => {
    test.skip(
      test.info().project.name !== "desktop",
      "Desktop-only flow coverage runs in the desktop project"
    );
    test.setTimeout(60000);

    const failures = trackClientFailures(page);

    await login(page);
    await expect(page).toHaveURL(/\/$/);
    await page.request.get("/api/tracks?status=pending&limit=20&order_by=taste_score");
    await page.request.get("/api/stacks");
    await page.request.get("/api/seeds");

    await page.getByRole("link", { name: "Stacks", exact: true }).click();
    await expect(page).toHaveURL(/\/stacks$/);
    await expect(page.getByText("For You")).toBeVisible({ timeout: 30000 });

    const tasteButton = page.getByRole("button", { name: /For You/i });
    await expect(tasteButton).toBeVisible();
    await tasteButton.click();
    await expect(page).toHaveURL(/source=taste/);
    const backToStacks = page.getByTitle("All stacks");
    await expectAfterReload(page, () => backToStacks, 30000);
    await backToStacks.click();
    await expect(page).toHaveURL(/\/stacks$/);

    const firstStackTile = page.locator("button.group.relative.aspect-square").first();
    await expect(firstStackTile).toBeVisible();
    await firstStackTile.click();
    await expect(page).toHaveURL(/source=seed/);
    await page.getByTitle("All stacks").click();
    await expect(page).toHaveURL(/\/stacks\/.+/);
    await expectAfterReload(page, () => page.getByText(/Pending \(|Done \(/).first(), 30000);
    await page.getByRole("button", { name: "Stacks" }).click();
    await expect(page).toHaveURL(/\/stacks$/);

    await page.getByRole("link", { name: "Tracks", exact: true }).click();
    await expect(page).toHaveURL(/\/approved$/);
    await expect(page.getByText(/Unlistened|Kept|Skipped|Nope/).first()).toBeVisible({ timeout: 30000 });
    await page.getByPlaceholder("Search artist or title...").fill("James");
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: /Nope/i }).click();
    await expect(page.getByRole("button", { name: /Nope/i })).toHaveAttribute("class", /ring-red-400/);

    await page.getByRole("link", { name: "Episodes", exact: true }).click();
    await expect(page).toHaveURL(/\/episodes$/);
    await expect(page.getByRole("heading", { name: "Episodes" })).toBeVisible({ timeout: 30000 });
    const firstEpisode = page.locator("button.w-full.text-left").first();
    if (await firstEpisode.isVisible()) {
      await firstEpisode.click();
      await expect(page.getByRole("link", { name: /Open on/i }).first()).toBeVisible();
    }

    await page.getByRole("link", { name: "Curators", exact: true }).click();
    await expect(page).toHaveURL(/\/curators$/);
    await expect(page.getByRole("heading", { name: "Curators" })).toBeVisible({ timeout: 30000 });
    const firstCurator = page.locator("button.group.relative.aspect-square").first();
    if (await firstCurator.isVisible()) {
      await firstCurator.click();
      await expect(page.getByText(/Matched Episodes|Recent Matches|No matched episodes|Loading episodes/i).first()).toBeVisible({ timeout: 15000 });
      await page.keyboard.press("Escape");
    }

    await page.getByRole("link", { name: "Stats", exact: true }).click();
    await expect(page).toHaveURL(/\/stats$/);
    await expect(page.getByRole("heading", { name: "Taste Dashboard" })).toBeVisible({ timeout: 30000 });

    await page.getByRole("link", { name: "Seeds", exact: true }).click();
    await expect(page).toHaveURL(/\/seeds$/);
    await expect(page.getByText("Add tracks as seeds")).toBeVisible({ timeout: 30000 });
    const seedTitle = `PW Title ${Date.now()}`;
    const seedArtist = "PW Artist";
    await page.getByPlaceholder("Title").fill(seedTitle);
    await page.getByPlaceholder("Artist").fill(seedArtist);
    await page.getByRole("button", { name: "Add" }).click();
    const newSeedRow = page.locator("div.rounded-xl").filter({ hasText: seedTitle }).first();
    await expect(newSeedRow).toBeVisible({ timeout: 15000 });
    await newSeedRow.getByTitle(/deactivate/i).click();
    await expect(newSeedRow.getByTitle(/activate/i)).toBeVisible();
    await newSeedRow.getByTitle(/activate/i).click();
    await expect(newSeedRow.getByTitle(/deactivate/i)).toBeVisible();
    await newSeedRow.getByRole("button", { name: "✕" }).click();
    await expect(page.getByText(seedTitle)).toHaveCount(0);
    await page.getByRole("button", { name: /Re-seeds/i }).click();

    expect(failures.pageErrors, `page errors: ${failures.pageErrors.join("\n")}`).toEqual([]);
    expect(failures.requestFailures, `server failures: ${failures.requestFailures.join("\n")}`).toEqual([]);
    expect(failures.consoleErrors, `console errors: ${failures.consoleErrors.join("\n")}`).toEqual([]);
  });

  test("mobile navigation loads primary tabs", async ({ browser }) => {
    test.skip(
      test.info().project.name !== "mobile",
      "Mobile-only flow coverage runs in the mobile project"
    );

    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const failures = trackClientFailures(page);

    await login(page);
    await page.goto("/stacks");
    await page.getByRole("link", { name: "Tracks" }).click();
    await expect(page).toHaveURL(/\/approved$/);
    await page.getByRole("link", { name: "Seeds" }).click();
    await expect(page).toHaveURL(/\/seeds$/);
    await page.getByRole("button", { name: /More|Connected|⚙/i }).click();
    await expect(page.getByText(/Theme|Spotify|Sign out/i).first()).toBeVisible();

    expect(failures.pageErrors, `page errors: ${failures.pageErrors.join("\n")}`).toEqual([]);
    expect(failures.requestFailures, `server failures: ${failures.requestFailures.join("\n")}`).toEqual([]);
    expect(failures.consoleErrors, `console errors: ${failures.consoleErrors.join("\n")}`).toEqual([]);

    await context.close();
  });

  test("desktop re-seeds created from the card show up in Seeds", async ({ page }) => {
    test.skip(
      test.info().project.name !== "desktop",
      "Desktop-only re-seed coverage runs in the desktop project"
    );
    test.setTimeout(60000);

    const failures = trackClientFailures(page);

    await login(page);
    await page.request.get("/api/tracks?status=pending&limit=20&order_by=taste_score");

    await page.goto("/?source=taste", { waitUntil: "networkidle" });
    await expectAfterReload(page, () => page.getByTitle("All stacks"), 30000);

    const reseedButton = page.getByTitle(/Plant as re-seed|Remove re-seed/).last();
    await expect(reseedButton).toBeVisible();
    if ((await reseedButton.getAttribute("title"))?.includes("Remove")) {
      await reseedButton.click();
      await expect(reseedButton).toHaveAttribute("title", /Plant as re-seed/);
    }
    await reseedButton.click();
    await expect(reseedButton).toHaveAttribute("title", /Remove re-seed/);

    await page.getByRole("link", { name: "Seeds", exact: true }).click();
    await expect(page).toHaveURL(/\/seeds$/);
    const reseedsTab = page.getByRole("button", { name: /Re-seeds \(/ });
    await expect(reseedsTab).toBeVisible();
    await reseedsTab.click();
    await expect(page.getByText(/re-seed/i).first()).toBeVisible({ timeout: 15000 });

    expect(failures.pageErrors, `page errors: ${failures.pageErrors.join("\n")}`).toEqual([]);
    expect(failures.requestFailures, `server failures: ${failures.requestFailures.join("\n")}`).toEqual([]);
    expect(failures.consoleErrors, `console errors: ${failures.consoleErrors.join("\n")}`).toEqual([]);
  });

  test("desktop manual seeds do not appear in Re-seeds", async ({ page }) => {
    test.skip(
      test.info().project.name !== "desktop",
      "Desktop-only seed classification coverage runs in the desktop project"
    );
    test.setTimeout(60000);

    const failures = trackClientFailures(page);

    await login(page);
    await page.goto("/seeds", { waitUntil: "networkidle" });
    await expectAfterReload(page, () => page.getByText("Add tracks as seeds"), 30000);

    const seedTitle = `PW Manual Seed ${Date.now()}`;
    const seedArtist = "PW Manual Artist";
    await page.getByPlaceholder("Title").fill(seedTitle);
    await page.getByPlaceholder("Artist").fill(seedArtist);
    await page.getByRole("button", { name: "Add" }).click();

    const newSeedRow = page.locator("div.rounded-xl").filter({ hasText: seedTitle }).first();
    await expect(newSeedRow).toBeVisible({ timeout: 15000 });

    const reseedsTab = page.getByRole("button", { name: /Re-seeds \(/ });
    await reseedsTab.click();
    await expect(page.getByText(seedTitle)).toHaveCount(0);

    await page.getByRole("button", { name: /All \(/ }).click();
    await newSeedRow.getByRole("button", { name: "✕" }).click();
    await expect(page.getByText(seedTitle)).toHaveCount(0);

    expect(failures.pageErrors, `page errors: ${failures.pageErrors.join("\n")}`).toEqual([]);
    expect(failures.requestFailures, `server failures: ${failures.requestFailures.join("\n")}`).toEqual([]);
    expect(failures.consoleErrors, `console errors: ${failures.consoleErrors.join("\n")}`).toEqual([]);
  });

  test("desktop For You can advance through multiple tracks without breaking the UI", async ({ page }) => {
    test.skip(
      test.info().project.name !== "desktop",
      "Desktop-only For You progression coverage runs in the desktop project"
    );
    test.setTimeout(60000);

    const failures = trackClientFailures(page);

    await login(page);
    await page.request.get("/api/tracks?status=pending&limit=20&order_by=taste_score");

    await page.goto("/?source=taste", { waitUntil: "networkidle" });
    await expectAfterReload(page, () => page.getByTitle("All stacks"), 30000);

    const title = page.getByRole("heading", { level: 2 }).first();
    await expect(title).toBeVisible();
    const seenTitles = new Set<string>();

    for (let i = 0; i < 3; i++) {
      const currentTitle = (await title.textContent())?.trim() || "";
      seenTitles.add(currentTitle);
      await page.keyboard.press("k");
      await expect.poll(async () => ((await title.textContent()) || "").trim(), {
        timeout: 15000,
      }).not.toBe(currentTitle);
      await expect(page.getByTitle("All stacks")).toBeVisible();
    }

    expect(seenTitles.size).toBeGreaterThan(1);
    expect(failures.pageErrors, `page errors: ${failures.pageErrors.join("\n")}`).toEqual([]);
    expect(failures.requestFailures, `server failures: ${failures.requestFailures.join("\n")}`).toEqual([]);
    expect(failures.consoleErrors, `console errors: ${failures.consoleErrors.join("\n")}`).toEqual([]);
  });

  test("desktop playback controls work on an audio-backed track", async ({ page }) => {
    test.skip(
      test.info().project.name !== "desktop",
      "Desktop-only playback coverage runs in the desktop project"
    );
    test.setTimeout(60000);

    const failures = trackClientFailures(page);

    await login(page);
    const response = await page.request.get("/api/tracks?status=pending&limit=20&order_by=taste_score");
    const data = await response.json();
    const audioTrack = (data.tracks || []).find(
      (track: { title: string; artist: string; audio_url?: string | null; preview_url?: string | null }) =>
        track.audio_url || track.preview_url
    );

    test.skip(!audioTrack, "No audio-backed pending track available");

    await page.goto("/?source=taste", { waitUntil: "networkidle" });
    await expectAfterReload(page, () => page.getByTitle("All stacks"), 30000);

    const listButton = page
      .getByRole("button", {
        name: new RegExp(`${escapeRegex(audioTrack.title)}\\s+${escapeRegex(audioTrack.artist)}`),
      })
      .first();
    await listButton.click();

    const playerTime = page.locator(".global-player").getByText(/\d+:\d{2} \/ \d+:\d{2}/).first();
    await expect(playerTime).toBeVisible();

    const transportButton = page.getByRole("button", { name: /Play track|Pause track/ }).first();
    await expect(transportButton).toBeVisible();
    if ((await transportButton.getAttribute("aria-label")) === "Play track") {
      await transportButton.click();
    }

    const startedAt = parseClock(await playerTime.textContent());
    await expect
      .poll(async () => parseClock(await playerTime.textContent()), { timeout: 15000 })
      .toBeGreaterThan(startedAt ?? 0);

    const beforeSkip = parseClock(await playerTime.textContent()) ?? 0;
    await page.getByRole("button", { name: "Skip ahead 30 seconds" }).first().click();
    await expect
      .poll(async () => parseClock(await playerTime.textContent()), { timeout: 15000 })
      .toBeGreaterThan(beforeSkip);

    await page.getByRole("button", { name: "Pause track" }).first().click();
    await expect(page.getByRole("heading", { level: 2, name: audioTrack.title })).toBeVisible();

    expect(failures.pageErrors, `page errors: ${failures.pageErrors.join("\n")}`).toEqual([]);
    expect(failures.requestFailures, `server failures: ${failures.requestFailures.join("\n")}`).toEqual([]);
    expect(failures.consoleErrors, `console errors: ${failures.consoleErrors.join("\n")}`).toEqual([]);
  });

  test("desktop sidebar selection changes the card without reordering the visible list", async ({ page }) => {
    test.skip(
      test.info().project.name !== "desktop",
      "Desktop-only sidebar ordering coverage runs in the desktop project"
    );
    test.setTimeout(60000);

    const failures = trackClientFailures(page);

    await login(page);
    await page.goto("/?source=taste", { waitUntil: "networkidle" });
    await expectAfterReload(page, () => page.getByTitle("All stacks"), 30000);

    const listItems = page.locator("button.w-full.text-left");
    const topBefore = ((await listItems.nth(0).textContent()) || "").trim();
    const clickedTitle = ((await listItems.nth(5).locator("p").first().textContent()) || "").trim();

    await listItems.nth(5).click();
    await expect(page.getByRole("heading", { level: 2, name: clickedTitle })).toBeVisible();

    const topAfter = ((await listItems.nth(0).textContent()) || "").trim();
    expect(topAfter).toBe(topBefore);

    expect(failures.pageErrors, `page errors: ${failures.pageErrors.join("\n")}`).toEqual([]);
    expect(failures.requestFailures, `server failures: ${failures.requestFailures.join("\n")}`).toEqual([]);
    expect(failures.consoleErrors, `console errors: ${failures.consoleErrors.join("\n")}`).toEqual([]);
  });
});
