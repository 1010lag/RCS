import { test, expect, type Page, type BrowserContext } from "@playwright/test";

test("profile connects Telegram, queues a test and disconnects", async ({ page, context }) => {
  await context.addCookies([{ name: "rcs_session", value: "telegram-test-session", url: "http://127.0.0.1:3181", httpOnly: true, sameSite: "Strict" }]);
  let connected = false, tested = false;
  await page.route("**/api/me/telegram", async route => {
    if (route.request().method() === "DELETE") connected = false;
    await route.fulfill({ json: { configured: true, connected, bot_url: "https://t.me/rcs_test_bot" } });
  });
  await page.route("**/api/me/telegram/link", route => route.fulfill({ json: { url: "https://t.me/rcs_test_bot?start=link_browser-test", expires_in: 600 } }));
  await page.route("**/api/me/telegram/test", async route => { tested = true; await route.fulfill({ json: { accepted: true } }); });
  await page.goto("/#profile");
  const controls = page.getByRole("region", { name: "Уведомления в Telegram" });
  await expect(page.getByRole("region", { name: "Ярлык RCS" })).toHaveCount(0);
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
  await context.addCookies([{ name: "rcs_session", value: "telegram-test-session", url: "http://127.0.0.1:3181", httpOnly: true, sameSite: "Strict" }]);
  await page.route("https://telegram.org/js/telegram-web-app.js", route => route.fulfill({
    contentType: "application/javascript", body: `window.telegramCalls=[]; window.Telegram={WebApp:{initData:'signed-launch-data',ready(){window.telegramCalls.push('ready')},expand(){window.telegramCalls.push('expand')},BackButton:{show(){window.telegramCalls.push('back-show')},hide(){},onClick(){},offClick(){}}}};`,
  }));
  await page.goto("/?tg_target=profile#tgWebAppData=signed-launch-data&tgWebAppVersion=8.0&tgWebAppPlatform=android");
  await expect(page.getByRole("heading", { name: "Профиль", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).telegramCalls)).toEqual(["ready", "expand", "back-show"]);
  await expect(page.locator("html")).toHaveClass(/telegram-app/);
  expect(new URL(page.url()).hash).toBe("#profile");
  expect(page.url()).not.toContain("signed-launch-data");
  await expect(page.getByRole("region", { name: "Ярлык RCS" })).toContainText("Добавление ярлыка недоступно");
  await expect(page.getByRole("button", { name: "На главный экран", exact: true })).toHaveCount(0);
});

async function homeScreenApp(page: Page, context: BrowserContext, status: "missed" | "unknown" | "added" | "unsupported") {
  await context.addCookies([{ name: "rcs_session", value: "telegram-test-session", url: "http://127.0.0.1:3181", httpOnly: true, sameSite: "Strict" }]);
  await page.route("https://telegram.org/js/telegram-web-app.js", route => route.fulfill({
    contentType: "application/javascript", body: `
      const listeners = {};
      window.homeScreenMock = {
        status: ${JSON.stringify(status)}, requests: 0, throwOnAdd: false,
        emit(event) { for (const fn of listeners[event] || []) fn(); }
      };
      window.Telegram = { WebApp: {
        initData: 'signed-launch-data', ready() {}, expand() {},
        isVersionAtLeast: () => true,
        checkHomeScreenStatus(callback) { callback(window.homeScreenMock.status); },
        addToHomeScreen() {
          window.homeScreenMock.requests++;
          if (window.homeScreenMock.throwOnAdd) throw new Error('Unavailable');
        },
        onEvent(event, fn) { (listeners[event] ||= new Set()).add(fn); },
        offEvent(event, fn) { listeners[event]?.delete(fn); },
        BackButton: { show() {}, hide() {}, onClick() {}, offClick() {} }
      }};
    `,
  }));
  await page.goto("/?tg_target=profile#tgWebAppData=signed-launch-data&tgWebAppVersion=8.0&tgWebAppPlatform=android");
  await expect(page.getByRole("region", { name: "Ярлык RCS" })).toBeVisible();
}

