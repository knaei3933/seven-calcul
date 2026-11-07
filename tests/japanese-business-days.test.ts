import { describe, expect, it } from "vitest";
import {
  addJapaneseBusinessDays,
  arrivalEstimateFromShipment,
  isJapaneseBusinessDay,
  japaneseCalendarDate,
  japaneseToday,
  shipmentScheduleOf,
} from "@/lib/japanese-business-days";

describe("Japanese film shipment schedule", () => {
  it("skips weekends and Japanese holidays", () => {
    expect(isJapaneseBusinessDay("2026-05-01")).toBe(true);
    expect(isJapaneseBusinessDay("2026-05-03")).toBe(false);
    expect(isJapaneseBusinessDay("2026-05-06")).toBe(false);
    expect(addJapaneseBusinessDays("2026-04-30", 3)).toBe("2026-05-08");
    // Cabinet Office substitute holidays.
    expect(isJapaneseBusinessDay("2024-08-12")).toBe(false);
    expect(isJapaneseBusinessDay("2025-11-24")).toBe(false);
    expect(isJapaneseBusinessDay("2026-09-23")).toBe(false);
    expect(isJapaneseBusinessDay("2027-05-06")).toBe(true);
  });

  it("rejects impossible calendar dates", () => {
    expect(() => japaneseCalendarDate("2026-02-30")).toThrow("invalid_japanese_calendar_date");
    expect(() => addJapaneseBusinessDays("2026-02-30", 1)).toThrow("invalid_japanese_calendar_date");
    expect(() => arrivalEstimateFromShipment("2026-02-30")).toThrow("invalid_japanese_calendar_date");
  });

  it("normalizes timestamps to the Tokyo calendar date", () => {
    // 2026-11-08 00:30 UTC is still Nov 8 in Tokyo.
    expect(japaneseCalendarDate("2026-11-08T00:30:00.000Z")).toBe("2026-11-08");
    // 2026-11-07 15:30 UTC is Nov 8 in Tokyo.
    expect(japaneseCalendarDate("2026-11-07T15:30:00.000Z")).toBe("2026-11-08");
    expect(japaneseCalendarDate("2026-11-08")).toBe("2026-11-08");
    expect(japaneseToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });

  it("fails visibly outside versioned holiday data", () => {
    expect(() => isJapaneseBusinessDay("2023-12-29")).toThrow("japanese_holiday_data_unsupported");
    expect(() => isJapaneseBusinessDay("2028-01-02")).toThrow("japanese_holiday_data_unsupported");
  });

  it("marks PO+3 and PO+7 milestones and derives arrival after confirmed shipment", () => {
    const schedule = shipmentScheduleOf({
      poSentAt: "2026-05-01T10:00:00.000Z",
      shippedOn: null,
      provisionalDone: false,
      confirmedDone: false,
      today: "2026-05-12",
    });
    expect(schedule?.provisional).toMatchObject({ dueDate: "2026-05-11", status: "overdue" });
    expect(schedule?.confirmed).toMatchObject({ dueDate: "2026-05-15", status: "waiting" });
    expect(schedule?.reminderKind).toBe("provisional");

    const confirmed = shipmentScheduleOf({
      poSentAt: "2026-05-01T10:00:00.000Z",
      shippedOn: "2026-05-12",
      provisionalDone: true,
      confirmedDone: false,
      today: "2026-05-12",
    });
    expect(confirmed?.confirmed.status).toBe("complete");
    expect(confirmed?.reminderKind).toBeNull();
    expect(arrivalEstimateFromShipment("2026-05-12")).toBe("2026-05-21");
  });
});
