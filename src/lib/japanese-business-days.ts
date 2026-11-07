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

export const JAPANESE_HOLIDAY_DATA_VERSION = "japan-national-holidays-cabinet-office-2024-2027-1";
const JAPANESE_HOLIDAY_RANGE = { first: "2024-01-01", last: "2027-12-31" };

const JAPANESE_HOLIDAYS = new Set<string>([
  // Generated from Cabinet Office national-holiday CSV (2024–2027).
  "2024-01-01","2024-01-08","2024-02-11","2024-02-12","2024-02-23","2024-03-20","2024-04-29",
  "2024-05-03","2024-05-04","2024-05-05","2024-05-06","2024-07-15","2024-08-11","2024-08-12",
  "2024-09-16","2024-09-22","2024-09-23","2024-10-14","2024-11-03","2024-11-04","2024-11-23",
  "2025-01-01","2025-01-13","2025-02-11","2025-02-23","2025-02-24","2025-03-20","2025-04-29",
  "2025-05-03","2025-05-04","2025-05-05","2025-05-06","2025-07-21","2025-08-11","2025-09-15",
  "2025-09-23","2025-10-13","2025-11-03","2025-11-23","2025-11-24",
  "2026-01-01","2026-01-12","2026-02-11","2026-02-23","2026-03-20","2026-04-29","2026-05-03",
  "2026-05-04","2026-05-05","2026-05-06","2026-07-20","2026-08-11","2026-09-21","2026-09-22",
  "2026-09-23","2026-10-12","2026-11-03","2026-11-23",
  "2027-01-01","2027-01-11","2027-02-11","2027-02-23","2027-03-21","2027-03-22","2027-04-29",
  "2027-05-03","2027-05-04","2027-05-05","2027-07-19","2027-08-11","2027-09-20","2027-09-23",
  "2027-10-11","2027-11-03","2027-11-23",
]);

function assertHolidayDataSupported(value: string): void {
  if (value < JAPANESE_HOLIDAY_RANGE.first || value > JAPANESE_HOLIDAY_RANGE.last) {
    throw new Error(`japanese_holiday_data_unsupported:${JAPANESE_HOLIDAY_DATA_VERSION}`);
  }
}

/** Convert an ISO timestamp to a Japanese calendar date while preserving plain date input. */
export function japaneseCalendarDate(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const date = dateOf(value);
    if (Number.isNaN(date.getTime()) || iso(date) !== value) throw new Error("invalid_japanese_calendar_date");
    return value;
  }
  if (!value) throw new Error("invalid_japanese_calendar_date");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("invalid_japanese_calendar_date");
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function japaneseToday(): string {
  return japaneseCalendarDate(new Date().toISOString());
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dateOf(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

export function isJapaneseBusinessDay(value: string): boolean {
  const calendarDate = japaneseCalendarDate(value);
  assertHolidayDataSupported(calendarDate);
  const day = dateOf(calendarDate).getUTCDay();
  return day !== 0 && day !== 6 && !JAPANESE_HOLIDAYS.has(calendarDate);
}

export function addJapaneseBusinessDays(value: string, count: number): string {
  const date = dateOf(japaneseCalendarDate(value));
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
  if (!input.poSentAt) return null;
  const poSentDate = japaneseCalendarDate(input.poSentAt);
  const today = input.today ?? japaneseToday();
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
