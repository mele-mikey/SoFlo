import { describe, expect, it } from "vitest";
import {
  equivalentMath,
  mathExpression,
  parseMathInterval,
} from "./mathPractice";

describe("math practice intervals", () => {
  it("keeps prose out of the display expression while retaining an embedded interval", () => {
    expect(mathExpression("Write the interval as an inequality. [-3, 9)")).toBe("[-3, 9)");
  });

  it("recognizes a two-sided interval inequality including its negative bound", () => {
    expect(parseMathInterval("-3≤x<9")).toEqual({
      lower: "-3",
      upper: "9",
      lowerInclusive: true,
      upperInclusive: false,
      variable: "x",
    });
  });

  it("accepts equivalent interval and chained-inequality answers", () => {
    expect(equivalentMath("-3≤x<9", "[-3,9)")).toBe(true);
    expect(equivalentMath("-3<x<9", "[-3,9)")).toBe(false);
  });
});
