import { nativeApp, nativeRequest } from "./runtime";
let csrf = "";
export function setCsrf(value: string) {
  csrf = value;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T = any>(
  path: string,
  method = "GET",
  body?: unknown,
  key?: string,
): Promise<T> {
  const headers = {
    ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(csrf ? { "X-CSRF-Token": csrf } : {}),
    ...(key ? { "Idempotency-Key": key } : {}),
  };
  if (nativeApp) {
    const response = await nativeRequest(path, method, headers, body);
    if (response.status < 200 || response.status >= 300)
      throw new ApiError(
        response.status,
        response.data?.code ?? "REQUEST_ERROR",
        response.data?.message ?? "Не удалось выполнить запрос",
      );
    return response.data as T;
  }
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok)
    throw new ApiError(
      response.status,
      result.code,
      result.message ?? "Не удалось выполнить запрос",
    );
  return result;
}
export async function cacheWrite(id: string, value: unknown) {
  const db = await openCache();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("snapshots", "readwrite");
      tx.objectStore("snapshots").put(value, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
export async function cacheRead(id: string) {
  const db = await openCache();
  try {
    return await new Promise<any>((resolve, reject) => {
      const tx = db.transaction("snapshots");
      const req = tx.objectStore("snapshots").get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}
export async function cacheClear() {
  const db = await openCache();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("snapshots", "readwrite");
      tx.objectStore("snapshots").clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
function openCache() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open("rcs-private", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("snapshots");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
