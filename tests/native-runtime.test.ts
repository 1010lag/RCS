import { describe, it, expect, vi } from "vitest";
import { CapacitorHttp } from "@capacitor/core";
import { validateServer, nativeRequest } from "../web/runtime";

vi.mock("@capacitor/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@capacitor/core")>();
  return {
    ...actual,
    Capacitor: { ...actual.Capacitor, isNativePlatform: () => true },
    CapacitorHttp: { request: vi.fn() },
  };
});

describe("Android HTTP requests", () => {
  it("sends explicit JSON for bodyless actions without losing CSRF or retry keys", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "http://192.168.1.7:3001" });
    const request = vi.mocked(CapacitorHttp.request).mockResolvedValue({
      status: 200, data: {}, headers: {}, url: "http://192.168.1.7:3001",
    });
    try {
      for (const method of ["POST", "DELETE", "PATCH", "PUT"]) {
        await nativeRequest("/example", method, { "X-CSRF-Token": "csrf", "Idempotency-Key": "retry" });
        expect(request).toHaveBeenLastCalledWith(expect.objectContaining({
          method, data: {}, headers: { "Content-Type": "application/json", "X-CSRF-Token": "csrf", "Idempotency-Key": "retry" },
        }));
      }
      await nativeRequest("/example", "GET", {});
      expect(request.mock.calls.at(-1)![0]).not.toHaveProperty("data");
      const payload = { reason: "Отмена смены" };
      await nativeRequest("/example", "POST", { "Content-Type": "application/json" }, payload);
      expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ data: payload }));
    } finally {
      request.mockReset();
      vi.unstubAllGlobals();
    }
  });
});
describe("Android server selection", () => {
  it("supports a LAN server for phone testing and HTTPS for a hosted server", () => {
    expect(validateServer("http://192.168.1.7:3001")).toBe(
      "http://192.168.1.7:3001",
    );
    expect(validateServer(" https://rcs.example.com/ ")).toBe(
      "https://rcs.example.com",
    );
  });
  it("rejects insecure public hosts and private-host lookalikes", () => {
    for (const host of [
      "http://rcs.example.com",
      "http://localhost.attacker.example",
      "http://192.168.attacker.example",
      "http://172.32.0.1",
    ])
      expect(() => validateServer(host)).toThrow();
  });
  it("rejects embedded credentials and ambiguous paths", () => {
    for (const host of [
      "https://user:password@rcs.example.com",
      "https://rcs.example.com/other",
      "https://rcs.example.com?server=another",
      "javascript:alert(1)",
    ])
      expect(() => validateServer(host)).toThrow();
  });
});
