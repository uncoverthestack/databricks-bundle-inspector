import { describe, test, expect } from "@jest/globals";
import { folderIgnoresCase, swapLetterCase } from "../../../bundle/pathCase.js";

/** A pretend file system: each path it knows maps to the id of the folder it names. */
function fileSystem(folders: Record<string, number>) {
  return async (path: string) => {
    const ino = folders[path];
    if (ino === undefined) throw new Error(`ENOENT: ${path}`);
    return { ino, dev: 1 };
  };
}

describe("swapLetterCase", () => {
  test("swaps every letter and leaves the rest alone", () => {
    expect(swapLetterCase("/Users/me/orders_etl-2")).toBe("/uSERS/ME/ORDERS_ETL-2");
    expect(swapLetterCase("c:\\Proj")).toBe("C:\\pROJ");
  });
});

describe("folderIgnoresCase", () => {
  test("is true when another spelling reaches the same folder (macOS, Windows)", async () => {
    const stat = fileSystem({ "/Work/etl": 7, "/wORK/ETL": 7 });
    expect(await folderIgnoresCase("/Work/etl", stat)).toBe(true);
  });

  test("is false when the other spelling does not exist (Linux)", async () => {
    const stat = fileSystem({ "/Work/etl": 7 });
    expect(await folderIgnoresCase("/Work/etl", stat)).toBe(false);
  });

  test("is false when the other spelling is a different folder", async () => {
    const stat = fileSystem({ "/Work/etl": 7, "/wORK/ETL": 8 });
    expect(await folderIgnoresCase("/Work/etl", stat)).toBe(false);
  });

  test("is false for a path with no letters, where there is nothing to compare", async () => {
    const stat = fileSystem({ "/1/2": 7 });
    expect(await folderIgnoresCase("/1/2", stat)).toBe(false);
  });

  test("is false when the folder itself is gone", async () => {
    expect(await folderIgnoresCase("/Work/etl", fileSystem({}))).toBe(false);
  });
});
