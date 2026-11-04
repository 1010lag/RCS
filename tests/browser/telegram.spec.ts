import { test, expect } from "@playwright/test";

test("profile connects Telegram, queues a test and disconnects", async ({ page, context }) => {
  await context.addCookies([{ name: "rcs_session", value: "native-layout-test-session", url: "http://127.0.0.1:3181", httpOnly: true, sameSite: "Strict" }]);
  let connected = false, tested = false;
  await page.route("**/api/me/telegram", async route => {
    if (route.request().method() === "DELETE") connected = false;
    await route.fulfill({ json: { configured: true, connected, bot_url: "https://t.me/rcs_test_bot" } });
  });
  await page.route("**/api/me/telegram/link", route => route.fulfill({ json: { url: "https://t.me/rcs_test_bot?start=link_browser-test", expires_in: 600 } }));
  await page.route("**/api/me/telegram/test", async route => { tested = true; await route.fulfill({ json: { accepted: true } }); });
  await page.goto("/#profile");
  const controls = page.getByRole("region", { name: "Уведомления в Telegram" });
  await controls.getByRole("button", { name: "Подключить Telegram", exact: true }).click();
  await expect(controls.getByRole("button", { name: "Открыть бота и подключить" })).toBeVisible();
  connected = true;
  await controls.getByRole("button", { name: "Проверить подключение" }).click();
  await expect(controls.getByText("Telegram подключён", { exact: true })).toBeVisible();
  await controls.getByRole("button", { name: "Проверить Telegram", exact: true }).click();
  await expect.poll(() => tested).toBe(true);
  await controls.getByRole("button", { name: "Отключить Telegram", exact: true }).click();
  await expect(controls.getByText("Telegram пока не подключён", { exact: true })).toBeVisible();
});

test("Mini App loads the SDK, expands and preserves the notification destination", async ({ page, context }) => {
  await context.addCookies([{ name: "rcs_session", value: "native-layout-test-session", url: "http://127.0.0.1:3181", httpOnly: true, sameSite: "Strict" }]);
  await page.route("https://telegram.org/js/telegram-web-app.js", route => route.fulfill({
    contentType: "application/javascript", body: `window.telegramCalls=[]; window.Telegram={WebApp:{initData:'signed-launch-data',ready(){window.telegramCalls.push('ready')},expand(){window.telegramCalls.push('expand')},BackButton:{show(){window.telegramCalls.push('back-show')},hide(){},onClick(){},offClick(){}}}};`,
  }));
  await page.goto("/?tg_target=profile#tgWebAppData=signed-launch-data&tgWebAppVersion=8.0&tgWebAppPlatform=android");
  await expect(page.getByRole("heading", { name: "Профиль", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).telegramCalls)).toEqual(["ready", "expand", "back-show"]);
  await expect(page.locator("html")).toHaveClass(/telegram-app/);
  expect(new URL(page.url()).hash).toBe("#profile");
  expect(page.url()).not.toContain("signed-launch-data");
});
