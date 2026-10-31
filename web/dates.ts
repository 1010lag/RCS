export const minskDate = (value: Date | string = new Date()) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Minsk",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
export const addDays = (date: string, n: number) =>
  new Date(Date.parse(date) + n * 86400000).toISOString().slice(0, 10);
export const weekStart = (date: string) =>
  addDays(date, -((new Date(date).getUTCDay() + 6) % 7));
export const monthStart = (date: string) => date.slice(0, 7) + "-01";
export const monthEnd = (date: string) => {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
    .toISOString()
    .slice(0, 10);
};
export const moveMonth = (date: string, n: number) => {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1))
    .toISOString()
    .slice(0, 10);
};
export const label = (
  date: string,
  options: Intl.DateTimeFormatOptions = { day: "numeric", month: "long" },
) =>
  new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", ...options }).format(
    new Date(date),
  );
export const currency = (n: string | number) =>
  new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(n)) + " Br";
export const hours = (minutes: number) =>
  new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(
    minutes / 60,
  );
export const stamp = (date: string) =>
  new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Minsk",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));
export const initials = (name: string) =>
  name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("");
