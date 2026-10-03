import { describe, expect, it } from "vitest"
import { coveredByMonthScan, monthScanDays } from "./month-scan"

const dir = (name: string) => ({ name, isDirectory: () => true, isFile: () => false })
const file = (name: string) => ({ name, isDirectory: () => false, isFile: () => true })

describe("monthScanDays", () => {
  it("returns the day folders of a year/month folder that has no photos of its own", () => {
    expect(monthScanDays(["jessi", "2025", "10"], [dir("18"), dir("07"), dir("31")])).toEqual(["07", "18", "31"])
  })
  it("ignores non-photo files and folders that aren't days", () => {
    expect(monthScanDays(["2025", "10"], [dir("18"), dir("misc"), dir("32"), file("notes.txt"), file("Thumbs.db")])).toEqual(["18"])
  })
  it("still counts a month that also holds a few loose photos of its own", () => {
    expect(monthScanDays(["2025", "10"], [dir("18"), file("IMG_1.jpg")])).toEqual(["18"])
  })
  it("is null when the folder isn't a month inside a year", () => {
    expect(monthScanDays(["jessi", "Trip"], [dir("18")])).toBeNull()
    expect(monthScanDays(["jessi", "10"], [dir("18")])).toBeNull()
    expect(monthScanDays(["2025", "13"], [dir("18")])).toBeNull()
    expect(monthScanDays(["10"], [dir("18")])).toBeNull()
  })
  it("is null when there are no day folders", () => {
    expect(monthScanDays(["2025", "10"], [dir("misc")])).toBeNull()
  })
})

describe("coveredByMonthScan", () => {
  it("names the month folder a day folder belongs to", () => {
    expect(coveredByMonthScan(["jessi", "2025", "10", "18"])).toEqual(["jessi", "2025", "10"])
  })
  it("is null for anything that isn't year/month/day", () => {
    expect(coveredByMonthScan(["jessi", "2025", "10"])).toBeNull()
    expect(coveredByMonthScan(["2025", "Trip", "18"])).toBeNull()
    expect(coveredByMonthScan(["18"])).toBeNull()
  })
})