for (const status of ["missed", "unknown"] as const) {
  test(`Mini App shortcut (${status}) requests confirmation and marks success only on Telegram's event`, async ({ page, context }) => {
    await homeScreenApp(page, context, status);
    const shortcut = page.getByRole("region", { name: "Ярлык RCS" });
    const add = shortcut.getByRole("button", { name: "На главный экран", exact: true });
    await expect(page.locator(".sidebar").getByRole("button", { name: "На главный экран", exact: true })).toBeVisible();
    await add.click();
    expect(await page.evaluate(() => (window as any).homeScreenMock.requests)).toBe(1);
    await expect(shortcut.getByRole("status")).toContainText("Подтвердите добавление");
    await expect(page.getByRole("button", { name: "Ярлык добавлен", exact: true })).toHaveCount(0);
    // Cancelling the native dialog must leave a working retry button.
    await add.click();
    expect(await page.evaluate(() => (window as any).homeScreenMock.requests)).toBe(2);
    await page.evaluate(() => (window as any).homeScreenMock.emit("homeScreenAdded"));
    await expect(shortcut.getByRole("button", { name: "Ярлык добавлен", exact: true })).toBeDisabled();
    await expect(page.locator(".sidebar").getByRole("button", { name: "Ярлык добавлен", exact: true })).toBeDisabled();
    await expect(shortcut.getByRole("status")).toHaveCount(0);
  });
}

test("Mini App recognises an existing shortcut and rechecks after returning to Telegram", async ({ page, context }) => {
  await homeScreenApp(page, context, "added");
  const shortcut = page.getByRole("region", { name: "Ярлык RCS" });
  await expect(shortcut.getByRole("button", { name: "Ярлык добавлен", exact: true })).toBeDisabled();
  await page.evaluate(() => {
    (window as any).homeScreenMock.status = "missed";
    (window as any).homeScreenMock.emit("activated");
  });
  await expect(shortcut.getByRole("button", { name: "На главный экран", exact: true })).toBeEnabled();
  await page.evaluate(() => {
    (window as any).homeScreenMock.status = "added";
    window.dispatchEvent(new Event("focus"));
  });
  await expect(shortcut.getByRole("button", { name: "Ярлык добавлен", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).homeScreenMock.requests)).toBe(0);
});

test("Mini App explains unsupported devices without offering a shortcut action", async ({ page, context }) => {
  await homeScreenApp(page, context, "unsupported");
  await expect(page.getByRole("region", { name: "Ярлык RCS" })).toContainText("Добавление ярлыка недоступно");
  await expect(page.getByRole("button", { name: "На главный экран", exact: true })).toHaveCount(0);
});

test("Mini App shortcut failure shows a retryable error", async ({ page, context }) => {
  await homeScreenApp(page, context, "missed");
  await page.evaluate(() => { (window as any).homeScreenMock.throwOnAdd = true; });
  const shortcut = page.getByRole("region", { name: "Ярлык RCS" });
  await shortcut.getByRole("button", { name: "На главный экран", exact: true }).click();
  await expect(shortcut.getByRole("status")).toContainText("Не удалось открыть добавление ярлыка");
  await expect(shortcut.getByRole("button", { name: "На главный экран", exact: true })).toBeEnabled();
  await expect(shortcut.getByRole("button", { name: "Ярлык добавлен", exact: true })).toHaveCount(0);
});

test("Mini App shortcut is reachable from the menu on a phone", async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await homeScreenApp(page, context, "missed");
  await page.getByRole("button", { name: "Открыть меню", exact: true }).click();
  const menu = page.locator(".sidebar");
  const add = menu.getByRole("button", { name: "На главный экран", exact: true });
  await expect(add).toBeInViewport();
  await add.click();
  expect(await page.evaluate(() => (window as any).homeScreenMock.requests)).toBe(1);
  await expect(menu.getByRole("status")).toBeInViewport();
});
