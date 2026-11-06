import { describe, expect, it } from "vitest";
import { addJapaneseBusinessDays, arrivalEstimateFromShipment, isJapaneseBusinessDay, shipmentScheduleOf } from "@/lib/japanese-business-days";

describe("Japanese film shipment schedule", () => {
  it("skips weekends and Japanese holidays", () => {
    expect(isJapaneseBusinessDay("2026-05-01")).toBe(true);
    expect(isJapaneseBusinessDay("2026-05-03")).toBe(false);
    expect(isJapaneseBusinessDay("2026-05-06")).toBe(false);
    expect(addJapaneseBusinessDays("2026-04-30", 3)).toBe("2026-05-08");
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
