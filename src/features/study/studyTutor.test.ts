import { describe, expect, it } from "vitest";
import { temporaryPracticeFromResponse, wantsTemporaryPractice } from "./studyTutor";

describe("temporary tutor practice", () => {
  it("recognizes a natural request for more practice without requiring a special command", () => {
    expect(wantsTemporaryPractice("Could we add a few more questions like this?")).toBe(true);
    expect(wantsTemporaryPractice("Can you give me a hint for this step?")).toBe(false);
  });

  it("keeps temporary answers private unless the model supplied a complete question and answer pair", () => {
    expect(temporaryPracticeFromResponse('{"problems":[{"question":"Solve 3x + 5 = 20","answer":"x = 5"},{"question":"","answer":"ignore"}]}')).toEqual([{ question: "Solve 3x + 5 = 20", answer: "x = 5" }]);
  });
});
