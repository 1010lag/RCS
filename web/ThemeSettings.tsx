import { Sun, Moon, Check } from "lucide-react";
import { setTheme, useTheme } from "./theme";

export function ThemeSettings() {
  const theme = useTheme();
  return (
    <section className="theme-settings" aria-labelledby="theme-title">
      <h2 id="theme-title">Тема оформления</h2>
      <p className="muted">Выберите, как выглядит RCS на этом устройстве.</p>
      <div className="theme-options" role="group" aria-label="Тема оформления">
        {(["light", "dark"] as const).map((value) => {
          const Icon = value === "light" ? Sun : Moon;
          return (
            <button key={value} type="button" className={`theme-option ${theme === value ? "selected" : ""}`} aria-pressed={theme === value} onClick={() => setTheme(value)}>
              <span className={`theme-preview ${value}`} aria-hidden="true"><span /><i /><b /></span>
              <span className="theme-option-label"><Icon size={17} />{value === "light" ? "Светлая" : "Тёмная"}{theme === value && <Check size={17} className="theme-check" />}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
