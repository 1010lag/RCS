import { Capacitor, CapacitorHttp, CapacitorCookies } from "@capacitor/core";
export const nativeApp = Capacitor.isNativePlatform();
export function validateServer(value: string) {
  const url = new URL(value.trim());
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Укажите адрес сервера, например https://rcs.example.com");
  const octets = url.hostname.split(".").map(Number),
    privateIp =
      octets.length === 4 &&
      octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
      (octets[0] === 127 ||
        octets[0] === 10 ||
        (octets[0] === 192 && octets[1] === 168) ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31));
  if (url.protocol === "http:" && url.hostname !== "localhost" && !privateIp)
    throw new Error("Для публичного сервера используйте HTTPS");
  return url.origin;
}
export function serverBase() {
  return nativeApp
    ? (localStorage.getItem("rcs-server") ??
        import.meta.env.VITE_API_URL ??
        "http://192.168.1.7:3001")
    : "";
}
export async function nativeRequest(
  path: string,
  method: string,
  headers: Record<string, string>,
  body?: unknown,
) {
  // Explicit JSON avoids Android assigning a form content type to empty actions.
  const emptyAction = body === undefined && /^(POST|PUT|PATCH|DELETE)$/i.test(method);
  return CapacitorHttp.request({
    url: serverBase() + "/api" + path,
    method,
    headers: emptyAction ? { ...headers, "Content-Type": "application/json" } : headers,
    ...(emptyAction ? { data: {} } : body === undefined ? {} : { data: body }),
    responseType: "json",
    connectTimeout: 10000,
    readTimeout: 15000,
  });
}
export async function checkServer(address: string) {
  const response = await CapacitorHttp.get({
    url: validateServer(address) + "/api/health",
    connectTimeout: 6000,
    readTimeout: 6000,
    responseType: "json",
  });
  if (response.status !== 200 || !response.data?.ok)
    throw new Error("По этому адресу сервер RCS не отвечает");
}
export async function clearNativeCookies() {
  await CapacitorCookies.clearAllCookies();
}
