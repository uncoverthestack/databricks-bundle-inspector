import { describe, test, expect } from "@jest/globals";
import { describeCronExpression } from "../../../bundle/graph/cronDescription.js";

// All expressions taken from or derived from the Quartz 2.3 CronTrigger tutorial:
// https://www.quartz-scheduler.org/documentation/quartz-2.3.0/tutorials/crontrigger.html
//
// Quartz field order:  seconds  minutes  hours  day-of-month  month  day-of-week  [year]
// Quartz DOW numbering: 1=SUN  2=MON  3=TUE  4=WED  5=THU  6=FRI  7=SAT

describe("describeCronExpression — daily patterns", () => {
  test("fires every day at noon", () => {
    expect(describeCronExpression("0 0 12 * * ?")).toBe("Every day at 12:00");
  });

  test("fires every day at 10:15 — dom=? dow=*", () => {
    expect(describeCronExpression("0 15 10 ? * *")).toBe("Every day at 10:15");
  });

  test("fires every day at 10:15 — dom=* dow=?", () => {
    expect(describeCronExpression("0 15 10 * * ?")).toBe("Every day at 10:15");
  });

  test("ignores optional year field", () => {
    expect(describeCronExpression("0 15 10 * * ? *")).toBe("Every day at 10:15");
  });

  test("fires every day at 07:00", () => {
    expect(describeCronExpression("0 0 7 * * ?")).toBe("Every day at 07:00");
  });

  test("fires every day at midnight", () => {
    expect(describeCronExpression("0 0 0 * * ?")).toBe("Every day at 00:00");
  });

  test("fires every day at 07:30", () => {
    expect(describeCronExpression("0 30 7 * * ?")).toBe("Every day at 07:30");
  });
});

describe("describeCronExpression — day-of-week patterns", () => {
  test("fires every weekday at 10:15 — named range MON-FRI", () => {
    expect(describeCronExpression("0 15 10 ? * MON-FRI")).toBe(
      "Every weekday (Mon–Fri) at 10:15",
    );
  });

  test("fires every weekday at 09:00 — numeric range 2-6", () => {
    expect(describeCronExpression("0 0 9 ? * 2-6")).toBe(
      "Every weekday (Mon–Fri) at 09:00",
    );
  });

  test("fires every Monday — numeric DOW", () => {
    expect(describeCronExpression("0 15 10 ? * 2")).toBe(
      "Every Monday at 10:15",
    );
  });

  test("fires every Friday — named DOW", () => {
    expect(describeCronExpression("0 15 10 ? * FRI")).toBe(
      "Every Friday at 10:15",
    );
  });

  test("fires every Sunday — DOW=1", () => {
    expect(describeCronExpression("0 0 8 ? * 1")).toBe("Every Sunday at 08:00");
  });

  test("fires Monday, Wednesday, Friday — comma list", () => {
    expect(describeCronExpression("0 15 10 ? * MON,WED,FRI")).toBe(
      "Monday, Wednesday, Friday at 10:15",
    );
  });

  test("fires Tuesday through Saturday — named range", () => {
    expect(describeCronExpression("0 0 6 ? * TUE-SAT")).toBe(
      "Tuesday through Saturday at 06:00",
    );
  });
});

