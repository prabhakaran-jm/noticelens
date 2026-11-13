export type DeadlineUrgency = "past" | "due_today" | "upcoming";

export type SingleDeadlineStatus =
  | DeadlineUrgency
  | "missing"
  | "unparseable"
  | "conflicting";

export interface CalendarDate {
  iso: string;
  year: number;
  month: number;
  day: number;
}

export interface DatedDeadline {
  input: string;
  iso: string;
  urgency: DeadlineUrgency;
  daysFromToday: number;
  displayLabel: string;
}

export interface ClassifiedDeadline {
  input: string | null;
  urgency: SingleDeadlineStatus;
  iso: string | null;
  daysFromToday: number | null;
  displayLabel: string;
  dates: DatedDeadline[];
}

export interface DeadlineSetAssessment {
  items: ClassifiedDeadline[];
  distinctIsoDates: string[];
  conflicting: boolean;
  conflictBanner: "Multiple dates stated in notice" | null;
  dates: DatedDeadline[];
}

export type BillingPeriodGapStatus =
  | "gap_over_12_months"
  | "within_12_months"
  | "missing"
  | "unparseable";

export interface BillingPeriodGap {
  status: BillingPeriodGapStatus;
  note: string | null;
  earliestIso: string | null;
  issueIso: string | null;
}

export interface IssueDateAssessment {
  iso: string | null;
  futureDatedFixture: boolean;
  label: string | null;
}

const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const MONTH_INDEX: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

const MONTH_TOKEN =
  "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";

const DATE_TOKEN_SOURCE = `\\b(\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\s+(?:${MONTH_TOKEN})\\s+\\d{4}|\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{4})\\b`;

function dateTokenPattern(): RegExp {
  return new RegExp(DATE_TOKEN_SOURCE, "gi");
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isValidYmd(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || year < 1900 || year > 2100) {
    return false;
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

function toIso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function formatDisplayDate(date: CalendarDate): string {
  const month = SHORT_MONTHS[date.month - 1];
  if (!month) {
    return date.iso;
  }
  return `${date.day} ${month} ${date.year}`;
}

export function parseCalendarDate(input: string): CalendarDate | null {
  const trimmed = input.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    if (!isValidYmd(year, month, day)) {
      return null;
    }
    return { iso: toIso(year, month, day), year, month, day };
  }

  const named = new RegExp(`^(\\d{1,2})\\s+(${MONTH_TOKEN})\\s+(\\d{4})$`, "i").exec(
    trimmed
  );
  if (named) {
    const day = Number(named[1]);
    const month = MONTH_INDEX[named[2]!.toLowerCase()];
    const year = Number(named[3]);
    if (!month || !isValidYmd(year, month, day)) {
      return null;
    }
    return { iso: toIso(year, month, day), year, month, day };
  }

  const numeric = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(trimmed);
  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    const year = Number(numeric[3]);
    if (!isValidYmd(year, month, day)) {
      return null;
    }
    return { iso: toIso(year, month, day), year, month, day };
  }

  return null;
}

export function requireToday(today: string): CalendarDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    throw new TypeError("today must be an injected YYYY-MM-DD calendar date");
  }
  const parsed = parseCalendarDate(today);
  if (!parsed) {
    throw new TypeError("today must be a real YYYY-MM-DD calendar date");
  }
  return parsed;
}

export function isoDateFromClock(now: Date, timeZone = "UTC"): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new Error("Could not read the injected clock");
  }
  return `${year}-${month}-${day}`;
}

export function diffCalendarDays(later: CalendarDate, earlier: CalendarDate): number {
  const laterUtc = Date.UTC(later.year, later.month - 1, later.day);
  const earlierUtc = Date.UTC(earlier.year, earlier.month - 1, earlier.day);
  return Math.round((laterUtc - earlierUtc) / 86_400_000);
}

function addMonths(date: CalendarDate, months: number): CalendarDate {
  const zeroBased = date.month - 1 + months;
  const year = date.year + Math.floor(zeroBased / 12);
  const month = (zeroBased % 12) + 1;
  const day = Math.min(date.day, daysInMonth(year, month));
  return { iso: toIso(year, month, day), year, month, day };
}

