import { describe, expect, it } from "vitest";
import { gradeMatchesFilter } from "../filter-tags";

describe("gradeMatchesFilter", () => {
  it("returns false for undefined grade", () => {
    expect(gradeMatchesFilter(undefined, "grade-a")).toBe(false);
  });

  it("returns false for empty string grade", () => {
    expect(gradeMatchesFilter("", "grade-a")).toBe(false);
  });

  it("returns false for unrecognized grade string", () => {
    expect(gradeMatchesFilter("Z", "grade-a")).toBe(false);
  });

  it("returns false for a non-grade filter tag", () => {
    expect(gradeMatchesFilter("A", "usd-peg")).toBe(false);
  });

  describe("grade-a (A- and above)", () => {
    it("matches A+", () => expect(gradeMatchesFilter("A+", "grade-a")).toBe(true));
    it("matches A", () => expect(gradeMatchesFilter("A", "grade-a")).toBe(true));
    it("matches A- (boundary)", () => expect(gradeMatchesFilter("A-", "grade-a")).toBe(true));
    it("does not match B+", () => expect(gradeMatchesFilter("B+", "grade-a")).toBe(false));
    it("does not match B", () => expect(gradeMatchesFilter("B", "grade-a")).toBe(false));
  });

  describe("grade-ge-b (B and above)", () => {
    it("matches A", () => expect(gradeMatchesFilter("A", "grade-ge-b")).toBe(true));
    it("matches B (boundary)", () => expect(gradeMatchesFilter("B", "grade-ge-b")).toBe(true));
    it("does not match B-", () => expect(gradeMatchesFilter("B-", "grade-ge-b")).toBe(false));
    it("does not match C+", () => expect(gradeMatchesFilter("C+", "grade-ge-b")).toBe(false));
  });

  describe("grade-ge-c (C and above)", () => {
    it("matches B", () => expect(gradeMatchesFilter("B", "grade-ge-c")).toBe(true));
    it("matches C (boundary)", () => expect(gradeMatchesFilter("C", "grade-ge-c")).toBe(true));
    it("does not match C-", () => expect(gradeMatchesFilter("C-", "grade-ge-c")).toBe(false));
    it("does not match D", () => expect(gradeMatchesFilter("D", "grade-ge-c")).toBe(false));
  });

  describe("grade-ge-c-plus (C+ and above)", () => {
    it("matches A", () => expect(gradeMatchesFilter("A", "grade-ge-c-plus")).toBe(true));
    it("matches C+ (boundary)", () => expect(gradeMatchesFilter("C+", "grade-ge-c-plus")).toBe(true));
    it("does not match C", () => expect(gradeMatchesFilter("C", "grade-ge-c-plus")).toBe(false));
  });

  describe("grade-ge-c-minus (C- and above)", () => {
    it("matches C (above boundary)", () => expect(gradeMatchesFilter("C", "grade-ge-c-minus")).toBe(true));
    it("matches C- (boundary)", () => expect(gradeMatchesFilter("C-", "grade-ge-c-minus")).toBe(true));
    it("does not match D", () => expect(gradeMatchesFilter("D", "grade-ge-c-minus")).toBe(false));
    it("does not match F", () => expect(gradeMatchesFilter("F", "grade-ge-c-minus")).toBe(false));
  });

  describe("grade-le-d (D and below)", () => {
    it("matches D (boundary)", () => expect(gradeMatchesFilter("D", "grade-le-d")).toBe(true));
    it("matches F", () => expect(gradeMatchesFilter("F", "grade-le-d")).toBe(true));
    it("does not match C-", () => expect(gradeMatchesFilter("C-", "grade-le-d")).toBe(false));
    it("does not match C", () => expect(gradeMatchesFilter("C", "grade-le-d")).toBe(false));
  });
});
