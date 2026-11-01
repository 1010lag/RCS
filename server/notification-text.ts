// Only notification copy is localized; API date fields keep ISO format.
export function notificationText(text: string) {
  return text.replace(/(?<![\w/\-])\d{4}-\d{2}-\d{2}(?![\w/\-])/g, (date) => {
    const value = new Date(`${date}T00:00:00Z`);
    if (!Number.isFinite(value.getTime()) || value.toISOString().slice(0, 10) !== date) return date;
    const [year, month, day] = date.split("-");
    return `${day}.${month}.${year}`;
  });
}
