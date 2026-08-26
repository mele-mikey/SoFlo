export type TemporaryPracticeProblem = { question: string; answer: string };

export function wantsTemporaryPractice(message: string) {
  return /\b(?:more|extra|additional|another|new|fresh)\b.{0,42}\b(?:question|questions|problem|problems|practice)\b|\b(?:question|questions|problem|problems|practice)\b.{0,42}\b(?:more|extra|additional|another|new|fresh)\b/i.test(message);
}

export function temporaryPracticeFromResponse(raw: string): TemporaryPracticeProblem[] {
  try {
    const parsed = JSON.parse(raw) as { problems?: unknown };
    if (!Array.isArray(parsed.problems)) return [];
    return parsed.problems.flatMap((problem) => {
      if (!problem || typeof problem !== "object") return [];
      const item = problem as { question?: unknown; answer?: unknown };
      const question = typeof item.question === "string" ? item.question.trim() : "";
      const answer = typeof item.answer === "string" ? item.answer.trim() : "";
      return question && answer ? [{ question, answer }] : [];
    }).slice(0, 4);
  } catch { return []; }
}
