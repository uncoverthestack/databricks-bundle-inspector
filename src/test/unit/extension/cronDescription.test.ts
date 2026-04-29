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
  test("fires every 5 minutes", () => {
    expect(describeCronExpression("0 0/5 14 * * ?")).toBe(
      "Runs every 5 minutes",
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