function urgencyFor(daysFromToday: number): DeadlineUrgency {
  if (daysFromToday < 0) {
    return "past";
  }
  if (daysFromToday === 0) {
    return "due_today";
  }
  return "upcoming";
}

function labelFor(date: CalendarDate, daysFromToday: number): string {
  const display = formatDisplayDate(date);
  if (daysFromToday === 0) {
    return `Due today · ${display}`;
  }
  if (daysFromToday < 0) {
    const ago = -daysFromToday;
    const unit = ago === 1 ? "day" : "days";
    return `Deadline date passed (${ago} ${unit} ago · ${display})`;
  }
  const unit = daysFromToday === 1 ? "day" : "days";
  return `Due in ${daysFromToday} ${unit} · ${display}`;
}

function extractDateTokens(input: string): string[] {
  return [...input.matchAll(dateTokenPattern())]
    .map((match) => match[1]!)
    .filter(Boolean);
}

export function classifyDeadline(
  input: string | null | undefined,
  today: string
): ClassifiedDeadline {
  const todayDate = requireToday(today);
  if (input === null || input === undefined || input.trim().length === 0) {
    return {
      input: input ?? null,
      urgency: "missing",
      iso: null,
      daysFromToday: null,
      displayLabel: "No calendar date stated",
      dates: [],
    };
  }

  const tokens = extractDateTokens(input);
  if (tokens.length === 0) {
    return {
      input,
      urgency: "missing",
      iso: null,
      daysFromToday: null,
      displayLabel: "No calendar date stated",
      dates: [],
    };
  }

  const parsed = tokens.map((token) => ({
    token,
    date: parseCalendarDate(token),
  }));
  if (parsed.some((item) => item.date === null)) {
    const dates: DatedDeadline[] = [];
    for (const item of parsed) {
      if (!item.date) {
        continue;
      }
      const daysFromToday = diffCalendarDays(item.date, todayDate);
      dates.push({
        input: item.token,
        iso: item.date.iso,
        urgency: urgencyFor(daysFromToday),
        daysFromToday,
        displayLabel: labelFor(item.date, daysFromToday),
      });
    }
    return {
      input,
      urgency: "unparseable",
      iso: null,
      daysFromToday: null,
      displayLabel: "Date could not be read",
      dates,
    };
  }

  const dates: DatedDeadline[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (!item.date || seen.has(item.date.iso)) {
      continue;
    }
    seen.add(item.date.iso);
    const daysFromToday = diffCalendarDays(item.date, todayDate);
    dates.push({
      input: item.token,
      iso: item.date.iso,
      urgency: urgencyFor(daysFromToday),
      daysFromToday,
      displayLabel: labelFor(item.date, daysFromToday),
    });
  }

  if (dates.length === 0) {
    return {
      input,
      urgency: "unparseable",
      iso: null,
      daysFromToday: null,
      displayLabel: "Date could not be read",
      dates: [],
    };
  }

  if (dates.length > 1) {
    return {
      input,
      urgency: "conflicting",
      iso: null,
      daysFromToday: null,
      displayLabel: "Multiple dates stated in notice",
      dates,
    };
  }

  const only = dates[0]!;
  return {
    input,
    urgency: only.urgency,
    iso: only.iso,
    daysFromToday: only.daysFromToday,
    displayLabel: only.displayLabel,
    dates,
  };
}

export function assessDeadlines(
  inputs: readonly (string | null | undefined)[],
  today: string
): DeadlineSetAssessment {
  const items = inputs.map((input) => classifyDeadline(input, today));
  const dates = items.flatMap((item) => item.dates);
  const distinctIsoDates = [...new Set(dates.map((date) => date.iso))];
  const conflicting = distinctIsoDates.length > 1;
  return {
    items,
    distinctIsoDates,
    conflicting,
    conflictBanner: conflicting ? "Multiple dates stated in notice" : null,
    dates,
  };
}

