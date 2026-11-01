import { cacheClear } from "./api";
import { clearNativeCookies, DEFAULT_SERVER, LEGACY_LAN_SERVER, serverBase, validateServer } from "./runtime";

export async function switchNativeServer(address: string) {
  const url = validateServer(address);
  if (url !== serverBase()) {
    await cacheClear();
    await clearNativeCookies();
    sessionStorage.removeItem("rcs-user");
    localStorage.removeItem("rcs-push-device");
    localStorage.removeItem("rcs-push-user");
  }
  localStorage.setItem("rcs-server", url);
  return url;
}

export async function prepareNativeServer() {
  const current = serverBase();
  // Only the original development server moves automatically; custom servers stay selected.
  if (current === LEGACY_LAN_SERVER && DEFAULT_SERVER.startsWith("https://"))
    return switchNativeServer(DEFAULT_SERVER);
  return current;
}
