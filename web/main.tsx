import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { nativeApp } from "./runtime";
import { NativeShell } from "./NativeShell";
import "./styles.css";
import "./theme.css";
import { initializeTheme } from "./theme";
initializeTheme();
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {nativeApp ? (
      <NativeShell>
        <App />
      </NativeShell>
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
if (!nativeApp && "serviceWorker" in navigator)
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
if (nativeApp) {
  document.documentElement.classList.add("native-app");
  if (import.meta.env.VITE_NATIVE_FIREBASE_CONFIGURED === "true")
    void import("@capacitor/push-notifications").then(({ PushNotifications }) =>
      PushNotifications.addListener(
        "pushNotificationActionPerformed",
        (event) => {
          const link = event.notification.data?.link;
          window.location.hash =
            typeof link === "string" &&
            /^(shift:[a-f0-9-]+|home|schedule|exchange|payroll|notifications|profile)$/.test(
              link,
            )
              ? link
              : "notifications";
        },
      ),
    );
}
