import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PushNotifications } from "@capacitor/push-notifications";
import { api } from "../web/api";
import { registerNativePushDevice } from "../web/native-push";

vi.mock("@capacitor/push-notifications", () => ({ PushNotifications: {
  checkPermissions: vi.fn(), requestPermissions: vi.fn(), createChannel: vi.fn(),
  addListener: vi.fn(), register: vi.fn(),
} }));
vi.mock("../web/api", () => ({ api: vi.fn() }));
const listeners = new Map<string, (event: any) => void>();
let values: Map<string, string>;
beforeEach(() => {
  vi.clearAllMocks(); listeners.clear(); values = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  vi.mocked(PushNotifications.checkPermissions).mockResolvedValue({ receive: "granted" });
  vi.mocked(PushNotifications.requestPermissions).mockResolvedValue({ receive: "granted" });
  vi.mocked(PushNotifications.createChannel).mockResolvedValue();
  vi.mocked(PushNotifications.addListener).mockImplementation(async (name: any, callback: any) => {
    listeners.set(name, callback);
    return { remove: async () => { listeners.delete(name); } };
  });
  vi.mocked(PushNotifications.register).mockImplementation(async () => { listeners.get("registration")?.({ value: "refreshed-native-device-token" }); });
  vi.mocked(api).mockResolvedValue({ id: "device-id" });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("Android push registration", () => {
  it("registers with the current user and cleans listeners after success", async () => {
    await expect(registerNativePushDevice("user-a", true)).resolves.toEqual({ id: "device-id" });
    expect(api).toHaveBeenCalledWith("/me/push-devices", "POST", { platform: "android", token: "refreshed-native-device-token", user_id: "user-a" });
    expect(values.get("rcs-push-user")).toBe("user-a");
    expect(values.get("rcs-push-device")).toBe("device-id");
    expect(listeners.size).toBe(0);
  });
  it("requests permission after rationale only on an explicit connect", async () => {
    vi.mocked(PushNotifications.checkPermissions).mockResolvedValue({ receive: "prompt-with-rationale" });
    expect(await registerNativePushDevice("user-a")).toBeNull();
    expect(PushNotifications.requestPermissions).not.toHaveBeenCalled();
    await registerNativePushDevice("user-a", true);
    expect(PushNotifications.requestPermissions).toHaveBeenCalledTimes(1);
  });
  it("refreshes approved tokens once when several views request it simultaneously", async () => {
    values.set("rcs-push-user", "user-a");
    const first = registerNativePushDevice("user-a"), second = registerNativePushDevice("user-a");
    expect(first).toBe(second);
    await first;
    expect(PushNotifications.register).toHaveBeenCalledTimes(1);
    expect(PushNotifications.requestPermissions).not.toHaveBeenCalled();
  });
  it("does not register a token when the user logs out while waiting for Firebase", async () => {
    values.set("rcs-push-user", "user-a");
    vi.mocked(PushNotifications.register).mockImplementation(async () => {
      values.delete("rcs-push-user"); listeners.get("registration")?.({ value: "late-token" });
    });
    expect(await registerNativePushDevice("user-a")).toBeNull();
    expect(api).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });
  it("cleans up a new server subscription if approval is revoked during registration", async () => {
    values.set("rcs-push-user", "user-a");
    vi.mocked(api).mockImplementation(async () => { values.delete("rcs-push-user"); return { id: "device-id" }; });
    expect(await registerNativePushDevice("user-a")).toBeNull();
    expect(api).toHaveBeenLastCalledWith("/me/push-devices", "DELETE", { id: "device-id" });
    expect(values.has("rcs-push-device")).toBe(false);
  });
  it("removes all listeners after native registration fails", async () => {
    vi.mocked(PushNotifications.register).mockImplementation(async () => { listeners.get("registrationError")?.({ error: "provider failure" }); });
    await expect(registerNativePushDevice("user-a", true)).rejects.toThrow("Не удалось подключить уведомления Android");
    expect(listeners.size).toBe(0);
    expect(api).not.toHaveBeenCalled();
  });
  it("times out and releases listeners if Firebase never returns a token", async () => {
    vi.useFakeTimers();
    vi.mocked(PushNotifications.register).mockResolvedValue();
    const pending = expect(registerNativePushDevice("user-a", true)).rejects.toThrow("Не удалось получить подписку");
    await vi.advanceTimersByTimeAsync(20001);
    await pending;
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