describe("describeCronExpression — day-of-month patterns", () => {
  test("fires on the 15th of every month", () => {
    expect(describeCronExpression("0 15 10 15 * ?")).toBe(
      "15th of every month at 10:15",
    );
  });

  test("fires on the 1st of every month", () => {
    expect(describeCronExpression("0 0 0 1 * ?")).toBe(
      "1st of every month at 00:00",
    );
  });

  test("fires on the 2nd of every month", () => {
    expect(describeCronExpression("0 0 0 2 * ?")).toBe(
      "2nd of every month at 00:00",
    );
  });

  test("fires on the 3rd of every month", () => {
    expect(describeCronExpression("0 0 0 3 * ?")).toBe(
      "3rd of every month at 00:00",
    );
  });

  test("fires on the 11th (th suffix for 11-13)", () => {
    expect(describeCronExpression("0 0 0 11 * ?")).toBe(
      "11th of every month at 00:00",
    );
  });

  test("fires on the 21st (st suffix)", () => {
    expect(describeCronExpression("0 0 0 21 * ?")).toBe(
      "21st of every month at 00:00",
    );
  });

  test("fires on the last day of the month — L", () => {
    expect(describeCronExpression("0 15 10 L * ?")).toBe(
      "Last day of every month at 10:15",
    );
  });

  test("fires on days 1 through 5 — dom range", () => {
    expect(describeCronExpression("0 0 9 1-5 * ?")).toBe(
      "Days 1st–5th of every month at 09:00",
    );
  });

  test("fires on the nearest weekday to the 15th — W", () => {
    expect(describeCronExpression("0 15 10 15W * ?")).toBe(
      "Nearest weekday to the 15th at 10:15",
    );
  });
});

describe("describeCronExpression — L and # in day-of-week", () => {
  test("fires on the last Friday of every month — 6L", () => {
    expect(describeCronExpression("0 15 10 ? * 6L")).toBe(
      "Last Friday of every month at 10:15",
    );
  });

  test("fires on the last Saturday of every month — 7L", () => {
    expect(describeCronExpression("0 0 0 ? * 7L")).toBe(
      "Last Saturday of every month at 00:00",
    );
  });

  test("fires on the 3rd Friday of every month — 6#3", () => {
    expect(describeCronExpression("0 15 10 ? * 6#3")).toBe(
      "3rd Friday of every month at 10:15",
    );
  });

  test("fires on the 1st Monday of every month — 2#1", () => {
    expect(describeCronExpression("0 0 9 ? * 2#1")).toBe(
      "1st Monday of every month at 09:00",
    );
  });
});

describe("describeCronExpression — increment patterns", () => {
  test("fires every 5 minutes, only in the 14:00 hour", () => {
    expect(describeCronExpression("0 0/5 14 * * ?")).toBe(
      "Runs every 5 minutes, 14:00 to 14:55",
    );
  });

  test("fires every 30 minutes", () => {
    expect(describeCronExpression("0 0/30 * * * ?")).toBe(
      "Runs every 30 minutes",
    );
  });

  test("fires every 1 minute — step of 1", () => {
    expect(describeCronExpression("0 0/1 * * * ?")).toBe(
      "Runs every minute",
    );
  });

  test("fires every 6 hours", () => {
    expect(describeCronExpression("0 0 0/6 * * ?")).toBe(
      "Runs every 6 hours",
    );
  });

  test("fires every 1 hour — step of 1", () => {
    expect(describeCronExpression("0 0 0/1 * * ?")).toBe(
      "Runs every hour",
    );
  });
});

describe("describeCronExpression — month-specific patterns", () => {
  test("fires on the 1st of January — numeric month", () => {
    expect(describeCronExpression("0 0 0 1 1 ?")).toBe(
      "1st of every month in January at 00:00",
    );
  });

  test("fires on the 1st of March — named month", () => {
    expect(describeCronExpression("0 0 0 1 MAR ?")).toBe(
      "1st of every month in March at 00:00",
    );
  });

  test("fires every Wednesday in March — named month + dow", () => {
    expect(describeCronExpression("0 15 10 ? MAR WED")).toBe(
      "Every Wednesday in March at 10:15",
    );
  });
});

describe("describeCronExpression — timezone suffix", () => {
  test("appends timezone when provided", () => {
    expect(
      describeCronExpression("0 0 7 * * ?", "America/Los_Angeles"),
    ).toBe("Every day at 07:00 (America/Los_Angeles)");
  });

  test("appends timezone to increment pattern", () => {
    expect(describeCronExpression("0 0/30 * * * ?", "UTC")).toBe(
      "Runs every 30 minutes (UTC)",
    );
  });

  test("no timezone suffix when tz is undefined", () => {
    expect(describeCronExpression("0 0 7 * * ?", undefined)).toBe(
      "Every day at 07:00",
    );
  });
});

