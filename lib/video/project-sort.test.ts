import { describe, expect, it } from "vitest"
import { firstDir, formatLength, sortProjects } from "./project-sort"

const p = (name: string, modified = 0, clips = 0, duration = 0, bytes = 0) => ({ name, modified, clips, duration, bytes })

describe("sortProjects", () => {
  it("sorts names naturally, either way", () => {
    const list = [p("Trip 10"), p("trip 2"), p("Alpha")]
    expect(sortProjects(list, "name", "asc").map((x) => x.name)).toEqual(["Alpha", "trip 2", "Trip 10"])
    expect(sortProjects(list, "name", "desc").map((x) => x.name)).toEqual(["Trip 10", "trip 2", "Alpha"])
  })

  it("sorts by date, clips and size, ties by name, without touching the input", () => {
    const list = [p("b", 5, 1, 0, 9), p("a", 5, 3, 0, 1), p("c", 9, 2, 0, 5)]
    expect(sortProjects(list, "modified", "desc").map((x) => x.name)).toEqual(["c", "a", "b"])
    expect(sortProjects(list, "clips", "asc").map((x) => x.name)).toEqual(["b", "c", "a"])
    expect(sortProjects(list, "size", "desc").map((x) => x.name)).toEqual(["b", "c", "a"])
    expect(list.map((x) => x.name)).toEqual(["b", "a", "c"])
  })

  it("starts names A to Z and the rest biggest first", () => {
    expect(firstDir("name")).toBe("asc")
    expect(firstDir("modified")).toBe("desc")
  })
})

describe("formatLength", () => {
  it("shows m:ss and h:mm:ss", () => {
    expect(formatLength(0)).toBe("0:00")
    expect(formatLength(75)).toBe("1:15")
    expect(formatLength(3725)).toBe("1:02:05")
  })
})
