import { useSyncExternalStore } from "react";
import { App as NativeApp } from "@capacitor/app";
import { SystemBars, SystemBarsStyle } from "@capacitor/core";
import { nativeApp } from "./runtime";

export type Theme = "light" | "dark";
const key = "rcs-theme";
const listeners = new Set<() => void>();
function savedTheme(): Theme {
  try { return localStorage.getItem(key) === "dark" ? "dark" : "light"; }
  catch { return "light"; }
}
let theme = savedTheme();
function syncAppearance() {
  document.documentElement.dataset.theme = theme;
  const color = theme === "dark" ? "#18181c" : "#ffffff";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);
  if (nativeApp) {
    void SystemBars.setStyle({ style: theme === "dark" ? SystemBarsStyle.Dark : SystemBarsStyle.Light }).catch(() => {});
  }
}
export function initializeTheme() {
  syncAppearance();
  window.addEventListener("storage", (event) => {
    if (event.key === key || event.key === null) {
      theme = savedTheme();
      syncAppearance();
      listeners.forEach((notify) => notify());
    }
  });
  if (nativeApp) {
    void NativeApp.addListener("appStateChange", ({ isActive }) => {
      if (isActive) syncAppearance();
    });
  }
}
export function setTheme(value: Theme) {
  try { localStorage.setItem(key, value); } catch { /* Keep working in this session. */ }
  theme = value;
  syncAppearance();
  listeners.forEach((notify) => notify());
}
export function useTheme() {
  return useSyncExternalStore((notify) => {
    listeners.add(notify);
    return () => { listeners.delete(notify); };
  }, () => theme);
}
