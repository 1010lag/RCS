import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapacitorCookies } from "@capacitor/core";
import { cacheClear } from "../web/api";
import { prepareNativeServer, switchNativeServer } from "../web/native-server";
import { DEFAULT_SERVER, LEGACY_LAN_SERVER, serverBase } from "../web/runtime";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
  CapacitorHttp: {},
  CapacitorCookies: { clearAllCookies: vi.fn(async () => {}) },
}));
vi.mock("../web/api", () => ({ cacheClear: vi.fn(async () => {}) }));
let local: Map<string, string>, session: Map<string, string>;
const storage = (values: Map<string, string>) => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
beforeEach(() => {
  vi.clearAllMocks();
  local = new Map([["rcs-push-user", "old-user"], ["rcs-push-device", "old-device"], ["rcs-theme", "dark"]]);
  session = new Map([["rcs-user", "old-account"]]);
  vi.stubGlobal("localStorage", storage(local));
  vi.stubGlobal("sessionStorage", storage(session));
});
afterEach(() => vi.unstubAllGlobals());
describe("Public Android server", () => {
  it("starts a new installation on the public HTTPS server", async () => {
    expect(await prepareNativeServer()).toBe("https://rcs-team-1010lag.onrender.com");
    expect(cacheClear).not.toHaveBeenCalled();
  });
  it("moves the original LAN installation and clears credentials and private cached data", async () => {
    local.set("rcs-server", LEGACY_LAN_SERVER);
    expect(await prepareNativeServer()).toBe(DEFAULT_SERVER);
    expect(serverBase()).toBe(DEFAULT_SERVER);
    expect(cacheClear).toHaveBeenCalledOnce();
    expect(CapacitorCookies.clearAllCookies).toHaveBeenCalledOnce();
    expect(session.has("rcs-user")).toBe(false);
    expect(local.has("rcs-push-user")).toBe(false);
    expect(local.has("rcs-push-device")).toBe(false);
    expect(local.get("rcs-theme")).toBe("dark");
  });
  it("preserves a custom server and its session", async () => {
    local.set("rcs-server", "https://another.example.com");
    expect(await prepareNativeServer()).toBe("https://another.example.com");
    expect(cacheClear).not.toHaveBeenCalled();
    expect(session.get("rcs-user")).toBe("old-account");
  });
  it("does not switch servers when private-data cleanup fails", async () => {
    local.set("rcs-server", LEGACY_LAN_SERVER);
    vi.mocked(CapacitorCookies.clearAllCookies).mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(switchNativeServer(DEFAULT_SERVER)).rejects.toThrow("cleanup failed");
    expect(serverBase()).toBe(LEGACY_LAN_SERVER);
  });
});
