export type SalesRangePreset = "last_7_days" | "last_30_days" | "this_month" | "last_month" | "custom";

export interface SalesDateRange {
  preset: SalesRangePreset;
  current: { from: string; to: string };
  previous: { from: string; to: string };
  label: string;
  previousLabel: string;
}

type SearchValue = string | string[] | undefined;

function readValue(value: SearchValue): string | null {
  return typeof value === "string" ? value : null;
}

function isDate(value: string | null): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()));
}

function dateAtStart(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

function dateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addDays(value: string, days: number): string {
  const date = dateAtStart(value);
  date.setUTCDate(date.getUTCDate() + days);
  return dateString(date);
}

function indiaToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((value) => value.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function monthStart(value: string): string {
  return `${value.slice(0, 7)}-01`;
}

function previousMonthRange(today: string): { from: string; to: string } {
  const currentMonthStart = monthStart(today);
  const to = addDays(currentMonthStart, -1);
  return { from: monthStart(to), to };
}

function rangeLength(from: string, to: string): number {
  return Math.floor((dateAtStart(to).getTime() - dateAtStart(from).getTime()) / 86_400_000) + 1;
}

function labelFor(from: string, to: string): string {
  const formatter = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return from === to ? formatter.format(dateAtStart(from)) : `${formatter.format(dateAtStart(from))} - ${formatter.format(dateAtStart(to))}`;
}

export function resolveSalesDateRange(searchParams: Record<string, SearchValue>): SalesDateRange {
  const today = indiaToday();
  const requestedPreset = readValue(searchParams.range);
  const preset: SalesRangePreset = requestedPreset === "last_7_days" || requestedPreset === "this_month" || requestedPreset === "last_month" || requestedPreset === "custom"
    ? requestedPreset
    : "last_30_days";
  let current: { from: string; to: string };
  if (preset === "last_7_days") current = { from: addDays(today, -6), to: today };
  else if (preset === "this_month") current = { from: monthStart(today), to: today };
  else if (preset === "last_month") current = previousMonthRange(today);
  else if (preset === "custom" && isDate(readValue(searchParams.from)) && isDate(readValue(searchParams.to)) && readValue(searchParams.from)! <= readValue(searchParams.to)!) {
    const from = readValue(searchParams.from)!;
    const to = readValue(searchParams.to)!;
    current = rangeLength(from, to) <= 60 ? { from, to } : { from: addDays(to, -59), to };
  } else current = { from: addDays(today, -29), to: today };

  const days = rangeLength(current.from, current.to);
  const previous = { to: addDays(current.from, -1), from: addDays(current.from, -days) };
  return { preset, current, previous, label: labelFor(current.from, current.to), previousLabel: labelFor(previous.from, previous.to) };
}
