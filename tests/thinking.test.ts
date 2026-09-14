import { describe, expect, it } from "vitest";
import { ALL_FENCES, FenceSplitter, type Split, stripThinking } from "../src/thinking.ts";

/** Every piece fed in one at a time, with what came out of each push and of the finish. */
const split = (pieces: string[], splitter = new FenceSplitter()) => {
  const parts: Split[] = [];
  for (const piece of pieces) parts.push(...splitter.push(piece));
  parts.push(...splitter.finish());
  return { parts, output: splitter.output, reasoning: splitter.reasoning };
};

describe("FenceSplitter", () => {
  it("routes a fence to reasoning and the rest to output", () => {
    const { parts, output, reasoning } = split(["<think>hmm</think>answer"]);
    expect(parts).toEqual([
      { kind: "reasoning", text: "hmm" },
      { kind: "output", text: "answer" },
    ]);
    expect([output, reasoning]).toEqual(["answer", "hmm"]);
  });

  it("holds a tag split across chunks until it is settled", () => {
    // Every boundary a tag can be cut at, open and close alike.
    const reply = "<think>weighing</think>answer";
    for (let cut = 1; cut < reply.length; cut++) {
      const { output, reasoning } = split([reply.slice(0, cut), reply.slice(cut)]);
      expect([output, reasoning]).toEqual(["answer", "weighing"]);
    }
    expect(split([...reply]).output).toBe("answer");
  });

  it("releases a held tail that turned out not to be a tag", () => {
    const { parts, output } = split(["a <", "b"]);
    expect(output).toBe("a <b");
    expect(parts.map((part) => part.kind)).toEqual(["output", "output"]);
    expect(split(["x <thi"]).output).toBe("x <thi");
  });

  it("leaves a fence cut off at the ceiling as reasoning, not as the answer", () => {
    expect(split(["<think>weighing it up and running out of"])).toMatchObject({
      output: "",
      reasoning: "weighing it up and running out of",
    });
  });

  it("moves what came before a closing tag with no opening one into reasoning", () => {
    // The template put `<think>` at the end of the prompt.
    expect(split(["weighing", " it</think>", "answer"])).toMatchObject({
      output: "answer",
      reasoning: "weighing it",
    });
  });

  it("starts inside the fence when told the template opened it", () => {
    const { parts } = split(
      ["weighing</think>answer"],
      new FenceSplitter(undefined, { startInside: true }),
    );
    expect(parts).toEqual([
      { kind: "reasoning", text: "weighing" },
      { kind: "output", text: "answer" },
    ]);
  });

  it("reads gpt-oss harmony and Kimi fences by default, and drops the framing", () => {
    expect(
      split([
        "<|channel|>analysis<|message|>think<|end|>",
        "<|start|>assistant<|channel|>final<|message|>answer<|return|>",
      ]),
    ).toMatchObject({ output: "answer", reasoning: "think" });
    expect(split(["◁think▷hmm◁/think▷answer"])).toMatchObject({
      output: "answer",
      reasoning: "hmm",
    });
  });

  it("leaves the plain-word fences alone unless asked for them", () => {
    const quoted = "<thinking>a tag in a document</thinking>";
    expect(split([quoted]).output).toBe(quoted);
    expect(split([quoted], new FenceSplitter(ALL_FENCES)).output).toBe("");
    expect(split(["<think>x</think>y"], new FenceSplitter([])).output).toBe("<think>x</think>y");
  });
});

describe("stripThinking", () => {
  it("takes out every known fence, the plain-word ones included", () => {
    expect(stripThinking("before<think>x</think>after")).toBe("beforeafter");
    expect(stripThinking("<reasoning>x</reasoning>answer")).toBe("answer");
    expect(stripThinking("weighing</think>answer")).toBe("answer");
  });
});
