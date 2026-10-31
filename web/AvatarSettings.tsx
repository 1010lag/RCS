import { useRef, useState } from "react";
import { Camera, Trash2 } from "lucide-react";
import type { User } from "../shared/types";
import { api } from "./api";

async function photoData(file: File) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("Выберите фотографию JPG, PNG или WebP");
  if (file.size > 20 * 1024 * 1024) throw new Error("Выберите фотографию размером до 20 МБ");
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const edge = Math.min(bitmap.width, bitmap.height);
    canvas.getContext("2d")!.drawImage(bitmap, (bitmap.width - edge) / 2, (bitmap.height - edge) / 2, edge, edge, 0, 0, 256, 256);
    return canvas.toDataURL("image/webp", 0.85);
  } finally { bitmap.close(); }
}
export function AvatarSettings({ user, offline, saved }: { user: User; offline: boolean; saved: (user: User) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function update(file: File | null) {
    setBusy(true); setError("");
    try {
      const image = file ? await photoData(file) : null;
      saved(await api<User>("/me/avatar", "PUT", { image }));
    } catch (error: any) { setError(error.message ?? "Не удалось загрузить аватарку"); }
    finally { setBusy(false); }
  }
  return (
    <div className="avatar-settings">
      <input ref={input} type="file" hidden aria-label="Фотография профиля" accept="image/jpeg,image/png,image/webp" onChange={(event) => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
        if (file) void update(file);
      }} />
      <button type="button" className="btn full" disabled={busy || offline} onClick={() => input.current?.click()}><Camera size={16} />{busy ? "Сохраняем…" : user.avatar_url ? "Изменить аватарку" : "Добавить аватарку"}</button>
      {user.avatar_url && <button type="button" className="text-link danger" disabled={busy || offline} onClick={() => void update(null)}><Trash2 size={14} />Удалить аватарку</button>}
      <p className="muted small">Фотография будет видна команде в графике смен.</p>
      {error && <div className="error" role="alert">{error}</div>}
    </div>
  );
}
