import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, it, expect } from "vitest";

async function worker() {
  const listeners = new Map<string, Function>(),
    shown: any[] = [];
  let navigated = "";
  const self = {
    addEventListener: (name: string, fn: Function) => listeners.set(name, fn),
    skipWaiting: () => {},
    registration: {
      showNotification: async (title: string, options: any) => {
        shown.push({ title, ...options });
      },
    },
    clients: {
      claim: async () => {},
      matchAll: async () => [
        {
          navigate: async (url: string) => {
            navigated = url;
          },
          focus: async () => {},
        },
      ],
      openWindow: async (url: string) => {
        navigated = url;
      },
    },
  };
  runInNewContext(
    await readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    { self, URL, location: { origin: "https://rcs.example.com" } },
  );
  return {
    listeners,
    shown,
    get navigated() {
      return navigated;
    },
  };
}
describe("Browser push service worker", () => {
  it("displays a data-only FCM payload once with a stable notification tag", async () => {
    const w = await worker(),
      pending: Promise<any>[] = [];
    w.listeners.get("push")!({
      data: {
        json: () => ({
          data: {
            title: "Новая смена",
            body: "Завтра в 08:00",
            link: "schedule",
            notification_id: "notice-123",
          },
        }),
      },
      waitUntil: (p: Promise<any>) => pending.push(p),
    });
    await Promise.all(pending);
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0]).toMatchObject({
      title: "Новая смена",
      body: "Завтра в 08:00",
      tag: "notice-123",
      data: { link: "schedule" },
    });
  });
  it("never navigates notification clicks to an untrusted external URL", async () => {
    const w = await worker(),
      pending: Promise<any>[] = [];
    w.listeners.get("notificationclick")!({
      notification: {
        close: () => {},
        data: { link: "https://attacker.example" },
      },
      waitUntil: (p: Promise<any>) => pending.push(p),
    });
    await Promise.all(pending);
    expect(w.navigated).toBe("https://rcs.example.com/#notifications");
  });
});
