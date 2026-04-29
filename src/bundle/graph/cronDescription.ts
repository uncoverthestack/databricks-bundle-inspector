// Quartz cron format: seconds minutes hours day-of-month month day-of-week [year]
// Quartz day-of-week: 1=SUN 2=MON 3=TUE 4=WED 5=THU 6=FRI 7=SAT

const QUARTZ_DOW: Record<string, string> = {
  "1": "Sunday",
  "2": "Monday",
  "3": "Tuesday",
  "4": "Wednesday",
  "5": "Thursday",
  "6": "Friday",
  "7": "Saturday",
  SUN: "Sunday",
  MON: "Monday",
  TUE: "Tuesday",
  WED: "Wednesday",
  THU: "Thursday",
  FRI: "Friday",
  SAT: "Saturday",
};

const QUARTZ_MONTH: Record<string, string> = {
  "1": "January",
  "2": "February",
  "3": "March",
  "4": "April",
  "5": "May",
  "6": "June",
  "7": "July",
  "8": "August",
  "9": "September",
  "10": "October",
  "11": "November",
  "12": "December",
  JAN: "January",
  FEB: "February",
  MAR: "March",
  APR: "April",
  MAY: "May",
  JUN: "June",
  JUL: "July",
  AUG: "August",
  SEP: "September",
  OCT: "October",
  NOV: "November",
  DEC: "December",
};

function ordinal(n: number): string {
  const v = n % 100;
  const suffix =
    v >= 11 && v <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}

function hhmm(h: string, m: string): string {
  return `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
}

function describeDow(dow: string): string | undefined {
  // "6#3" = 3rd Friday of the month
  if (dow.includes("#")) {
    const [dayPart, nthPart] = dow.split("#");
    const dayName = (dayPart && QUARTZ_DOW[dayPart]) ?? dayPart ?? "";
    const nth = parseInt(nthPart ?? "", 10);
    if (!isNaN(nth)) return `${ordinal(nth)} ${dayName} of every month`;
  }
  // "6L" = last Friday of the month
  if (dow.endsWith("L") && dow.length > 1) {
    const dayPart = dow.slice(0, -1);
    const dayName = QUARTZ_DOW[dayPart] ?? dayPart;
    return `Last ${dayName} of every month`;
  }
  // "MON-FRI" or "2-6"
  if (dow.includes("-")) {
    const [from, to] = dow.split("-");
    if (
      (from === "MON" || from === "2") &&
      (to === "FRI" || to === "6")
    ) {
      return "Every weekday (Mon–Fri)";
    }
    const fromName = (from && QUARTZ_DOW[from]) ?? from ?? "";
    const toName = (to && QUARTZ_DOW[to]) ?? to ?? "";
    return `${fromName} through ${toName}`;
  }
  // "MON,WED,FRI"
  if (dow.includes(",")) {
    return dow
      .split(",")
      .map((d) => QUARTZ_DOW[d] ?? d)
      .join(", ");
  }
  // single day
  const dayName = QUARTZ_DOW[dow];
  if (dayName) return `Every ${dayName}`;
  return undefined;
}

/**
 * Converts a Quartz cron expression into a human-readable description.
 * Returns the raw expression unchanged for patterns it cannot describe.
 */
export function describeCronExpression(expr: string, tz?: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 6) return expr;

  const min = parts[1] ?? "";
  const hour = parts[2] ?? "";
  const dom = parts[3] ?? "";
  const month = parts[4] ?? "*";
  const dow = parts[5] ?? "";
  const tzSuffix = tz ? ` (${tz})` : "";

  // Increment in minutes: "0/30" = every 30 minutes
  if (min.includes("/")) {
    const step = parseInt(min.split("/")[1] ?? "", 10);
    if (!isNaN(step)) {
      return step === 1
        ? `Runs every minute${tzSuffix}`
        : `Runs every ${step} minutes${tzSuffix}`;
    }
  }
  // Increment in hours: "0/6" = every 6 hours
  if (hour.includes("/")) {
    const step = parseInt(hour.split("/")[1] ?? "", 10);
    if (!isNaN(step)) {
      return step === 1
        ? `Runs every hour${tzSuffix}`
        : `Runs every ${step} hours${tzSuffix}`;
    }
  }

  // timeKnown only when hour and min are plain integers — not wildcards, ranges, or increments
  const timeKnown = /^\d+$/.test(hour) && /^\d+$/.test(min);
  const at = timeKnown ? ` at ${hhmm(hour, min)}` : "";
  const inMonth = QUARTZ_MONTH[month] ? ` in ${QUARTZ_MONTH[month]}` : "";

  // Only say "Every day" when the time is fully described or fully wildcarded
  const timeDescribable = timeKnown || (hour === "*" && min === "*");

  // Day-of-week schedule: dom is "?" (or "*" with an active dow)
  const dowActive = dow !== "?" && dow !== "*";
  if (dom === "?" || (dom === "*" && dowActive)) {
    if (dow === "*" || dow === "?") {
      return timeDescribable ? `Every day${inMonth}${at}${tzSuffix}` : expr;
    }
    const dowDesc = describeDow(dow);
    if (dowDesc) return `${dowDesc}${inMonth}${at}${tzSuffix}`;
  }

  // Day-of-month schedule: dow is "?" or "*"
  if (dow === "?" || dow === "*") {
    if (dom === "L") return `Last day of every month${at}${tzSuffix}`;
    // "15W" = nearest weekday to the 15th
    if (dom.endsWith("W")) {
      const d = parseInt(dom.slice(0, -1), 10);
      const ref = isNaN(d) ? dom.slice(0, -1) : ordinal(d);
      return `Nearest weekday to the ${ref}${at}${tzSuffix}`;
    }
    // Check range before parseInt — parseInt("1-5") = 1 (not NaN)
    if (dom.includes("-")) {
      const [fromStr, toStr] = dom.split("-");
      const from = parseInt(fromStr ?? "", 10);
      const to = parseInt(toStr ?? "", 10);
      if (!isNaN(from) && !isNaN(to)) {
        return `Days ${ordinal(from)}–${ordinal(to)} of every month${at}${tzSuffix}`;
      }
    }
    if (dom.includes(",")) {
      const days = dom
        .split(",")
        .map((d) => {
          const n = parseInt(d, 10);
          return isNaN(n) ? d : ordinal(n);
        })
        .join(", ");
      return `${days} of every month${inMonth}${at}${tzSuffix}`;
    }
    if (dom === "*") {
      return timeDescribable ? `Every day${inMonth}${at}${tzSuffix}` : expr;
    }
    const domNum = parseInt(dom, 10);
    if (!isNaN(domNum)) {
      return `${ordinal(domNum)} of every month${inMonth}${at}${tzSuffix}`;
    }
  }

  return expr;
}
