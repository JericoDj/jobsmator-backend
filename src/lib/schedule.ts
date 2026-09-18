import type { AutomationFrequency } from "@/contracts";

export type Cadence = { frequency: AutomationFrequency; hour: number; minute: number; weekday: number | null; tzOffsetMinutes: number };

/** Next time the cadence fires strictly after `after`, in the user's local wall clock, returned as UTC. */
export function nextRunAfter(c: Cadence, after = new Date()): Date {
  const off = c.tzOffsetMinutes * 60 * 1000;
  // Work in "local" time by shifting the epoch; Date's UTC getters then read as local.
  const local = new Date(after.getTime() + off);
  const candidate = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), c.hour, c.minute, 0, 0));
  for (let i = 0; i < 8; i++) {
    const day = candidate.getUTCDay();
    const okDay = c.frequency === "daily" || (c.frequency === "weekdays" ? day >= 1 && day <= 5 : day === (c.weekday ?? 1));
    if (okDay && candidate.getTime() > local.getTime()) return new Date(candidate.getTime() - off);
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return new Date(candidate.getTime() - off);
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Every day · 8:00", "Weekdays · 18:30", "Mondays · 9:00". */
export function scheduleLabel(c: Cadence): string {
  const time = `${c.hour}:${String(c.minute).padStart(2, "0")}`;
  const when = c.frequency === "daily" ? "Every day" : c.frequency === "weekdays" ? "Weekdays" : `${DAYS[c.weekday ?? 1]}s`;
  return `${when} · ${time}`;
}