function parseLooseDate(input: string): CalendarDate | null {
  const direct = parseCalendarDate(input);
  if (direct) {
    return direct;
  }
  for (const token of extractDateTokens(input)) {
    const parsed = parseCalendarDate(token);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

interface MonthPoint {
  year: number;
  month: number;
  day: number;
}

function extractMonthPoints(billingPeriod: string): MonthPoint[] {
  const explicit = new RegExp(
    `\\b(\\d{1,2}\\s+)?(${MONTH_TOKEN})\\s+(\\d{4})\\b`,
    "gi"
  );
  const points: MonthPoint[] = [];
  const consumed = new Set<number>();
  for (const match of billingPeriod.matchAll(explicit)) {
    const month = MONTH_INDEX[match[2]!.toLowerCase()];
    const year = Number(match[3]);
    const day = match[1] ? Number(match[1]) : 1;
    if (!month || !isValidYmd(year, month, day) || match.index === undefined) {
      continue;
    }
    points.push({ year, month, day });
    consumed.add(match.index);
  }

  const years = [...billingPeriod.matchAll(/\b(19|20)\d{2}\b/g)].map((match) =>
    Number(match[0])
  );
  const uniqueYears = [...new Set(years)];
  if (uniqueYears.length !== 1) {
    return points;
  }
  const year = uniqueYears[0]!;
  const bareMonth = new RegExp(`\\b(${MONTH_TOKEN})\\b`, "gi");
  for (const match of billingPeriod.matchAll(bareMonth)) {
    if (match.index === undefined || consumed.has(match.index)) {
      continue;
    }
    const month = MONTH_INDEX[match[1]!.toLowerCase()];
    if (!month) {
      continue;
    }
    const already = points.some((point) => point.year === year && point.month === month);
    if (!already) {
      points.push({ year, month, day: 1 });
    }
  }
  return points;
}

export function assessBillingPeriodGap(
  billingPeriod: string | null | undefined,
  issueDate: string | null | undefined
): BillingPeriodGap {
  if (
    billingPeriod === null ||
    billingPeriod === undefined ||
    billingPeriod.trim().length === 0 ||
    /^not stated$/i.test(billingPeriod.trim())
  ) {
    return { status: "missing", note: null, earliestIso: null, issueIso: null };
  }
  if (issueDate === null || issueDate === undefined || issueDate.trim().length === 0) {
    return { status: "missing", note: null, earliestIso: null, issueIso: null };
  }

  const issue = parseLooseDate(issueDate);
  const points = extractMonthPoints(billingPeriod);
  if (!issue || points.length === 0) {
    return {
      status: "unparseable",
      note: null,
      earliestIso: null,
      issueIso: issue?.iso ?? null,
    };
  }

  const earliestPoint = [...points].sort((a, b) =>
    a.year === b.year ? (a.month === b.month ? a.day - b.day : a.month - b.month) : a.year - b.year
  )[0]!;
  const earliest: CalendarDate = {
    iso: toIso(earliestPoint.year, earliestPoint.month, earliestPoint.day),
    ...earliestPoint,
  };
  const plusTwelve = addMonths(earliest, 12);
  const moreThanTwelveMonths = diffCalendarDays(plusTwelve, issue) < 0;
  return {
    status: moreThanTwelveMonths ? "gap_over_12_months" : "within_12_months",
    note: moreThanTwelveMonths
      ? "Includes period >12 months prior to notice date"
      : null,
    earliestIso: earliest.iso,
    issueIso: issue.iso,
  };
}

export function assessIssueDate(
  issueDate: string | null | undefined,
  today: string
): IssueDateAssessment {
  const todayDate = requireToday(today);
  if (issueDate === null || issueDate === undefined || issueDate.trim().length === 0) {
    return {
      iso: null,
      futureDatedFixture: false,
      label: "No notice date stated",
    };
  }
  const parsed = parseLooseDate(issueDate);
  if (!parsed) {
    return {
      iso: null,
      futureDatedFixture: false,
      label: "Date could not be read",
    };
  }
  const futureDatedFixture = diffCalendarDays(parsed, todayDate) > 0;
  return {
    iso: parsed.iso,
    futureDatedFixture,
    label: futureDatedFixture
      ? `Synthetic / future notice date: ${formatDisplayDate(parsed)}`
      : null,
  };
}
