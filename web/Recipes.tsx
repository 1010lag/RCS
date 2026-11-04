import { useEffect, useId, useRef, useState } from "react";
import { BookOpen, Coffee, Plus, Trash2, X } from "lucide-react";
import { recipeMethods, type Recipe, type RecipeMethod } from "../shared/types";
import { Field, Form } from "./App";
import { api } from "./api";
import "./recipes.css";

const methods = Object.entries(recipeMethods) as [RecipeMethod, string][];
const parameters = [
  ["coffee", "Кофе", "15 г"], ["water", "Вода", "250 мл"],
  ["temperature", "Температура", "93 °C"], ["grind", "Помол", "Средний"],
  ["brew_time", "Время", "2:30"],
] as const;
type Dialog = { kind: "add" } | { kind: "read" | "delete"; recipe: Recipe };

export function Recipes({ recipes, offline, onChanged, report }: {
  recipes: Recipe[]; offline: boolean; onChanged: () => Promise<void>; report: (text: string) => void;
}) {
  const [method, setMethod] = useState<RecipeMethod>("aeropress"),
    [dialog, setDialog] = useState<Dialog | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const ref = useRef<HTMLDialogElement>(null), submitting = useRef(false), id = useId();
  const filtered = recipes.filter(recipe => recipe.method === method);
  const open = (value: Dialog) => { setError(""); setDialog(value); };
  const close = () => { if (!submitting.current) { setDialog(null); setError(""); } };
  useEffect(() => {
    const element = ref.current;
    if (!dialog || !element) return;
    element.showModal();
    return () => element.close();
  }, [Boolean(dialog)]);
  async function mutate(action: () => Promise<unknown>, message: string) {
    if (submitting.current || offline) return;
    submitting.current = true; setBusy(true); setError("");
    try {
      await action();
      setDialog(null); report(message);
      await onChanged();
    } catch (e: any) { setError(e.message ?? "Не удалось сохранить рецепт"); }
    finally { submitting.current = false; setBusy(false); }
  }
  const selected = dialog && dialog.kind !== "add" ? dialog.recipe : null;
  const title = dialog?.kind === "add" ? "Добавить рецепт" : dialog?.kind === "delete" ? "Удалить рецепт?" : selected?.title;
  return <section className="recipes" aria-label="Рецепты альтернативы">
    <div className="recipes-toolbar">
      <div className="recipe-tabs" role="tablist" aria-label="Способ приготовления">
        {methods.map(([key, name], index) => <button key={key} type="button" role="tab"
          id={`${id}-${key}`} aria-selected={method === key} aria-controls={`${id}-panel`} tabIndex={method === key ? 0 : -1}
          onClick={() => setMethod(key)} onKeyDown={event => {
            const next = event.key === "ArrowRight" ? (index + 1) % methods.length : event.key === "ArrowLeft" ? (index + methods.length - 1) % methods.length : event.key === "Home" ? 0 : event.key === "End" ? methods.length - 1 : null;
            if (next === null) return;
            event.preventDefault(); setMethod(methods[next][0]);
            document.getElementById(`${id}-${methods[next][0]}`)?.focus();
          }}>{name}</button>)}
      </div>
      <button className="btn primary recipe-add-button" disabled={offline || busy} onClick={() => open({ kind: "add" })}><Plus size={17} />Добавить рецепт</button>
    </div>
    <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${method}`}>
      <div className="recipe-section-heading"><span>{recipeMethods[method]}</span><span className="muted">Рецептов: {filtered.length}</span></div>
      <div className="recipe-grid">
        {filtered.map(recipe => <article className="recipe-card" key={recipe.id}>
          <div className="recipe-card-heading">
            <span className="recipe-method-icon"><Coffee size={18} /></span>
            <button className="icon-btn recipe-delete" aria-label={`Удалить рецепт «${recipe.title}»`} disabled={offline || busy} onClick={() => open({ kind: "delete", recipe })}><Trash2 size={16} /></button>
          </div>
          <button className="recipe-open" onClick={() => open({ kind: "read", recipe })} aria-label={`Открыть рецепт «${recipe.title}»`}>
            <h2>{recipe.title}</h2>
            <dl className="recipe-parameters">{parameters.filter(([key]) => recipe[key]).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{recipe[key]}</dd></div>)}</dl>
            <p className="recipe-preview">{recipe.instructions}</p>
            <span className="recipe-read-more">Открыть рецепт <span aria-hidden="true">↗</span></span>
          </button>
          <p className="recipe-author">Добавил(а): {recipe.author_name}</p>
        </article>)}
        <button className="recipe-add-card" disabled={offline || busy} onClick={() => open({ kind: "add" })} aria-label={`Добавить рецепт: ${recipeMethods[method]}`}>
          <span><Plus size={24} /></span><strong>Новый рецепт</strong><small>Поделитесь своим способом приготовления</small>
        </button>
      </div>
      {filtered.length === 0 && <p className="recipe-empty"><BookOpen size={16} />Здесь пока нет рецептов. Первый может стать вашим.</p>}
    </div>
    {dialog && <dialog className="modal recipe-modal" ref={ref} aria-labelledby={`${id}-dialog-title`}
      onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <div className="modal-inner">
        <div className="modal-heading"><h2 id={`${id}-dialog-title`}>{title}</h2><button className="icon-btn" aria-label="Закрыть диалог" disabled={busy} onClick={close}><X size={20} /></button></div>
        {error && <div className="error" role="alert">{error}</div>}
        {dialog.kind === "add" && <Form onSubmit={body => mutate(() => api("/recipes", "POST", { ...body, method }), "Рецепт добавлен для всей команды")}>
          <p className="recipe-form-method">{recipeMethods[method]} · Общая коллекция команды</p>
          <fieldset disabled={busy || offline}>
            <Field label="Название рецепта"><input name="title" placeholder="Например, утренний V60" required maxLength={120} /></Field>
            <div className="recipe-form-parameters">{parameters.map(([key, label, placeholder]) => <Field label={label} key={key}><input name={key} placeholder={placeholder} maxLength={80} /></Field>)}</div>
            <Field label="Приготовление" hint="Опишите шаги, интервалы вливаний и особенности рецепта."><textarea name="instructions" required rows={7} maxLength={8000} placeholder={"1. Подготовьте фильтр и прогрейте посуду.\n2. Добавьте кофе…"} /></Field>
          </fieldset>
          <div className="modal-footer"><button type="button" className="btn" disabled={busy} onClick={close}>Отмена</button><button type="submit" className="btn primary" disabled={busy || offline}>{busy ? "Сохраняем…" : "Сохранить рецепт"}</button></div>
        </Form>}
        {dialog.kind === "read" && selected && <>
          <span className="tag neutral">{recipeMethods[selected.method]}</span>
          <dl className="recipe-detail-parameters">{parameters.filter(([key]) => selected[key]).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{selected[key]}</dd></div>)}</dl>
          <h3 className="recipe-steps-heading">Приготовление</h3><p className="recipe-instructions">{selected.instructions}</p>
          <p className="recipe-author">Добавил(а): {selected.author_name}</p>
          <div className="modal-footer"><button className="btn" disabled={offline || busy} onClick={() => open({ kind: "delete", recipe: selected })}><Trash2 size={16} />Удалить рецепт</button><button className="btn primary" onClick={close}>Закрыть</button></div>
        </>}
        {dialog.kind === "delete" && selected && <>
          <p className="recipe-delete-copy">Удалить «{selected.title}»? Рецепт исчезнет из общей коллекции у всей команды.</p>
          <div className="modal-footer"><button className="btn" disabled={busy} onClick={close}>Отмена</button><button className="btn primary" disabled={busy || offline} onClick={() => void mutate(() => api(`/recipes/${selected.id}`, "DELETE"), "Рецепт удалён")}><Trash2 size={16} />{busy ? "Удаляем…" : "Удалить рецепт"}</button></div>
        </>}
      </div>
    </dialog>}
  </section>;
}
