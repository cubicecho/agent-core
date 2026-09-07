import { describe, expect, it } from "vitest";
import { clean, estimateTokens, listLines, parseJson } from "../src/side-task.ts";

describe("clean", () => {
  it("strips the decoration models put around a short answer", () => {
    expect(clean('  "Python Subprocess Pipe Hang."  ')).toBe("Python Subprocess Pipe Hang");
    expect(clean("- try the other approach")).toBe("try the other approach");
    expect(clean("2. second suggestion")).toBe("second suggestion");
    expect(clean("`code`")).toBe("code");
  });

  it("leaves an already-clean line alone", () => {
    expect(clean("Mutex vs Semaphore Differences")).toBe("Mutex vs Semaphore Differences");
  });
});

describe("parseJson", () => {
  it("reads a bare array", () => {
    expect(parseJson<string[]>('["a", "b"]')).toEqual(["a", "b"]);
  });

  it("reads a fenced block", () => {
    expect(parseJson<string[]>('```json\n["a"]\n```')).toEqual(["a"]);
  });

  it("reads an array a model wrapped in prose", () => {
    expect(parseJson<string[]>('Sure! Here you go:\n["a", "b"]\nHope that helps.')).toEqual([
      "a",
      "b",
    ]);
  });

  it("reads an object", () => {
    expect(parseJson<{ a: number }>('{"a": 1}')).toEqual({ a: 1 });
  });

  it("gives up rather than throwing", () => {
    expect(parseJson("no json here")).toBeUndefined();
    expect(parseJson("[unterminated")).toBeUndefined();
  });
});

describe("estimateTokens", () => {
  it("approximates four characters to the token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(4000))).toBe(1000);
  });
});

describe("listLines", () => {
  it("strips the bullets and quotes a model decorates a list with", () => {
    const text = `1. "How do I update statistics?"\n- What is selectivity?\n* Can I force an index scan?`;
    expect(listLines(text, 3, 80)).toEqual([
      "How do I update statistics?",
      "What is selectivity?",
      "Can I force an index scan?",
    ]);
  });

  it("drops blank lines and anything too long to read at a glance", () => {
    const text = `Short one\n\n${"x".repeat(90)}\nAlso short`;
    expect(listLines(text, 5, 80)).toEqual(["Short one", "Also short"]);
  });

  it("keeps at most the requested number", () => {
    expect(listLines("a\nb\nc\nd", 2, 80)).toEqual(["a", "b"]);
  });
});