describe("describeCronExpression — fallback behaviour", () => {
  test("returns raw expression when fewer than 6 fields", () => {
    expect(describeCronExpression("0 0 7 * *")).toBe("0 0 7 * *");
  });

  test("returns raw expression for unrecognised pattern", () => {
    // e.g. seconds wildcard with range in minutes — not described
    const raw = "0 0-5 14 * * ?";
    expect(describeCronExpression(raw)).toBe(raw);
  });
});

describe("describeCronExpression — says every limit, or shows the expression (#506)", () => {
  test.each([
    ["0 0/15 9-17 ? * MON-FRI", "Runs every 15 minutes, 09:00 to 17:45, every weekday (Mon–Fri)"],
    ["0 */15 9-17 ? * MON-FRI", "Runs every 15 minutes, 09:00 to 17:45, every weekday (Mon–Fri)"],
    ["0 0 0/6 ? * SAT", "Runs every 6 hours, every Saturday"],
    ["0 0 0/2 1 * ?", "Runs every 2 hours, on the 1st of every month"],
    ["0 0 9-17 ? * MON-FRI", "Runs every hour, 09:00 to 17:00, every weekday (Mon–Fri)"],
    ["0 30 9-17 ? * MON,WED,FRI", "Runs every hour, 09:30 to 17:30, on Monday, Wednesday, Friday"],
    ["0 * * * * ?", "Runs every minute"],
    ["0 0 * * * ?", "Runs every hour"],
    ["0 30 * * * ?", "Runs every hour at 30 minutes past"],
    ["0 5/15 * * * ?", "Runs every 15 minutes, from 5 minutes past the hour"],
    ["0 0/10 * ? * 6L", "Runs every 10 minutes, on the last Friday of every month"],
    ["0 0/10 * ? * 2#1", "Runs every 10 minutes, on the 1st Monday of every month"],
    ["0 0/30 * L * ?", "Runs every 30 minutes, on the last day of every month"],
    ["0 0/30 * 1-5 * ?", "Runs every 30 minutes, on days 1st–5th of every month"],
    ["0 0/30 * * 3 ?", "Runs every 30 minutes, in March"],
    ["0 0 9 1-5 3 ?", "Days 1st–5th of every month in March at 09:00"],
    ["0 0 9 L MAR ?", "Last day of every month in March at 09:00"],
    ["0 0 9,12,15 * * ?", "Every day at 09:00, 12:00 and 15:00"],
    ["0 0 0/5 * * ?", "Every day at 00:00, 05:00, 10:00, 15:00 and 20:00"],
    ["0 30 0/6 ? * SAT", "Every Saturday at 00:30, 06:30, 12:30 and 18:30"],
    ["0 0 1/2 * * ?", "Runs every 2 hours, 01:00 to 23:00"],
    ["0 0 12 * * ? 2027", "Every day at 12:00 in 2027"],
  ])("%s", (expr, words) => {
    expect(describeCronExpression(expr)).toBe(words);
  });

  test("keeps the time zone at the end", () => {
    expect(describeCronExpression("0 0/15 9-17 ? * MON-FRI", "UTC")).toBe(
      "Runs every 15 minutes, 09:00 to 17:45, every weekday (Mon–Fri) (UTC)",
    );
  });

  test.each([
    "0/30 * * * * ?", // repeats within a minute
    "0 0/25 * * * ?", // restarts each hour, so not every 25 minutes
    "0 0/15 9,17 * * ?", // a list of hours with a repeat
    "0 0 9 * JAN-MAR ?", // a range of months
    "0 0 9 * * ? 2027-2028", // a range of years
    "0 0 9 1,L * ?",
  ])("shows the expression when it can't say every limit: %s", (expr) => {
    expect(describeCronExpression(expr)).toBe(expr);
  });
});
