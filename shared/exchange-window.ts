const minskHour = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Minsk", hour: "2-digit", hourCycle: "h23" });
export function canTakeExchangeAt(date: Date) {
  const hour = Number(minskHour.format(date));
  return hour >= 10 && hour < 19;
}
