const minskHour = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Minsk", hour: "2-digit", hourCycle: "h23" });
export function canTakeExchangeAt(date: Date) {
  const hour = Number(minskHour.format(date));
  return hour >= 10 && hour < 19;
}

// Last daily trading window before the shift. Minsk has a fixed UTC+3 offset.
export function exchangeDeadline(start: Date | string): Date {
  const instant = new Date(start);
  const local = new Date(instant.getTime() + 3 * 3600000);
  if (local.getUTCHours() < 10 || (local.getUTCHours() === 10 && local.getUTCMinutes() === 0 && local.getUTCSeconds() === 0)) {
    local.setUTCDate(local.getUTCDate() - 1);
    local.setUTCHours(19, 0, 0, 0);
  } else if (local.getUTCHours() >= 19) {
    local.setUTCHours(19, 0, 0, 0);
  }
  return new Date(local.getTime() - 3 * 3600000);
}
