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

/** A day-of-week token ("MON", "2"), only when it is one: never a name like "toString". */
function dayName(token: string): string | undefined {
  return Object.hasOwn(QUARTZ_DOW, token) ? QUARTZ_DOW[token] : undefined;
}

function describeDow(dow: string): string | undefined {
  // "6#3" = 3rd Friday of the month
  const nth = /^([^#]+)#([1-5])$/.exec(dow);
  if (nth) {
    const name = dayName(nth[1]!);
    return name && `${ordinal(Number(nth[2]))} ${name} of every month`;
  }
  // "6L" = last Friday of the month
  const last = /^(.+)L$/.exec(dow);
  if (last) {
    const name = dayName(last[1]!);
    return name && `Last ${name} of every month`;
  }
  // "MON-FRI" or "2-6"
  const range = /^([^,-]+)-([^,-]+)$/.exec(dow);
  if (range) {
    const [from, to] = [dayName(range[1]!), dayName(range[2]!)];
    if (!from || !to) return undefined;
    if (from === "Monday" && to === "Friday") return "Every weekday (Mon–Fri)";
    return `${from} through ${to}`;
  }
  // "MON,WED,FRI"
  if (dow.includes(",")) {
    const names = dow.split(",").map(dayName);
    return names.every(Boolean) ? names.join(", ") : undefined;
  }
  const name = dayName(dow);
  return name && `Every ${name}`;
}

/** "a", "a and b", "a, b and c". */
function listInWords(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

const isNumber = (field: string) => /^\d+$/.test(field);
/** A plain number from `min` to `max`. */
const inRange = (field: string, min: number, max: number) => isNumber(field) && Number(field) >= min && Number(field) <= max;

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
  if (inRange(hour, 0, 23)) return [Number(hour), Number(hour)];
  const match = /^(\d+)-(\d+)$/.exec(hour);
  if (!match || Number(match[1]) > Number(match[2]) || Number(match[2]) > 23) return undefined;
  return [Number(match[1]), Number(match[2])];
}

type Times =
  /** Fixed times of day: " at 10:15" or " at 09:00, 12:00 and 15:00". */
  | { kind: "at"; text: string }
  /** A repeat within the day: "Runs every 15 minutes, 09:00 to 17:45". */
  | { kind: "repeat"; text: string };

/** The times of day, or undefined when they can't be said in words without leaving something out. */
function describeTimes(sec: string, min: string, hour: string): Times | undefined {
  if (!inRange(sec, 0, 59)) return undefined;
  const s = Number(sec);
  const time = (h: number, m: number) => `${hhmm(String(h), String(m))}${s ? `:${String(s).padStart(2, "0")}` : ""}`;
  const repeat = (text: string): Times | undefined => (s ? undefined : { kind: "repeat", text });
  const minutes = min === "*" ? stepValues("0/1", 59) : stepValues(min, 59);

  if (minutes) {
    // A step that doesn't divide the hour restarts each hour, so "every 25 minutes" would be wrong.
    const step = (minutes[1] ?? 60) - minutes[0]!;
    if (minutes[0]! >= step || 60 % step !== 0) return undefined;
    const every = step === 1 ? "Runs every minute" : `Runs every ${step} minutes`;
    if (hour === "*") return repeat(minutes[0] === 0 ? every : `${every}, from ${minutes[0]} minutes past the hour`);
    const span = hourSpan(hour);
    if (!span) return undefined;
    return repeat(`${every}, ${time(span[0], minutes[0]!)} to ${time(span[1], minutes.at(-1)!)}`);
  }

  if (!inRange(min, 0, 59)) return undefined;
  const m = Number(min);
  if (inRange(hour, 0, 23)) return { kind: "at", text: ` at ${time(Number(hour), m)}` };
  if (hour === "*") return repeat(m === 0 ? "Runs every hour" : `Runs every hour at ${m} minutes past`);
  if (/^\d+(,\d+)+$/.test(hour)) {
    const hours = hour.split(",");
    if (!hours.every((h) => inRange(h, 0, 23))) return undefined;
    return { kind: "at", text: ` at ${listInWords(hours.map((h) => time(Number(h), m)))}` };
  }
  const range = /^\d+-\d+$/.test(hour) ? hourSpan(hour) : undefined;
  if (range) return repeat(`Runs every hour, ${time(range[0], m)} to ${time(range[1], m)}`);

  const hours = stepValues(hour, 23);
  if (!hours) return undefined;
  const step = (hours[1] ?? 24) - hours[0]!;
  if (m === 0 && hours[0] === 0 && 24 % step === 0) {
    return repeat(step === 1 ? "Runs every hour" : `Runs every ${step} hours`);
  }
  // Not evenly through the day: name the times while there are few enough to read.
  if (hours.length <= 6) return { kind: "at", text: ` at ${listInWords(hours.map((h) => time(h, m)))}` };
  return repeat(`Runs every ${step} hours, ${time(hours[0]!, m)} to ${time(hours.at(-1)!, m)}`);
}

interface Days {
  /** Leads the sentence before fixed times: "Every Saturday", "15th of every month". */
  lead: string;
  /** Follows a repeat: "every Saturday", "on the 15th of every month"; empty for every day. */
  after: string;
}

/** The days the schedule runs on, or undefined when they can't be said in words. */
function describeDays(dom: string, month: string, dow: string): Days | undefined {
  const monthName = Object.hasOwn(QUARTZ_MONTH, month) ? QUARTZ_MONTH[month] : undefined;
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
    if (!inRange(dom.slice(0, -1), 1, 31)) return undefined;
    const d = Number(dom.slice(0, -1));
    return days(`Nearest weekday to the ${ordinal(d)}`, `on the nearest weekday to the ${ordinal(d)}`);
  }
  const range = /^(\d+)-(\d+)$/.exec(dom);
  if (range) {
    if (!inRange(range[1]!, 1, 31) || !inRange(range[2]!, 1, 31) || Number(range[1]) > Number(range[2])) return undefined;
    const text = `${ordinal(Number(range[1]))}–${ordinal(Number(range[2]))} of every month`;
    return days(`Days ${text}`, `on days ${text}`);
  }
  if (/^\d+(,\d+)*$/.test(dom)) {
    if (!dom.split(",").every((d) => inRange(d, 1, 31))) return undefined;
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
  // Quartz reads names in any case: "jan" is "JAN".
  const [sec = "", min = "", hour = "", dom = "", month = "", dow = "", year = "*"] = parts.map((part) => part.toUpperCase());
  const tzSuffix = tz ? ` (${tz})` : "";

  // A seconds field that repeats ("0/30") runs more than once a minute: describeTimes says no.
  const inYear = year === "*" ? "" : inRange(year, 1970, 2099) ? ` in ${year}` : undefined;
  const times = describeTimes(sec, min, hour);
  const days = describeDays(dom, month, dow);
  if (inYear === undefined || !times || !days) return expr;

  if (times.kind === "at") return `${days.lead}${times.text}${inYear}${tzSuffix}`;
  return `${times.text}${days.after ? `, ${days.after}` : ""}${inYear}${tzSuffix}`;
}
