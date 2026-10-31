import type { CapacitorConfig } from "@capacitor/cli";
const config: CapacitorConfig = {
  appId: "by.rcs.app",
  appName: "RCS",
  webDir: "dist",
  server: { androidScheme: "https", cleartext: true },
  android: { allowMixedContent: true, backgroundColor: "#f7f7f8" },
  plugins: {
    CapacitorHttp: { enabled: false },
    SystemBars: {
      insetsHandling: "native",
      initialViewportFitValueHint: "cover",
      style: "LIGHT",
    },
    PushNotifications: { presentationOptions: ["badge", "sound", "alert"] },
  },
};
export default config;
