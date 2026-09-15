/**
 * Telling a model's scratchpad from its answer when both arrive in `content`.
 *
 * A server with a reasoning parser puts the deliberation in a field of its own. One without — a
 * llama.cpp started with `--reasoning-format none`, a model whose template has no parser, most
 * distills on any server — leaves it fenced inline, and then it is shown as output, stored in
 * the transcript and sent back on the next turn, where it costs context and teaches the model to
 * keep doing it. This is the one table of fences both the stream and the side tasks read.
 */

/** One way a model marks off its scratchpad inside `content`. */
export interface Fence {
  open: string;
  close: string;
}

/** DeepSeek, Qwen3, QwQ and most distills. */
export const THINK_FENCE: Fence = { open: "<think>", close: "</think>" };

/**
 * The fences nobody writes by accident, and so the ones `streamTurn` reads by default.
 *
 * `<think>` opening a reply is never meant as output, and the other two are made of tokens that
 * only a model's template produces: gpt-oss's harmony analysis channel, served raw, and Kimi's.
 */
export const DEFAULT_FENCES: readonly Fence[] = [
  THINK_FENCE,
  { open: "<|channel|>analysis<|message|>", close: "<|end|>" },
  { open: "◁think▷", close: "◁/think▷" },
];

/**
 * Every fence known, including the two plain-word ones some fine-tunes and prompt-instructed
 * models use. Those can also be text the model is quoting, so they are opt-in for a stream,
 * and on for a side task, whose answer is too short to be quoting anything.
 */
export const ALL_FENCES: readonly Fence[] = [
  ...DEFAULT_FENCES,
  { open: "<thinking>", close: "</thinking>" },
  { open: "<reasoning>", close: "</reasoning>" },
];

/**
 * Framing that is neither scratchpad nor answer, dropped wherever it turns up outside a fence.
 *
 * Only harmony has any: after the analysis channel closes, raw gpt-oss output announces the final
 * channel before the answer and ends with a return token.
 */
const FRAMING: Readonly<Record<string, readonly string[]>> = {
  "<|channel|>analysis<|message|>": [
    "<|start|>assistant",
    "<|channel|>final<|message|>",
    "<|return|>",
  ],
};

/** A piece of `content`, said to be one or the other. */
export interface Split {
  kind: "reasoning" | "output";
  text: string;
}

/** What `FenceSplitter` takes besides its fences. */
export interface FenceSplitterOptions {
  /**
   * The template already opened the first fence in the prompt, so the reply starts inside it.
   *
   * Several chat templates end the prompt with `<think>` rather than leaving the model to write
   * it. Without this the splitter still catches it once `</think>` arrives, and moves what came
   * before into `reasoning`, but a watcher will have been shown it as output by then.
   */
  startInside?: boolean;
}

/**
 * A state machine over a stream of `content` that routes fenced text to reasoning.
 *
 * The reference shape is Vercel's `extractReasoningMiddleware`. A tag can be split across chunks,
 * so the tail of each push that could be the start of one is held until the next push settles
 * it; `finish` releases it. A reply cut off mid-scratchpad ends with the fence still open and its
 * text still reasoning, rather than promoted to the answer.
 *
 * A closing tag with no opening one is the template having opened it in the prompt. When no
 * fence has been seen yet, everything before it becomes reasoning retroactively in `output` and
 * `reasoning`, though what was already handed out as output cannot be taken back.
 */
export class FenceSplitter {
  /** The answer so far, with every fence taken out. */
  output = "";
  /** Everything that was inside a fence so far. */
  reasoning = "";

  readonly #fences: readonly Fence[];
  readonly #markers: string[];
  #inside: Fence | undefined;
  #seenFence: boolean;
  #held = "";

  /**
   * @param fences The fences to read, `DEFAULT_FENCES` unless given; an empty list passes
   *   everything through as output.
   * @param options Whether the reply starts inside the first fence.
   */
  constructor(
    fences: readonly Fence[] = DEFAULT_FENCES,
    { startInside }: FenceSplitterOptions = {},
  ) {
    this.#fences = fences;
    this.#markers = fences.flatMap((fence) => [
      fence.open,
      fence.close,
      ...(FRAMING[fence.open] ?? []),
    ]);
    this.#inside = startInside ? fences[0] : undefined;
    this.#seenFence = this.#inside !== undefined;
  }

  /**
   * Reads one more piece of content, returning what it settled, in order.
   *
   * @param text The next delta.
   */
  push(text: string): Split[] {
    const parts: Split[] = [];
    let rest = this.#held + text;
    this.#held = "";
    while (rest) {
      const found = this.#next(rest);
      if (!found) {
        const keep = this.#partialTail(rest);
        this.#emit(parts, rest.slice(0, rest.length - keep));
        this.#held = rest.slice(rest.length - keep);
        break;
      }
      this.#emit(parts, rest.slice(0, found.at));
      rest = rest.slice(found.at + found.marker.length);
      this.#take(found.marker);
    }
    return parts;
  }

  /** Releases whatever was held back as a possible tag, now that no more is coming. */
  finish(): Split[] {
    const parts: Split[] = [];
    this.#emit(parts, this.#held);
    this.#held = "";
    return parts;
  }

  /** The earliest marker that means something in the current state. */
  #next(text: string): { at: number; marker: string } | undefined {
    const candidates = this.#inside ? [this.#inside.close] : this.#markers;
    let best: { at: number; marker: string } | undefined;
    for (const marker of candidates) {
      const at = text.indexOf(marker);
      if (at === -1) continue;
      if (!best || at < best.at || (at === best.at && marker.length > best.marker.length))
        best = { at, marker };
    }
    return best;
  }

  /** How much of the end of `text` could be the beginning of a marker. */
  #partialTail(text: string): number {
    const candidates = this.#inside ? [this.#inside.close] : this.#markers;
    let keep = 0;
    for (const marker of candidates)
      for (let length = Math.min(marker.length - 1, text.length); length > keep; length--)
        if (text.endsWith(marker.slice(0, length))) {
          keep = length;
          break;
        }
    return keep;
  }

  #take(marker: string) {
    if (this.#inside) {
      this.#inside = undefined;
      return;
    }
    const opened = this.#fences.find((fence) => fence.open === marker);
    if (opened) {
      this.#inside = opened;
      this.#seenFence = true;
      return;
    }
    // A close with no open. The first time, the template opened it in the prompt; after a fence
    // has been read, it is a stray tag and only dropped.
    const closes = this.#fences.some((fence) => fence.close === marker);
    if (closes && !this.#seenFence) {
      this.reasoning += this.output;
      this.output = "";
    }
    if (closes) this.#seenFence = true;
  }

  #emit(parts: Split[], text: string) {
    if (!text) return;
    const kind = this.#inside ? "reasoning" : "output";
    this[kind] += text;
    const last = parts.at(-1);
    if (last?.kind === kind) last.text += text;
    else parts.push({ kind, text });
  }
}

/**
 * What is left of a complete reply once every scratchpad is taken out of it.
 *
 * @param text The whole reply.
 * @param fences The fences to read, every known one unless given.
 */
export function stripThinking(text: string, fences: readonly Fence[] = ALL_FENCES): string {
  const splitter = new FenceSplitter(fences);
  splitter.push(text);
  splitter.finish();
  return splitter.output;
}
