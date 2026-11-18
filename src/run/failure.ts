import type OpenAI from 'openai';
import type { TokenLedger } from '../context/ledger.ts';
import { ContextOverflow } from '../wire/retry.ts';
import type { LoopUsage, PartialTurn } from '../wire/stream.ts';
import type { RunArtifact, ToolCallOutcome } from './dispatch.ts';

/**
 * What a failed exchange leaves behind: the run as it stood, carried on what `runAgentLoop` throws
 * and read back off it.
 */

/**
 * A run as it stood when `runAgentLoop` gave up on it.
 *
 * @remarks
 * The loop works on its own copy of the transcript and hands it back only on success, so without
 * this a spent budget, a stop or a refused request took every step before it along — steps whose
 * assistant turns and tool results were real, and that a host storing its transcript has to keep.
 */
export interface AgentLoopFailure {
  /**
   * The transcript, as the result's `messages` would have been: every assistant turn and tool
   * result the run added, and no system prompt. Well-formed — a call the run was stopped during
   * has a result saying so. The reply of a request that was in flight is not in it: see `partial`.
   */
  messages: OpenAI.ChatCompletionMessageParam[];
  /**
   * What the request in flight had said when the run stopped or failed — a stop, the endpoint
   * going silent, a stream that broke — continuations joined on. Absent where no request was in
   * flight or it had said nothing.
   *
   * @remarks
   * Not in `messages`, because it is not a turn an endpoint will take back. It is what a person
   * watching had been shown, and whether it belongs in the history is the host's call.
   */
  partial?: PartialTurn;
  /**
   * Summed over the turns that came back, as the result's `usage` would have said it. A request
   * that failed or was stopped adds nothing.
   */
  usage: LoopUsage;
  /** Every call that was made, in order. One the run was stopped during is `ok: false`. */
  toolCalls: ToolCallOutcome[];
  /**
   * What the calls that came back linked to, as the result's `artifacts` would have said it: a
   * failed run's writes were still made. `runAgentLoop` always sets it; optional so a failure
   * built before it existed still compiles.
   */
  artifacts?: RunArtifact[];
  /** What was loaded when the run failed, for `carryOver`. Empty in eager and proxied modes. */
  loaded: string[];
  /** The tools the model had called, `load_tools` excluded. */
  used: string[];
  /** The shortlist the run opened with, as the result's `preselected` would have said it. */
  preselected: string[];
  /**
   * What each step's request reported its prompt as, indexed into `messages` above, as the
   * result's `ledger` would have said it: the entries of a `ledger` passed in come first. A request
   * that failed reported nothing, and adds no entry. `runAgentLoop` always sets it; optional so a
   * failure built before it existed still compiles.
   */
  ledger?: TokenLedger;
  /**
   * The remote agent's own run id, as its progress events named it, for a run on a
   * `remoteAgent` config. Absent elsewhere, and where no event had arrived.
   */
  remoteRunId?: string;
}

/** The run as a failure holds it: `artifacts` and `ledger` always set. */
type CarriedRun = Omit<AgentLoopFailure, 'artifacts' | 'ledger'> & { artifacts: RunArtifact[]; ledger: TokenLedger };

/**
 * Copies a run onto the failure that carries it, in place.
 *
 * @param failure - The failure being built, from its constructor. Written to.
 * @param run - The run as it stood. Held, not copied: its lists become the failure's.
 *
 * @remarks
 * One copy for both classes, which cannot share a base: an overflow has to stay a
 * `ContextOverflow`.
 */
function assignRun(failure: CarriedRun, run: AgentLoopFailure): void {
  failure.messages = run.messages;
  if (run.partial) {
    failure.partial = run.partial;
  }
  failure.usage = run.usage;
  failure.toolCalls = run.toolCalls;
  failure.artifacts = run.artifacts ?? [];
  failure.loaded = run.loaded;
  failure.used = run.used;
  failure.preselected = run.preselected;
  failure.ledger = run.ledger ?? [];
  if (run.remoteRunId !== undefined) {
    failure.remoteRunId = run.remoteRunId;
  }
}

