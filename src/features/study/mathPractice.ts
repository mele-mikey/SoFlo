import { evaluate, simplify } from "mathjs";

export type MathInterval = {
  lower: string;
  upper: string;
  lowerInclusive: boolean;
  upperInclusive: boolean;
  variable: string;
};

export function normalizedMath(value: string) {
  return value
    .trim()
    .replace(/[\u2212\u2013\u2014]/g, "-")
    .replace(/\\leq?/g, "<=")
    .replace(/\\geq?/g, ">=")
    .replace(/\\neq?/g, "!=")
    .replace(/\\sqrt/g, "sqrt")
    .replace(/\u2264/g, "<=")
    .replace(/\u2265/g, ">=")
    .replace(/\u00d7/g, "*")
    .replace(/\u00f7/g, "/")
    .replace(/\u221a/g, "sqrt")
    .replace(/\s+/g, "");
}

const instructionWords = /\b(?:write|solve|simplify|find|graph|what|which|evaluate|factor|convert|give|determine|use|answer|interval|inequality)\b/i;

export function isStandaloneMathExpression(value: string) {
  const raw = value.trim();
  const normalized = normalizedMath(raw);
  if (!normalized || /[.!?]/.test(raw) || instructionWords.test(raw)) return false;
  return /[=<>+*/^]|^[[(]/.test(normalized);
}

export function mathExpression(value: string) {
  const raw = value.trim();
  const wrapped = raw.match(/\\\((.*?)\\\)|\\\[(.*?)\\\]|\$\$(.*?)\$\$|\$(.*?)\$/s);
  if (wrapped) return wrapped[1] ?? wrapped[2] ?? wrapped[3] ?? wrapped[4] ?? "";
  if (isStandaloneMathExpression(raw)) return raw;
  const interval = raw.match(/(?:\[|\()\s*[^,\])]+\s*,\s*[^,\])]+\s*(?:\]|\))/);
  if (interval) return interval[0];
  const chained = raw.match(/-?(?:\d+(?:\.\d+)?|\.\d+)\s*(?:<=|>=|<|>|\u2264|\u2265)\s*[A-Za-z]\s*(?:<=|>=|<|>|\u2264|\u2265)\s*-?(?:\d+(?:\.\d+)?|\.\d+)/);
  return chained?.[0] ?? "";
}

export function parseMathInterval(value: string): MathInterval | null {
  const expression = normalizedMath(value);
  const literal = expression.match(/^(\[|\()(.+),(.+)(\]|\))$/);
  if (literal && literal[2].trim() && literal[3].trim()) {
    return {
      lower: literal[2].trim(),
      upper: literal[3].trim(),
      lowerInclusive: literal[1] === "[",
      upperInclusive: literal[4] === "]",
      variable: "x",
    };
  }
  const chained = expression.match(/^(.+?)(<=|<)([A-Za-z])((?:<=)|<)(.+)$/);
  if (!chained || !chained[1].trim() || !chained[5].trim()) return null;
  return {
    lower: chained[1].trim(),
    upper: chained[5].trim(),
    lowerInclusive: chained[2] === "<=",
    upperInclusive: chained[4] === "<=",
    variable: chained[3],
  };
}

function sameMathValue(left: string, right: string) {
  const a = normalizedMath(left);
  const b = normalizedMath(right);
  if (a === b) return true;
  try {
    if (simplify(`(${a})-(${b})`).toString() === "0") return true;
    for (const x of [-4, -2, -1, 0, 1, 2, 4]) {
      const difference = Number(evaluate(`(${a})-(${b})`, { x }));
      if (!Number.isFinite(difference) || Math.abs(difference) > 0.00001) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function equivalentMath(answer: string, target: string) {
  const left = normalizedMath(answer);
  const right = normalizedMath(target);
  if (!left || !right) return false;
  const answerInterval = parseMathInterval(left);
  const targetInterval = parseMathInterval(right);
  if (answerInterval || targetInterval) {
    return Boolean(
      answerInterval &&
        targetInterval &&
        answerInterval.variable === targetInterval.variable &&
        answerInterval.lowerInclusive === targetInterval.lowerInclusive &&
        answerInterval.upperInclusive === targetInterval.upperInclusive &&
        sameMathValue(answerInterval.lower, targetInterval.lower) &&
        sameMathValue(answerInterval.upper, targetInterval.upper),
    );
  }
  return sameMathValue(left, right);
}

export function finiteMathValue(value: string) {
  try {
    const parsed = Number(evaluate(normalizedMath(value)));
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
