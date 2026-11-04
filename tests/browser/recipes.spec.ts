import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

async function session(context: BrowserContext, admin = false) {
  await context.setExtraHTTPHeaders({ "X-Forwarded-For": admin ? "127.10.0.2" : "127.10.0.1" });
  await context.addCookies([{ name: "rcs_session", value: admin ? "recipes-test-admin" : "recipes-test-barista", url: "http://127.0.0.1:3181", httpOnly: true, sameSite: "Strict" }]);
}
async function add(page: Page, title: string) {
  await page.getByRole("button", { name: "Добавить рецепт", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Название рецепта", { exact: true }).fill(title);
  await dialog.getByLabel("Кофе", { exact: true }).fill("15 г");
  await dialog.getByLabel("Вода", { exact: true }).fill("250 мл");
  await dialog.getByLabel("Температура", { exact: true }).fill("93 °C");
  await dialog.getByLabel("Помол", { exact: true }).fill("Средний");
  await dialog.getByLabel("Время", { exact: true }).fill("2:30");
  await dialog.getByLabel("Приготовление", { exact: true }).fill("1. Прогреть фильтр.\n2. Влить воду.\n3. Подождать и подать.");
  await dialog.getByRole("button", { name: "Сохранить рецепт", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
}

test("employees share recipes across all three methods and can delete each other's cards", async ({ page, context, browser }) => {
  await session(context);
  await page.goto("/#recipes");
  await expect(page.getByRole("heading", { name: "Рецепты альтернативы", exact: true })).toBeVisible();
  await expect(page.getByRole("tab")).toHaveText(["Аэропресс", "V60", "Бонавита"]);
  await expect(page.locator(".bottom-nav").getByRole("button", { name: "Рецепты", exact: true, includeHidden: true })).toHaveCount(1);
  const otherContext = await browser.newContext({ baseURL: "http://127.0.0.1:3181" });
  try {
    await session(otherContext, true);
    const other = await otherContext.newPage();
    await other.goto("/#recipes");
    await expect(other.getByRole("tab", { name: "Аэропресс", exact: true })).toHaveAttribute("aria-selected", "true");
    for (const [method, title] of [["Аэропресс", "Общий аэропресс"], ["V60", "Общий V60"], ["Бонавита", "Общая бонавита"]]) {
      await page.getByRole("tab", { name: method, exact: true }).click();
      await add(page, title);
      await other.getByRole("tab", { name: method, exact: true }).click();
      await expect(other.getByRole("heading", { name: title, exact: true })).toBeVisible({ timeout: 20000 });
      await expect(other.locator(".recipe-card")).toHaveCount(1);
      await other.getByRole("button", { name: `Открыть рецепт «${title}»`, exact: true }).click();
      await expect(other.getByRole("dialog")).toContainText("1. Прогреть фильтр.");
      await other.getByRole("dialog").getByRole("button", { name: "Удалить рецепт", exact: true }).click();
      await expect(other.getByRole("dialog")).toContainText("у всей команды");
      await other.getByRole("dialog").getByRole("button", { name: "Отмена", exact: true }).click();
      await expect(other.getByRole("heading", { name: title, exact: true })).toBeVisible();
      await other.getByRole("button", { name: `Удалить рецепт «${title}»`, exact: true }).click();
      await other.getByRole("dialog").getByRole("button", { name: "Удалить рецепт", exact: true }).click();
      await expect(other.getByRole("dialog")).not.toBeVisible();
      await expect(page.getByRole("heading", { name: title, exact: true })).toHaveCount(0, { timeout: 20000 });
    }
  } finally { await otherContext.close(); }
});

test("mobile recipes keep two columns in both themes and remain readable offline", async ({ page, context }) => {
  await session(context);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/#recipes");
  await expect(page.getByRole("button", { name: "Добавить рецепт", exact: true })).toBeEnabled();
  await add(page, "Аэропресс для утренней смены");
  await add(page, "Аэропресс с долгим предсмачиванием");
  const me = await (await context.request.get("/api/auth/me")).json();
  const records = await (await context.request.get("/api/recipes")).json();
  try {
    await mkdir(".data/qa", { recursive: true });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(value => { localStorage.setItem("rcs-theme", value); document.documentElement.dataset.theme = value; }, theme);
      const cards = page.locator(".recipe-card"), first = await cards.nth(0).boundingBox(), second = await cards.nth(1).boundingBox();
      expect(first).not.toBeNull(); expect(second).not.toBeNull();
      expect(Math.abs(first!.y - second!.y)).toBeLessThan(1);
      expect(second!.x).toBeGreaterThan(first!.x + first!.width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: `.data/qa/recipes-mobile-${theme}.png`, fullPage: true });
    }
    await page.getByRole("button", { name: "Открыть рецепт «Аэропресс для утренней смены»", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("250 мл");
    await expect(page.getByRole("dialog")).toContainText("3. Подождать и подать.");
    await page.getByRole("dialog").getByRole("button", { name: "Закрыть", exact: true }).click();
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await expect.poll(() => page.evaluate(async () => Boolean(navigator.serviceWorker.controller))).toBe(true);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByText(/Показаны сохранённые данные/)).toBeVisible();
    await expect(page.locator(".recipe-card")).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Добавить рецепт", exact: true })).toBeDisabled();
    await expect(page.locator(".recipe-delete").first()).toBeDisabled();
    await page.getByRole("button", { name: "Открыть рецепт «Аэропресс для утренней смены»", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("3. Подождать и подать.");
  } finally {
    await context.setOffline(false);
    for (const record of records) await context.request.delete(`/api/recipes/${record.id}`, { headers: { "X-CSRF-Token": me.csrf } });
  }
});
