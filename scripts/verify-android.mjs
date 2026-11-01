import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const endpoint = new URL(process.env.RCS_CDP_URL ?? "http://127.0.0.1:9223");
if (endpoint.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(endpoint.hostname)) {
  throw new Error("Use the local ADB-forwarded RCS WebView endpoint.");
}
const browser = await chromium.connectOverCDP(endpoint.origin, { timeout: 10000 });
const passed = [];
const record = (check) => { passed.push(check); console.log(`PASS: ${check}`); };
try {
  const page = browser.contexts().flatMap((context) => context.pages()).find((page) => page.url().startsWith("https://localhost/"));
  if (!page) throw new Error("RCS WebView not found. Start the installed RCS app.");
  page.setDefaultTimeout(10000);
  if (await page.evaluate(() => document.visibilityState !== "visible")) {
    throw new Error("Leave RCS open with the phone unlocked while UI checks run.");
  }
  const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const closeMenu = () => page.getByRole("button", { name: "Закрыть меню", exact: true }).click({ position: { x: dimensions.width - 16, y: 160 } });
  const navigate = async (mobileName, sidebarName) => {
    const bottomButton = page.locator(".bottom-nav").getByRole("button", { name: mobileName, exact: true });
    if (await bottomButton.count()) return bottomButton.click();
    if (await page.locator(".mobile-menu").isVisible()) await page.getByRole("button", { name: "Открыть меню", exact: true }).click();
    await page.locator(".sidebar").getByRole("button", { name: sidebarName, exact: true }).click();
  };
  if (await page.locator(".sidebar.open").count()) await closeMenu();
  if (await page.getByRole("dialog").count()) await page.getByRole("button", { name: "Закрыть диалог", exact: true }).click();
  await expect(page.locator(".topbar")).toBeVisible();
  const layout = await page.evaluate(() => {
    const bounds = (selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight, pixelRatio: devicePixelRatio },
      bodyTop: parseFloat(getComputedStyle(document.body).paddingTop),
      header: bounds(".topbar"), menu: bounds(".mobile-menu"), bell: bounds(".bell-btn"),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  });
  if (layout.header.y < layout.bodyTop || layout.menu.y < layout.bodyTop || layout.bell.y < layout.bodyTop) {
    throw new Error("App controls overlap the system status bar.");
  }
  if (layout.horizontalOverflow) throw new Error("App has horizontal overflow.");
  record("Header and buttons fit below the Android status bar");
  await page.locator(".bell-btn").click();
  await expect(page.getByRole("heading", { name: "Уведомления", exact: true })).toBeVisible();
  record("Notification button opens notifications");
  await page.getByRole("button", { name: "Открыть меню", exact: true }).click();
  await expect(page.locator(".sidebar")).toHaveClass(/open/);
  await closeMenu();
  await expect(page.locator(".sidebar")).not.toHaveClass(/open/);
  record("Menu opens and closes");
  await navigate("График", "График смен");
  await expect(page.getByRole("heading", { name: "График смен", exact: true })).toBeVisible();
  record("Schedule opens");
  await page.getByRole("button", { name: "Месяц", exact: true }).click();
  const month = await page.locator(".month-grid").evaluate((grid) => {
    const dates = [...grid.querySelectorAll(".month-cell")].map((cell) => cell.dataset.date);
    const boxes = [...grid.children].map((cell) => {
      const box = cell.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    });
    return { dates, boxes, blankButtons: grid.querySelectorAll(".month-placeholder button").length };
  });
  if (month.dates.length < 28 || month.dates.some((date) => date.slice(0, 7) !== month.dates[0].slice(0, 7))) throw new Error("Calendar contains dates outside its month.");
  if (month.boxes.length % 7 || month.blankButtons) throw new Error("Month grid is incomplete or has interactive blank cells.");
  for (let i = 0; i < month.boxes.length; i++) {
    const cell = month.boxes[i], firstInRow = month.boxes[Math.floor(i / 7) * 7];
    if (Math.abs(cell.x - month.boxes[i % 7].x) > 1 || Math.abs(cell.y - firstInRow.y) > 1 || Math.abs(cell.height - firstInRow.height) > 1) throw new Error("Month calendar has uneven rows or columns.");
  }
  await mkdir(".data/qa/phone", { recursive: true });
  await page.screenshot({ path: ".data/qa/phone/calendar-month.png", timeout: 10000 });
  record("Month is a complete rectangular grid with only selected-month dates");
  await page.getByRole("button", { name: "День", exact: true }).click();
  await navigate("Профиль", "Настройки");
  await expect(page.getByRole("heading", { name: "Профиль", exact: true }).first()).toBeVisible();
  record("Profile opens");
  if (await page.getByRole("button", { name: "Тёмная", exact: true }).count()) {
    const originalTheme = await page.evaluate(() => localStorage.getItem("rcs-theme"));
    await page.getByRole("button", { name: "Тёмная", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator(".preferences")).toHaveCSS("background-color", "rgb(24, 24, 28)");
    await mkdir(".data/qa/phone", { recursive: true });
    await page.screenshot({ path: ".data/qa/phone/theme-dark.png", timeout: 10000 });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.getByRole("button", { name: "Тёмная", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Светлая", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.locator(".preferences")).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await page.screenshot({ path: ".data/qa/phone/theme-light.png", timeout: 10000 });
    if (originalTheme === "dark") await page.getByRole("button", { name: "Тёмная", exact: true }).click();
    record("Light and dark themes switch immediately and survive reload");
  }
  if (await page.locator(".sidebar").getByRole("button", { name: "Команда", exact: true }).count()) {
    await navigate("Команда", "Команда");
    const employeeDelete = page.locator(".employee-card").getByRole("button", { name: "Удалить сотрудника", exact: true }).filter({ visible: true });
    for (const button of await employeeDelete.all()) {
      if (await button.isDisabled()) continue;
      await button.click();
      await expect(page.getByRole("dialog")).toContainText("История отработанных смен и начислений сохранится");
      await page.getByRole("dialog").getByRole("button", { name: "Отмена", exact: true }).click();
      record("Employee deletion confirmation opens and can be cancelled");
      break;
    }
    await navigate("Типы смен", "Типы смен");
    const typeDelete = page.locator(".type-card").getByRole("button", { name: "Удалить тип смены", exact: true }).first();
    if (await typeDelete.count()) {
      await typeDelete.click();
      await expect(page.getByRole("dialog")).toContainText("Назначенные смены и их оплата сохранятся");
      await page.getByRole("dialog").getByRole("button", { name: "Отмена", exact: true }).click();
      record("Shift type deletion confirmation opens and can be cancelled");
    }
  }
  await navigate("Сегодня", "Обзор");
  const detail = page.getByRole("button", { name: "Подробнее о смене", exact: true });
  if (await detail.count()) {
    await detail.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.locator(".detail-time")).toBeVisible();
    await expect(page.getByRole("dialog").getByRole("alert")).toHaveCount(0);
    record("Shift details load without an error");
    await page.getByRole("button", { name: "Закрыть диалог", exact: true }).click();
  }
  await mkdir(".data/qa/phone", { recursive: true });
  await writeFile(".data/qa/phone/ui-check.json", JSON.stringify({ mode: "physical Android WebView via ADB/CDP", passed, layout }, null, 2));
  console.log("Phone UI checks complete; shifts and pay were not changed.");
} finally {
  await browser.close();
}
