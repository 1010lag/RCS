type TelegramWebApp = {
  initData: string;
  ready(): void;
  expand(): void;
  openTelegramLink(url: string): void;
  BackButton: { show(): void; hide(): void; onClick(fn: () => void): void; offClick(fn: () => void): void };
};
declare global { interface Window { Telegram?: { WebApp?: TelegramWebApp } } }
export const telegramApp = () => window.Telegram?.WebApp?.initData ? window.Telegram.WebApp : null;
let loading: Promise<void> | null = null;
export function initializeTelegram() {
  if (loading) return loading;
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.has("tgWebAppData") && !window.Telegram?.WebApp) return Promise.resolve();
  loading = new Promise<void>(resolve => {
    const finish = () => {
      const app = telegramApp();
      if (app) {
        app.ready(); app.expand();
        document.documentElement.classList.add("telegram-app");
        // Telegram launch data must not become an application navigation hash.
        const query = new URLSearchParams(location.search), target = query.get("tg_target") ?? "home";
        if (new URLSearchParams(location.hash.slice(1)).has("tgWebAppData")) {
          query.delete("tg_target");
          const search = query.size ? `?${query}` : "";
          const view = /^(shift:[a-f0-9-]+|home|schedule|exchange|recipes|payroll|notifications|profile)$/.test(target) ? target : "home";
          history.replaceState(null, "", `${location.pathname}${search}#${view}`);
        }
        const back = () => { location.hash = "home"; };
        const updateBack = () => location.hash && location.hash !== "#home" ? app.BackButton.show() : app.BackButton.hide();
        app.BackButton.onClick(back);
        window.addEventListener("hashchange", updateBack);
        updateBack();
      }
      resolve();
    };
    if (window.Telegram?.WebApp) { finish(); return; }
    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-web-app.js";
    script.onload = finish;
    script.onerror = () => resolve();
    document.head.append(script);
    setTimeout(resolve, 5000);
  });
  return loading;
}
export function openTelegram(url: string) {
  const app = telegramApp();
  if (app) app.openTelegramLink(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}
