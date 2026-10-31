import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import sharp from "sharp";
async function login(page: Page, i = 0) {
  await page.goto("/");
  await page.getByLabel("Телефон", { exact: true }).fill(`+37529000000${i}`);
  await page.getByLabel("Пароль", { exact: true }).fill("BrowserTests!2026");
  await page.getByRole("button", { name: "Войти в RCS" }).click();
  await expect(page.getByRole("heading", { name: /Добро/ })).toBeVisible();
  await expect(page.getByText("Синхронизировано")).toBeVisible();
}
test("desktop: dashboard, create shift, types, team, payroll, audit and profile", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1100 });
  await login(page);
  await expect(page.getByText("Хороший день")).toBeVisible();
  await expect(page.locator(".person-cell").first()).toBeVisible();
  await mkdir(".data/qa", { recursive: true });
  await page.screenshot({ path: ".data/qa/admin-desktop.png", fullPage: true });
  await page
    .getByRole("button", { name: "Добавить смену", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const today = await page.evaluate(() =>
    new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Minsk",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date()),
  );
  const future = new Date(Date.parse(today) + 4 * 86400000)
    .toISOString()
    .slice(0, 10);
  await dialog.getByLabel("Дата", { exact: true }).fill(future);
  await dialog
    .locator('select[name="user_id"]')
    .selectOption({ label: "Максим Ковалёв" });
  await dialog.getByRole("button", { name: "Сохранить смену" }).click();
  await expect(page.getByRole("status")).toContainText("Смена сохранена");
  for (const [button, title] of [
    ["Команда", "Команда"],
    ["Типы смен", "Типы смен"],
    ["Расчёты", "Часы и начисления"],
    ["Журнал действий", "Журнал действий"],
    ["Настройки", "Профиль"],
  ]) {
    await page
      .locator(".sidebar")
      .getByRole("button", { name: button, exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: title, exact: true }).first(),
    ).toBeVisible();
  }
  expect(errors).toEqual([]);
});
test("mobile: role restrictions, exchange quote, take, personal pay and logout", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 2);
  await expect(page.locator(".bottom-nav")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Добавить смену", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: ".data/qa/barista-mobile.png",
    fullPage: true,
  });
  await page
    .locator(".bottom-nav")
    .getByRole("button", { name: "Биржа", exact: true })
    .click();
  await page.getByRole("button", { name: "Посмотреть и забрать" }).click();
  await expect(page.getByRole("dialog")).toContainText("98,00 Br");
  await page.getByRole("button", { name: "Подтвердить и забрать" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Смена теперь в вашем графике",
  );
  await expect(page.locator(".listing-card")).toHaveCount(0);
  await page
    .locator(".bottom-nav")
    .getByRole("button", { name: "Сегодня", exact: true })
    .click();
  await expect(page.locator(".next-shift")).toContainText("98,00 Br");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth + 1,
  );
  expect(overflow).toBe(false);
  await page
    .locator(".bottom-nav")
    .getByRole("button", { name: "Профиль", exact: true })
    .click();
  await page.getByRole("button", { name: "Выйти из аккаунта" }).click();
  await expect(page.getByRole("button", { name: "Войти в RCS" })).toBeVisible();
  expect(
    await page.evaluate(() => sessionStorage.getItem("rcs-user")),
  ).toBeNull();
});
test("two sessions: server event refreshes notification view", async ({
  browser,
}) => {
  const adminContext = await browser.newContext(),
    baristaContext = await browser.newContext(),
    adminPage = await adminContext.newPage(),
    baristaPage = await baristaContext.newPage();
  await login(adminPage);
  await login(baristaPage, 1);
  await baristaPage
    .locator(".sidebar")
    .getByRole("button", { name: "Уведомления", exact: true })
    .click();
  await expect(
    baristaPage.getByText("Добро пожаловать", { exact: true }),
  ).toBeVisible();
  await adminPage.evaluate(async () => {
    const me = await (await fetch("/api/auth/me")).json();
    const r = await fetch("/api/admin/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": me.csrf },
      body: JSON.stringify({
        title: "Тест синхронизации",
        body: "Новое событие без перезапуска страницы",
        user_id: null,
      }),
    });
    if (!r.ok) throw new Error(await r.text());
  });
  await expect(
    baristaPage.getByText("Тест синхронизации", { exact: true }),
  ).toBeVisible({ timeout: 5000 });
  await adminContext.close();
  await baristaContext.close();
});
test("offline PWA restores the user snapshot and disables mutations", async ({
  page,
  context,
}) => {
  await login(page, 1);
  await expect(page.locator(".person-cell").first()).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const r = indexedDB.open("rcs-private", 1);
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
        return new Promise<boolean>((resolve) => {
          const req = db
            .transaction("snapshots")
            .objectStore("snapshots")
            .getAll();
          req.onsuccess = () => {
            resolve(req.result.length > 0);
            db.close();
          };
        });
      }),
    )
    .toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText(/Показаны сохранённые данные/)).toBeVisible();
  await expect(page.locator(".person-cell").first()).toBeVisible();
  await expect(
    page.getByText("Нет подключения", { exact: true }),
  ).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText("Синхронизировано")).toBeVisible();
});
test("admin changes a barista hourly rate from their team card", async ({
  page,
}) => {
  await login(page);
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Команда", exact: true })
    .click();
  const card = page.locator(".employee-card").filter({
    has: page.getByRole("heading", { name: "Анна Смирнова", exact: true }),
  });
  await card.getByRole("button", { name: "Изменить ставку в час" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Ставка в час, Br", { exact: true }).fill("17.50");
  await dialog.getByLabel("Пересчитать будущие почасовые смены").uncheck();
  await dialog
    .getByLabel("Причина изменения", { exact: true })
    .fill("Повышение почасовой ставки");
  await dialog.getByRole("button", { name: "Сохранить ставку" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Почасовая ставка обновлена",
  );
  await expect(card).toContainText("17,50 Br / час");
});

test("light and dark themes persist across reloads and synchronize between tabs", async ({ page }) => {
  await page.context().addCookies([{
    name: "rcs_session", value: "native-layout-test-session",
    url: "http://127.0.0.1:3181", httpOnly: true, sameSite: "Strict",
  }]);
  await page.goto("/#profile");
  await expect(page.getByRole("button", { name: "Светлая", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Тёмная", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".preferences")).toHaveCSS("background-color", "rgb(24, 24, 28)");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("button", { name: "Тёмная", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: ".data/qa/dark-desktop-settings.png", fullPage: true });
  const secondTab = await page.context().newPage();
  await secondTab.goto("/#profile");
  await expect(secondTab.locator("html")).toHaveAttribute("data-theme", "dark");
  await secondTab.getByRole("button", { name: "Светлая", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator(".preferences")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await secondTab.close();
});

test("calendar uses Minsk when the device is in Los Angeles", async ({
  browser,
}) => {
  const context = await browser.newContext({
      timezoneId: "America/Los_Angeles",
    }),
    page = await context.newPage();
  await login(page, 1);
  const serverDate = await page.evaluate(async () => {
    const me = await (await fetch("/api/auth/me")).json();
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Minsk",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(me.server_now));
  });
  await expect(page.locator(".date-pill")).toContainText(
    String(Number(serverDate.slice(-2))),
  );
  await context.close();
});

test("device push controls show registration, test acceptance and disconnect", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["notifications"]);
  // Headless Windows can still report OS-level denial. This scenario tests the
  // granted browser state and a fake FCM sender, not the operating system tray.
  await page.addInitScript(() =>
    Object.defineProperty(Notification, "permission", {
      configurable: true,
      get: () => "granted",
    }),
  );
  await login(page, 1);
  await page.evaluate(async () => {
    const me = await (await fetch("/api/auth/me")).json();
    const r = await fetch("/api/me/push-devices", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": me.csrf },
      body: JSON.stringify({ token: "browser-test-device-registration-token" }),
    });
    if (!r.ok) throw new Error(await r.text());
    const device = await r.json();
    localStorage.setItem("rcs-push-device", device.id);
    localStorage.setItem("rcs-push-user", me.user.id);
  });
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Настройки", exact: true })
    .click();
  await expect(
    page.getByText("Включены на устройстве", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Проверить push", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Тестовый push принят к отправке",
  );
  await page.getByRole("button", { name: "Отключить на устройстве" }).click();
  await expect(
    page.getByRole("button", { name: "Включить push на устройстве" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem("rcs-push-device")),
  ).toBeNull();
});

test("admin can cancel or confirm employee and shift type removal on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.context().addCookies([{
    name: "rcs_session", value: "admin-ui-test-session",
    url: "http://127.0.0.1:3181", httpOnly: true, sameSite: "Strict",
  }]);
  const headers = { "X-CSRF-Token": "admin-ui-test-csrf" };
  const added = await page.request.post("/api/employees", { headers, data: {
    name: "Тест удаления", phone: "+375299999990", role: "barista", rate: "10.00", pay_type: "hourly", password: "DeleteFixture!2026",
  } });
  expect(added.ok()).toBe(true);
  const type = await page.request.post("/api/shift-types", { headers, data: {
    name: "Тестовый тип удаления", start_time: "09:00", end_time: "12:00", pay_type: "hourly", rate: "11.00", allow_exchange: true,
  } });
  expect(type.ok()).toBe(true);
  const employee = await added.json(), createdType = await type.json();
  const scheduledDay = new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10);
  const shift = await page.request.post("/api/shifts", { headers, data: {
    date: scheduledDay, start_time: "09:00", end_time: "12:00", type_id: createdType.id, user_id: employee.id, status: "confirmed",
  } });
  expect(shift.ok()).toBe(true);
  const shiftId = (await shift.json()).id;
  const calendarPage = await page.context().newPage();
  await calendarPage.goto("/#schedule");
  await calendarPage.getByRole("button", { name: "Месяц", exact: true }).click();
  const calendarShift = calendarPage.locator(".shift-chip").filter({ hasText: "Тестовый тип удаления" });
  await expect(calendarShift).toHaveCount(1);
  await page.goto("/#employees");
  const card = page.locator(".employee-card").filter({ has: page.getByRole("heading", { name: "Тест удаления", exact: true }) });
  await card.getByRole("button", { name: "Удалить сотрудника", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("История отработанных смен и начислений сохранится");
  await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Удалить сотрудника", exact: true }).click();
  await dialog.getByLabel("Причина удаления", { exact: true }).fill("Сотрудник уволился");
  await dialog.getByRole("button", { name: "Удалить сотрудника", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Сотрудник удалён из команды");
  await expect(card).toHaveCount(0);
  await expect(calendarShift).toHaveCount(0, { timeout: 5000 });
  const schedule = await (await page.request.get(`/api/schedule?from=${scheduledDay}&to=${scheduledDay}`)).json();
  expect(schedule.some((item: any) => item.id === shiftId)).toBe(false);
  expect((await (await page.request.get(`/api/shifts/${shiftId}`)).json()).status).toBe("cancelled");
  await calendarPage.close();
  await page.getByRole("button", { name: "Архив сотрудников", exact: true }).click();
  await expect(card).toContainText("В архиве");
  await page.screenshot({ path: ".data/qa/employee-archive.png", fullPage: true });
  await page.getByRole("button", { name: "Показать команду", exact: true }).click();
  await page.getByRole("button", { name: "Открыть меню", exact: true }).click();
  await page.locator(".sidebar").getByRole("button", { name: "Типы смен", exact: true }).click();
  const typeCard = page.locator(".type-card").filter({ has: page.getByRole("heading", { name: "Тестовый тип удаления", exact: true }) });
  await typeCard.getByRole("button", { name: "Удалить тип смены", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Назначенные смены и их оплата сохранятся");
  await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
  await expect(typeCard).toBeVisible();
  await typeCard.getByRole("button", { name: "Удалить тип смены", exact: true }).click();
  await dialog.getByRole("button", { name: "Удалить тип смены", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Тип смены удалён");
  await expect(typeCard).toHaveCount(0);
  await page.getByRole("button", { name: "Архив типов смен", exact: true }).click();
  await expect(typeCard).toContainText("В архиве");
});

test("Android portrait at 9:16 keeps app controls within the phone screen", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 360, height: 640 },
    isMobile: true,
    hasTouch: true,
  });
  await context.addCookies([{
    name: "rcs_session", value: "native-layout-test-session",
    url: "http://127.0.0.1:3181", httpOnly: true, sameSite: "Strict",
  }]);
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("rcs-server", location.origin);
    (window as any).androidBridge = {};
    (window as any).Capacitor = {
      PluginHeaders: [
        { name: "SystemBars", methods: [{ name: "setStyle", rtype: "promise" }] },
        { name: "App", methods: [{ name: "addListener", rtype: "callback" }, { name: "removeListener", rtype: "promise" }] },
        {
          name: "CapacitorHttp",
          methods: [
            { name: "get", rtype: "promise" },
            { name: "request", rtype: "promise" },
          ],
        },
      ],
      nativeCallback: () => "test-app-state-listener",
      nativePromise: async (_plugin: string, method: string, options: any) => {
        if (_plugin === "SystemBars" || _plugin === "App") return {};
        const headers = { ...options.headers };
        // Android can add a form content type to POSTs without explicit data.
        if (options.method === "POST" && options.data === undefined && !headers["Content-Type"])
          headers["Content-Type"] = "application/x-www-form-urlencoded";
        const response = await fetch(options.url, {
          method: method === "get" ? "GET" : options.method,
          headers,
          credentials: "include",
          ...(options.data === undefined
            ? {}
            : { body: JSON.stringify(options.data) }),
        });
        return {
          status: response.status,
          data: await response.json(),
          headers: Object.fromEntries(response.headers.entries()),
          url: options.url,
        };
      },
    };
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Добро/ })).toBeVisible();
  await expect(page.getByText("Синхронизировано")).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/native-app/);
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--safe-area-inset-top", "32px");
    document.documentElement.style.setProperty("--safe-area-inset-bottom", "24px");
    window.scrollTo(0, 0);
  });
  const assertSafeHeader = async () => {
    const header = await page.locator(".topbar").boundingBox();
    expect(header!.y).toBeGreaterThanOrEqual(32);
    const navButton = await page.locator(".bottom-nav button").first().boundingBox();
    expect(navButton!.y + navButton!.height).toBeLessThanOrEqual(640 - 24);
  };
  await assertSafeHeader();
  await page.evaluate(() => window.scrollTo(0, 400));
  await assertSafeHeader();
  await page.locator(".bell-btn").click();
  await expect(page.getByRole("heading", { name: "Уведомления", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Открыть меню", exact: true }).click();
  await expect(page.locator(".sidebar")).toHaveClass(/open/);
  await page.getByRole("button", { name: "Закрыть меню", exact: true }).click();
  await page.locator(".bottom-nav").getByRole("button", { name: "Сегодня", exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.locator(".bottom-nav")).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({ path: ".data/qa/android-9x16.png", fullPage: false });
  const shiftId = await page.evaluate(async () => {
    const me = await (await fetch("/api/auth/me")).json();
    const from = me.server_now.slice(0, 10);
    const to = new Date(Date.parse(from) + 10 * 86400000).toISOString().slice(0, 10);
    const shifts = await (await fetch(`/api/me/shifts?from=${from}&to=${to}`)).json();
    return shifts.find((shift: any) => shift.comment === "Android exchange regression").id;
  });
  await page.evaluate((id) => { location.hash = `shift:${id}`; }, shiftId);
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Выставить на биржу" }).click();
  await expect(page.getByRole("status")).toContainText("Смена выставлена на биржу");
  await page.locator(".bottom-nav").getByRole("button", { name: "Сегодня", exact: true }).click();
  await page.evaluate((id) => { location.hash = `shift:${id}`; }, shiftId);
  await dialog.getByRole("button", { name: "Отозвать с биржи" }).click();
  await expect(page.getByRole("status")).toContainText("Объявление отозвано");
  await page
    .locator(".bottom-nav")
    .getByRole("button", { name: "Профиль", exact: true })
    .click();
  await page.getByRole("button", { name: /Сервер:/ }).click();
  await expect(
    page.getByRole("heading", { name: "Сервер вашей кофейни" }),
  ).toBeVisible();
  await expect(page.getByLabel("Адрес сервера RCS")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await context.close();
});

test("barista uploads an avatar that persists and appears in day and month calendars", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.context().addCookies([{
    name: "rcs_session", value: "native-layout-test-session",
    url: "http://127.0.0.1:3181", httpOnly: true, sameSite: "Strict",
  }]);
  await page.goto("/#profile");
  const image = await sharp({ create: { width: 120, height: 80, channels: 3, background: "#da7759" } }).png().toBuffer();
  await page.getByLabel("Фотография профиля").setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: image });
  await expect(page.locator(".profile-card > .avatar img")).toHaveAttribute("src", /^data:image\/webp;base64,/);
  await page.reload();
  await expect(page.locator(".profile-card > .avatar img")).toBeVisible();
  await page.locator(".bottom-nav").getByRole("button", { name: "График", exact: true }).click();
  await expect(page.locator('.person-cell img[alt="Аватар: Анна Смирнова"]')).toBeVisible();
  await page.getByRole("button", { name: "Месяц", exact: true }).click();
  await expect(page.locator('.chip-owner img[alt="Аватар: Анна Смирнова"]').first()).toBeVisible();
  await page.screenshot({ path: ".data/qa/avatar-in-calendar.png", fullPage: true });
  await page.locator(".bottom-nav").getByRole("button", { name: "Профиль", exact: true }).click();
  await page.getByRole("button", { name: "Удалить аватарку", exact: true }).click();
  await expect(page.locator(".profile-card > .avatar img")).toHaveCount(0);
});

test("admin edits employee login data and their own phone and password", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.context().addCookies([{
    name: "rcs_session", value: "admin-ui-test-session",
    url: "http://127.0.0.1:3181", httpOnly: true, sameSite: "Strict",
  }]);
  const response = await page.request.post("/api/employees", { headers: { "X-CSRF-Token": "admin-ui-test-csrf" }, data: {
    name: "Сброс доступа", phone: "+375299999992", role: "barista", rate: "10.00", pay_type: "hourly", password: "InitialFixture!2026",
  } });
  expect(response.ok()).toBe(true);
  await page.goto("/#employees");
  const card = page.locator(".employee-card").filter({ has: page.getByRole("heading", { name: "Сброс доступа", exact: true }) });
  await card.getByRole("button", { name: "Редактировать профиль" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Телефон", { exact: true }).fill("+375299999993");
  await dialog.getByLabel("Новый пароль", { exact: true }).fill("ResetBarista!2026");
  await dialog.getByLabel("Причина изменения", { exact: true }).fill("Смена телефона и сброс пароля");
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(card).toContainText("+375299999993");
  await page.getByRole("button", { name: "Открыть меню", exact: true }).click();
  await page.locator(".sidebar").getByRole("button", { name: "Настройки", exact: true }).click();
  await page.getByRole("button", { name: "Изменить телефон и пароль", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Номер телефона", { exact: true }).fill("+375299999991");
  await dialog.getByLabel("Новый пароль", { exact: true }).fill("AdminMobile!2026");
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Данные для входа обновлены");
  await expect(page.locator(".profile-card")).toContainText("+375299999991");
  const me = await page.request.get("/api/auth/me");
  expect(me.ok()).toBe(true);
  expect((await me.json()).user.phone).toBe("+375299999991");
});
