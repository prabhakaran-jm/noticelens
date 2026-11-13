import { describe, expect, it } from "vitest";
import {
  assessBillingPeriodGap,
  assessDeadlines,
  assessIssueDate,
  classifyDeadline,
  isoDateFromClock,
} from "../../src/domain/dates";

describe("dates — injected calendar, not the machine clock", () => {
  it("classifies past, due today, upcoming, and missing deadlines", () => {
    expect(classifyDeadline("25 November 2026", "2026-11-26")).toMatchObject({
      urgency: "past",
      iso: "2026-11-25",
      daysFromToday: -1,
      displayLabel: "Deadline date passed (1 day ago · 25 Nov 2026)",
    });
    expect(classifyDeadline("25 November 2026", "2026-11-25")).toMatchObject({
      urgency: "due_today",
      daysFromToday: 0,
      displayLabel: "Due today · 25 Nov 2026",
    });
    expect(classifyDeadline("2026-11-25", "2026-11-13")).toMatchObject({
      urgency: "upcoming",
      daysFromToday: 12,
      displayLabel: "Due in 12 days · 25 Nov 2026",
    });
    expect(classifyDeadline("promptly upon receipt", "2026-11-13").urgency).toBe("missing");
    expect(classifyDeadline(null, "2026-11-13").displayLabel).toBe("No calendar date stated");
    expect(classifyDeadline("", "2026-11-13").urgency).toBe("missing");
  });

  it("lists conflicting dates without choosing a winner", () => {
    const assessed = assessDeadlines(
      ["25 November 2026", "30 November 2026", "promptly upon receipt"],
      "2026-11-13"
    );
    expect(assessed.conflicting).toBe(true);
    expect(assessed.conflictBanner).toBe("Multiple dates stated in notice");
    expect(assessed.distinctIsoDates).toEqual(["2026-11-25", "2026-11-30"]);
    expect(assessed.items).toHaveLength(3);
    expect(assessed.dates.map((date) => date.iso)).toEqual(["2026-11-25", "2026-11-30"]);
    expect("authoritative" in assessed).toBe(false);

    const sameDay = assessDeadlines(["25 November 2026", "2026-11-25"], "2026-11-13");
    expect(sameDay.conflicting).toBe(false);
    expect(sameDay.distinctIsoDates).toEqual(["2026-11-25"]);
  });

  it("flags malformed dates and keeps UK day-month order", () => {
    expect(classifyDeadline("32 November 2026", "2026-11-13").urgency).toBe("unparseable");
    expect(classifyDeadline("2026-02-31", "2026-11-13").urgency).toBe("unparseable");
    expect(classifyDeadline("29 February 2025", "2026-11-13").urgency).toBe("unparseable");
    expect(classifyDeadline("29 February 2024", "2026-11-13").iso).toBe("2024-02-29");
    expect(classifyDeadline("25/11/2026", "2026-11-13").iso).toBe("2026-11-25");
    expect(classifyDeadline("11/25/2026", "2026-11-13").urgency).toBe("unparseable");
    expect(classifyDeadline("25 November 2026 or 1 December 2026", "2026-11-13").urgency).toBe(
      "conflicting"
    );
  });

  it("measures the 12-month gap from the notice issue date", () => {
    const over = assessBillingPeriodGap("January and June 2025", "18 November 2026");
    expect(over.status).toBe("gap_over_12_months");
    expect(over.note).toBe("Includes period >12 months prior to notice date");
    expect(over.earliestIso).toBe("2025-01-01");

    expect(assessBillingPeriodGap("18 November 2025", "18 November 2026").status).toBe(
      "within_12_months"
    );
    expect(assessBillingPeriodGap("17 November 2025", "18 November 2026").status).toBe(
      "gap_over_12_months"
    );
    expect(assessBillingPeriodGap("not stated", "18 November 2026").status).toBe("missing");
    expect(assessBillingPeriodGap("January and June 2025", null).status).toBe("missing");
    expect(assessBillingPeriodGap("sometime last year", "18 November 2026").status).toBe(
      "unparseable"
    );
  });

  it("labels a future notice date against the injected clock", () => {
    const future = assessIssueDate("2 December 2026", "2026-11-13");
    expect(future.futureDatedFixture).toBe(true);
    expect(future.label).toBe("Synthetic / future notice date: 2 Dec 2026");
    expect(assessIssueDate("18 November 2026", "2026-11-26").futureDatedFixture).toBe(false);
    expect(isoDateFromClock(new Date("2026-11-13T03:00:00Z"), "UTC")).toBe("2026-11-13");
    expect(isoDateFromClock(new Date("2026-11-13T03:00:00Z"), "America/Los_Angeles")).toBe(
      "2026-11-12"
    );
  });
});
