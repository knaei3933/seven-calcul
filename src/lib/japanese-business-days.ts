export type ScheduleMilestoneStatus = "waiting" | "due_today" | "overdue" | "complete";

export interface ScheduleMilestone {
  dueDate: string;
  status: ScheduleMilestoneStatus;
  overdueDays: number;
}

export interface ShipmentSchedule {
  provisional: ScheduleMilestone;
  confirmed: ScheduleMilestone;
  arrivalEstimateDate: string | null;
  reminderKind: "provisional" | "confirmed" | null;
}

const JAPANESE_HOLIDAYS = new Set<string>([
  // 2025
  "2025-01-01","2025-01-13","2025-02-11","2025-02-23","2025-02-24","2025-03-20","2025-04-29",
  "2025-05-03","2025-05-04","2025-05-05","2025-05-06","2025-07-21","2025-08-11","2025-09-15",
  "2025-09-23","2025-10-13","2025-11-03","2025-11-23","2025-12-31",
  // 2026
  "2026-01-01","2026-01-12","2026-02-11","2026-02-23","2026-03-20","2026-04-29","2026-05-03",
  "2026-05-04","2026-05-05","2026-05-06","2026-07-20","2026-08-11","2026-09-21","2026-09-22",
  "2026-10-12","2026-11-03","2026-11-23","2026-12-31",
  // 2027
  "2027-01-01","2027-01-11","2027-02-11","2027-02-23","2027-03-22","2027-04-29","2027-05-03",
  "2027-05-04","2027-05-05","2027-05-06","2027-07-19","2027-08-11","2027-09-20","2027-09-23",
  "2027-10-11","2027-11-03","2027-11-23","2027-12-31",
]);

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dateOf(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

export function isJapaneseBusinessDay(value: string): boolean {
  const day = dateOf(value).getUTCDay();
  return day !== 0 && day !== 6 && !JAPANESE_HOLIDAYS.has(value);
}

export function addJapaneseBusinessDays(value: string, count: number): string {
  const date = dateOf(value);
  let remaining = count;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (isJapaneseBusinessDay(iso(date))) remaining -= 1;
  }
  return iso(date);
}

function businessDaysBetween(from: string, to: string): number {
  if (to <= from) return 0;
  const date = dateOf(from);
  let count = 0;
  while (iso(date) < to) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (isJapaneseBusinessDay(iso(date))) count += 1;
  }
  return count;
}

function milestone(dueDate: string, done: boolean, today: string): ScheduleMilestone {
  if (done) return { dueDate, status: "complete", overdueDays: 0 };
  if (today < dueDate) return { dueDate, status: "waiting", overdueDays: 0 };
  return {
    dueDate,
    status: today === dueDate ? "due_today" : "overdue",
    overdueDays: today === dueDate ? 0 : businessDaysBetween(dueDate, today),
  };
}

export function shipmentScheduleOf(input: {
  poSentAt: string | null | undefined;
  shippedOn?: string | null | undefined;
  provisionalDone: boolean;
  confirmedDone: boolean;
  today?: string;
}): ShipmentSchedule | null {
  const poSentDate = input.poSentAt?.slice(0, 10);
  if (!poSentDate) return null;
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const provisional = milestone(addJapaneseBusinessDays(poSentDate, 3), input.provisionalDone, today);
  const confirmed = milestone(
    addJapaneseBusinessDays(poSentDate, 7),
    input.confirmedDone || Boolean(input.shippedOn),
    today,
  );
  const reminderKind = confirmed.status === "overdue"
    ? "confirmed"
    : provisional.status === "overdue" ? "provisional" : null;
  return {
    provisional,
    confirmed,
    arrivalEstimateDate: arrivalEstimateFromShipment(input.shippedOn),
    reminderKind,
  };
}

export function arrivalEstimateFromShipment(shippedOn: string | null | undefined): string | null {
  return shippedOn ? addJapaneseBusinessDays(shippedOn, 7) : null;
}