/**
 * What `runAgentLoop` throws, carrying the run as it stood and what was caught as `cause`.
 *
 * @remarks
 * Its own class rather than fields hung on the error that was caught, because a stop throws the
 * signal's reason and that is one object for every run under the signal. The message is the
 * cause's own, so a host that logs `errorMessage(error)` logs what it always did. A stop is told
 * the way it was before — by the signal the host aborted, not by the class of what came out.
 */
export class AgentLoopError extends Error implements AgentLoopFailure {
  override readonly name: string = 'AgentLoopError';
  // Set by `assignRun`, which the constructor calls; declared here so each is a public field.
  readonly messages!: OpenAI.ChatCompletionMessageParam[];
  readonly partial?: PartialTurn;
  readonly usage!: LoopUsage;
  readonly toolCalls!: ToolCallOutcome[];
  readonly artifacts!: RunArtifact[];
  readonly loaded!: string[];
  readonly used!: string[];
  readonly preselected!: string[];
  readonly ledger!: TokenLedger;
  readonly remoteRunId?: string;

  /**
   * @param message - What went wrong — the cause's own message, where there is a cause.
   * @param run - The run as it stood. Held, not copied.
   * @param [options] - The standard `cause`: what the loop caught, absent where the loop itself gave up.
   */
  constructor(message: string, run: AgentLoopFailure, options?: ErrorOptions) {
    super(message, options);
    assignRun(this, run);
  }
}

/**
 * `maxToolIterations` was spent with the model still asking for tools.
 *
 * @remarks
 * Named so a host can tell it from a failure without matching the message, which is the same
 * sentence it has always been. There is no `cause`: nothing was caught, the loop stopped itself.
 */
export class ToolIterationLimit extends AgentLoopError {
  override readonly name: string = 'ToolIterationLimit';
}

/**
 * A `ContextOverflow` out of `runAgentLoop`, carrying the run as it stood.
 *
 * @remarks
 * A subclass of `ContextOverflow` rather than an `AgentLoopError` around one, because
 * `instanceof ContextOverflow` is how a caller knows to compact and send again, and wrapping
 * would have made that test quietly false. The overflow the loop caught is the `cause`, and the
 * endpoint's own error, where there was one, is that one's `cause` in turn.
 */
export class AgentLoopOverflow extends ContextOverflow implements AgentLoopFailure {
  // Set by `assignRun`, which the constructor calls; declared here so each is a public field.
  readonly messages!: OpenAI.ChatCompletionMessageParam[];
  readonly partial?: PartialTurn;
  readonly usage!: LoopUsage;
  readonly toolCalls!: ToolCallOutcome[];
  readonly artifacts!: RunArtifact[];
  readonly loaded!: string[];
  readonly used!: string[];
  readonly preselected!: string[];
  readonly ledger!: TokenLedger;
  readonly remoteRunId?: string;

  /**
   * @param message - The overflow's own message.
   * @param run - The run as it stood. Held, not copied.
   * @param [options] - The standard `cause`: the `ContextOverflow` the loop caught.
   */
  constructor(message: string, run: AgentLoopFailure, options?: ErrorOptions) {
    super(message, options);
    assignRun(this, run);
  }
}

/**
 * The run a failed `runAgentLoop` left behind, read off whatever it threw, or nothing.
 *
 * @param error - Whatever a `catch` around `runAgentLoop` bound. Anything the loop did not throw
 * answers `undefined`.
 * @returns The error itself, read as the run it carries — the same object, not a copy.
 *
 * @remarks
 * Two classes carry it — an overflow has to stay a `ContextOverflow` and so cannot also be an
 * `AgentLoopError` — and a `catch` that only wants the transcript should not have to name both.
 */
export const failedRun = (error: unknown): AgentLoopFailure | undefined =>
  error instanceof AgentLoopError || error instanceof AgentLoopOverflow ? error : undefined;
