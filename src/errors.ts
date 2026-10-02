import type OpenAI from "openai";
import { ContextOverflow } from "./retry.ts";
import type { TurnUsage } from "./stream.ts";
import type { ToolCallOutcome } from "./tool-calls.ts";

/**
 * What went wrong, as a string.
 *
 * Almost everything caught here ends up in a run row, a tool result or a log line, and a
 * `catch` binds `unknown` — so the same three-branch ternary was being written at every site
 * that had to say what happened.
 *
 * @param error Whatever a `catch` bound. Anything that is not an `Error` is stringified.
 */
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * A run as it stood when `runAgentLoop` gave up on it.
 *
 * The loop works on its own copy of the transcript and hands it back only on success, so without
 * this a spent budget, a stop or a refused request took every step before it along — steps whose
 * assistant turns and tool results were real, and that a host storing its transcript has to keep.
 */
export interface AgentLoopFailure {
  /**
   * The transcript, as the result's `messages` would have been: every assistant turn and tool
   * result the run added, and no system prompt. Well-formed — a call the run was stopped during
   * has a result saying so. The reply of a request that was in flight is not in it.
   */
  messages: OpenAI.ChatCompletionMessageParam[];
  /** Summed over the turns that came back. A request that failed or was stopped adds nothing. */
  usage: TurnUsage;
  /** Every call that was made, in order. One the run was stopped during is `ok: false`. */
  toolCalls: ToolCallOutcome[];
  /** What was loaded when the run failed, for `carryOver`. Empty in eager and proxied modes. */
  loaded: string[];
  /** The tools the model had called, `load_tools` excluded. */
  used: string[];
}

/**
 * What `runAgentLoop` throws, carrying the run as it stood and what was caught as `cause`.
 *
 * Its own class rather than fields hung on the error that was caught, because a stop throws the
 * signal's reason and that is one object for every run under the signal. The message is the
 * cause's own, so a host that logs `errorMessage(error)` logs what it always did. A stop is told
 * the way it was before — by the signal the host aborted, not by the class of what came out.
 */
export class AgentLoopError extends Error implements AgentLoopFailure {
  override readonly name: string = "AgentLoopError";
  readonly messages: OpenAI.ChatCompletionMessageParam[];
  readonly usage: TurnUsage;
  readonly toolCalls: ToolCallOutcome[];
  readonly loaded: string[];
  readonly used: string[];

  /**
   * @param message What went wrong — the cause's own message, where there is a cause.
   * @param run The run as it stood. Held, not copied.
   * @param options The standard `cause`: what the loop caught, absent where the loop itself gave up.
   */
  constructor(message: string, run: AgentLoopFailure, options?: ErrorOptions) {
    super(message, options);
    this.messages = run.messages;
    this.usage = run.usage;
    this.toolCalls = run.toolCalls;
    this.loaded = run.loaded;
    this.used = run.used;
  }
}

/**
 * `maxToolIterations` was spent with the model still asking for tools.
 *
 * Named so a host can tell it from a failure without matching the message, which is the same
 * sentence it has always been. There is no `cause`: nothing was caught, the loop stopped itself.
 */
export class ToolIterationLimit extends AgentLoopError {
  override readonly name: string = "ToolIterationLimit";
}

/**
 * A `ContextOverflow` out of `runAgentLoop`, carrying the run as it stood.
 *
 * A subclass of `ContextOverflow` rather than an `AgentLoopError` around one, because
 * `instanceof ContextOverflow` is how a caller knows to compact and send again, and wrapping
 * would have made that test quietly false. The overflow the loop caught is the `cause`, and the
 * endpoint's own error, where there was one, is that one's `cause` in turn.
 */
export class AgentLoopOverflow extends ContextOverflow implements AgentLoopFailure {
  readonly messages: OpenAI.ChatCompletionMessageParam[];
  readonly usage: TurnUsage;
  readonly toolCalls: ToolCallOutcome[];
  readonly loaded: string[];
  readonly used: string[];

  /**
   * @param message The overflow's own message.
   * @param run The run as it stood. Held, not copied.
   * @param options The standard `cause`: the `ContextOverflow` the loop caught.
   */
  constructor(message: string, run: AgentLoopFailure, options?: ErrorOptions) {
    super(message, options);
    this.messages = run.messages;
    this.usage = run.usage;
    this.toolCalls = run.toolCalls;
    this.loaded = run.loaded;
    this.used = run.used;
  }
}

/**
 * The run a failed `runAgentLoop` left behind, read off whatever it threw, or nothing.
 *
 * Two classes carry it — an overflow has to stay a `ContextOverflow` and so cannot also be an
 * `AgentLoopError` — and a `catch` that only wants the transcript should not have to name both.
 *
 * @param error Whatever a `catch` around `runAgentLoop` bound. Anything the loop did not throw
 * answers `undefined`.
 */
export const failedRun = (error: unknown): AgentLoopFailure | undefined =>
  error instanceof AgentLoopError || error instanceof AgentLoopOverflow ? error : undefined;
