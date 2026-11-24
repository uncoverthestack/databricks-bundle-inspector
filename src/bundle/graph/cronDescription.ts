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

/** "a", "a and b", "a, b and c". */
function listInWords(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

const isNumber = (field: string) => /^\d+$/.test(field);

/** The values a step field such as "0/15" or "*\/15" takes between 0 and `max`, when it is one. */
function stepValues(field: string, max: number): number[] | undefined {
  const match = /^(\*|\d+)\/(\d+)$/.exec(field);
  if (!match) return undefined;
  const from = match[1] === "*" ? 0 : Number(match[1]);
  const step = Number(match[2]);
  if (step < 1 || from > max) return undefined;
  const values: number[] = [];
  for (let value = from; value <= max; value += step) values.push(value);
  return values;
}

/** An hour field that is one hour or a range of hours: the first and last hour. */
function hourSpan(hour: string): [number, number] | undefined {
  if (isNumber(hour)) return [Number(hour), Number(hour)];
  const match = /^(\d+)-(\d+)$/.exec(hour);
  if (!match || Number(match[1]) > Number(match[2])) return undefined;
  return [Number(match[1]), Number(match[2])];
}

type Times =
  /** Fixed times of day: " at 10:15" or " at 09:00, 12:00 and 15:00". */
  | { kind: "at"; text: string }
  /** A repeat within the day: "Runs every 15 minutes, 09:00 to 17:45". */
  | { kind: "repeat"; text: string };

/** The times of day, or undefined when they can't be said in words without leaving something out. */
function describeTimes(min: string, hour: string): Times | undefined {
  const time = (h: number, m: number) => hhmm(String(h), String(m));
  const minutes = min === "*" ? stepValues("0/1", 59) : stepValues(min, 59);

  if (minutes) {
    // A step that doesn't divide the hour restarts each hour, so "every 25 minutes" would be wrong.
    const step = (minutes[1] ?? 60) - minutes[0]!;
    if (minutes[0]! >= step || 60 % step !== 0) return undefined;
    const every = step === 1 ? "Runs every minute" : `Runs every ${step} minutes`;
    if (hour === "*") return { kind: "repeat", text: minutes[0] === 0 ? every : `${every}, from ${minutes[0]} minutes past the hour` };
    const span = hourSpan(hour);
    if (!span) return undefined;
    return { kind: "repeat", text: `${every}, ${time(span[0], minutes[0]!)} to ${time(span[1], minutes.at(-1)!)}` };
  }

  if (!isNumber(min)) return undefined;
  const m = Number(min);
  if (isNumber(hour)) return { kind: "at", text: ` at ${hhmm(hour, min)}` };
  if (hour === "*") return { kind: "repeat", text: m === 0 ? "Runs every hour" : `Runs every hour at ${m} minutes past` };
  if (/^\d+(,\d+)+$/.test(hour)) {
    return { kind: "at", text: ` at ${listInWords(hour.split(",").map((h) => time(Number(h), m)))}` };
  }
  const range = /^\d+-\d+$/.test(hour) ? hourSpan(hour) : undefined;
  if (range) return { kind: "repeat", text: `Runs every hour, ${time(range[0], m)} to ${time(range[1], m)}` };

  const hours = stepValues(hour, 23);
  if (!hours) return undefined;
  const step = (hours[1] ?? 24) - hours[0]!;
  if (m === 0 && hours[0] === 0 && 24 % step === 0) {
    return { kind: "repeat", text: step === 1 ? "Runs every hour" : `Runs every ${step} hours` };
  }
  // Not evenly through the day: name the times while there are few enough to read.
  if (hours.length <= 6) return { kind: "at", text: ` at ${listInWords(hours.map((h) => time(h, m)))}` };
  return { kind: "repeat", text: `Runs every ${step} hours, ${time(hours[0]!, m)} to ${time(hours.at(-1)!, m)}` };
}

interface Days {
  /** Leads the sentence before fixed times: "Every Saturday", "15th of every month". */
  lead: string;
  /** Follows a repeat: "every Saturday", "on the 15th of every month"; empty for every day. */
  after: string;
}

/** The days the schedule runs on, or undefined when they can't be said in words. */
function describeDays(dom: string, month: string, dow: string): Days | undefined {
  const monthName = QUARTZ_MONTH[month];
  if (month !== "*" && !monthName) return undefined;
  const inMonth = monthName ? ` in ${monthName}` : "";
  const days = (lead: string, after: string): Days => ({ lead: `${lead}${inMonth}`, after: `${after}${inMonth}` });

  // Day-of-week schedule: dom is "?" (or "*" with an active dow)
  const dowActive = dow !== "?" && dow !== "*";
  if (dom === "?" || (dom === "*" && dowActive)) {
    if (!dowActive) return { lead: `Every day${inMonth}`, after: inMonth.trim() };
    const dowDesc = describeDow(dow);
    if (!dowDesc) return undefined;
    if (dowDesc.startsWith("Every ")) return days(dowDesc, `every ${dowDesc.slice("Every ".length)}`);
    if (/^(Last |\d)/.test(dowDesc)) return days(dowDesc, `on the ${dowDesc[0]!.toLowerCase()}${dowDesc.slice(1)}`);
    return days(dowDesc, `on ${dowDesc}`);
  }

  // Day-of-month schedule: dow is "?" or "*"
  if (dow !== "?" && dow !== "*") return undefined;
  if (dom === "*") return { lead: `Every day${inMonth}`, after: inMonth.trim() };
  if (dom === "L") return days("Last day of every month", "on the last day of every month");
  // "15W" = nearest weekday to the 15th
  if (dom.endsWith("W")) {
    const d = parseInt(dom.slice(0, -1), 10);
    if (isNaN(d)) return undefined;
    return days(`Nearest weekday to the ${ordinal(d)}`, `on the nearest weekday to the ${ordinal(d)}`);
  }
  const range = /^(\d+)-(\d+)$/.exec(dom);
  if (range) {
    const text = `${ordinal(Number(range[1]))}–${ordinal(Number(range[2]))} of every month`;
    return days(`Days ${text}`, `on days ${text}`);
  }
  if (/^\d+(,\d+)*$/.test(dom)) {
    const text = `${dom.split(",").map((d) => ordinal(Number(d))).join(", ")} of every month`;
    return days(text, `on the ${text}`);
  }
  return undefined;
}

/**
 * Converts a Quartz cron expression into a human-readable description. Says every limit on
 * when it runs (hours, days, month, year), or returns the raw expression unchanged when it
 * can't (#506): a sentence that leaves a limit out says the job runs more often than it does.
 */
export function describeCronExpression(expr: string, tz?: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 6 || parts.length > 7) return expr;
  const [sec = "", min = "", hour = "", dom = "", month = "", dow = "", year = "*"] = parts;
  const tzSuffix = tz ? ` (${tz})` : "";

  // A seconds field that repeats ("0/30") runs more than once a minute.
  if (!isNumber(sec)) return expr;
  const inYear = year === "*" ? "" : isNumber(year) ? ` in ${year}` : undefined;
  const times = describeTimes(min, hour);
  const days = describeDays(dom, month, dow);
  if (inYear === undefined || !times || !days) return expr;

  if (times.kind === "at") return `${days.lead}${times.text}${inYear}${tzSuffix}`;
  return `${times.text}${days.after ? `, ${days.after}` : ""}${inYear}${tzSuffix}`;
}
