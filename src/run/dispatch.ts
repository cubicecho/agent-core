import type { ResourceLink } from '../wire/tool-calls.ts';

/**
 * What the loop and a dispatcher say to each other: the call it is handed, the answer it gives,
 * what the run makes of that answer, and what a call produced.
 */

/**
 * One call the model made, as `dispatch` and `onToolCall` are handed it.
 *
 * @remarks
 * A `call_tool` arrives as the tool it names — that tool's name and arguments, under the
 * `call_tool`'s id — so a dispatcher is the same in every discovery mode.
 */
export interface ToolCallRequest {
  id: string;
  name: string;
  /**
   * Parsed by `parseToolArguments`, repairs and all. Empty for a call whose arguments could not be
   * read, which only `onToolCall` is ever handed.
   */
  args: Record<string, unknown>;
  /**
   * The arguments as the model wrote them, before any repair. Through `call_tool`, the inner
   * arguments as JSON text. For a call recovered from the reply's text, the arguments recovery read
   * out of it, as JSON text: the words the model wrote are the reply's content, which `onMessage`'s
   * `raw` message carries.
   */
  raw: string;
  /**
   * Whether `args` took a repair to read: true where `raw` does not parse, as written, to the JSON
   * object `args` holds — near-JSON, or JSON inside a string — and for every call recovered from
   * text, which the model never sent as a call. False for blank arguments, which every reader takes
   * as none, and for arguments that could not be read at all. Through `call_tool`, whether the
   * `call_tool`'s own arguments did.
   *
   * @remarks
   * A host that shows or stores what the model said reads `raw` where this is true. Whitespace is
   * not a repair, though the replayed arguments are re-serialised either way. `runAgentLoop` always
   * sets it; optional so a request built before it existed still compiles.
   */
  repaired?: boolean;
}

/** What one tool call did, in the order the model asked. */
export interface ToolCallOutcome {
  /**
   * The id the model's reply gave the call, which is what tells two calls to one tool apart.
   * Distinct within a step — `streamTurn` mints one where the server sent none or repeated one —
   * but nothing stops a server using the same id again in a later step. `runAgentLoop` always
   * sets it; optional so an outcome built before it existed still compiles.
   */
  id?: string;
  /** The tool that was called. For a `call_tool`, the tool it named. */
  name: string;
  /** False when the arguments did not parse, the tool threw, or `load_tools` loaded nothing. */
  ok: boolean;
}

/**
 * One call's whole answer, as `onToolResult` is handed it.
 *
 * @remarks
 * The `tool-result` event carries the same answer cut by `preview`, which is right for a readout
 * and wrong for a host that renders or stores the result: this is the text the model reads.
 */
export interface ToolCallResult extends ToolCallOutcome {
  id: string;
  /**
   * What went into the transcript for this call, uncut: what the tool returned, what it threw, the
   * `load_tools` answer, or why the arguments could not be read.
   */
  content: string;
  /**
   * What the dispatcher's answer said the call produced, as it said it. Absent where it said
   * nothing, and always for a call that threw. A deduplicated repeat carries the first call's.
   */
  links?: ResourceLink[];
}

/**
 * A dispatcher's answer when it has more to say than the text: what the model reads, and what the
 * call produced for the host.
 *
 * @remarks
 * A link meant for the model alone — one whose MCP `audience` leaves out `"user"` — is the
 * dispatcher's to drop, since that is MCP's rule and this package knows nothing of MCP.
 */
export interface ToolAnswer {
  /** What goes into the transcript, exactly as a string answer does. */
  text: string;
  /** What the call produced, in the order the tool gave them. Never sent to the model. */
  links?: ResourceLink[];
  /**
   * Ends the run once this step's calls are answered: no further request is sent, and the loop
   * resolves with `ended` rather than throwing. An object says why, for the host and its `done`.
   *
   * @remarks
   * The step's other calls still run and are answered, so the transcript stays one an endpoint
   * will take back. For a tool whose call is the end of the job — handing off, asking a person —
   * where the alternative is an abort, which the loop reads as a failure.
   */
  end?: boolean | { reason: string };
}

/** The call that ended a run through its answer's `end`, as `AgentLoopResult.ended` says it. */
export interface EndedBy {
  /** The call's id. */
  callId: string;
  /** The tool, under the name it was announced by: for a `call_tool`, the tool it names. */
  name: string;
  /** Why, where the answer said: absent for `end: true`. */
  reason?: string;
}

/**
 * One log message a tool's server sent while the call was running, as `ToolCallReport.log` is
 * handed it.
 *
 * @remarks
 * The params of MCP's `notifications/message`, declared structurally rather than imported, as
 * `ResourceLink` is: agent-mcp-pool's `ServerLogEntry` has these field names, so its `onLog`
 * takes `report.log` as it stands. `level` is a plain string so a server's own word is shown
 * rather than refused.
 */
export interface ServerLogEntry {
  /** How serious the server says it is: one of `ServerLogLevel`, by the spec. */
  level: string;
  /** The server's name for the part of itself that logged, where it gave one. */
  logger?: string;
  /** Whatever the server sent: a string usually, any JSON value by the spec. */
  data: unknown;
}

/**
 * What a dispatcher may tell the run about the call it is making, besides its answer.
 *
 * @remarks
 * An object rather than a fourth and fifth argument, so what a call can report grows here —
 * progress is the next one — without `dispatch` changing again. Every member is a bound function,
 * so it can be handed on alone: `onLog: report.log`. What is reported reaches the run's events
 * and never the transcript: it is for the person watching, not the model.
 */
export interface ToolCallReport {
  /**
   * Tells watchers of a server's log message, as a `server-log` event for this call. Heard after
   * the call has answered, it is dropped: the event would land after the result it explains.
   */
  log: (entry: ServerLogEntry) => void;
}

/**
 * How the loop came to know of an artifact, most trusted first.
 *
 * @remarks
 * `linked` is a call's answer saying so, and is the only one that takes no guessing. `declared` is
 * the model naming it through `record_artifact`, believed only where some call in the run touched
 * the location. `detected` is the loop reading a successful call as a write: a verb at the front
 * of its name and a path in its arguments. The last two are opt-in, through `artifacts` on the
 * loop's options.
 */
export const ArtifactSource = {
  Linked: 'linked',
  Declared: 'declared',
  Detected: 'detected',
} as const;

/** Any one of the sources in `ArtifactSource`. */
export type ArtifactSource = (typeof ArtifactSource)[keyof typeof ArtifactSource];

/** What the run's last write did to an artifact's location, as a detection read it. */
export const ArtifactAction = {
  Created: 'created',
  Updated: 'updated',
  Moved: 'moved',
  Deleted: 'deleted',
} as const;

/** Any one of the actions in `ArtifactAction`. */
export type ArtifactAction = (typeof ArtifactAction)[keyof typeof ArtifactAction];

/**
 * One thing a run's tool calls produced: the first link to a uri, and where it came from.
 *
 * @remarks
 * A link is what one call answered with; an artifact is what the run made, one per uri however
 * many calls linked to it. A declared or detected artifact is one per location the same way, and
 * its `link` is built from what was said of it: the location as `uri`, its last segment as `name`.
 */
export interface RunArtifact {
  /**
   * The link as the first call to give its uri gave it. A later call's says nothing new here, and
   * a declaration only fills in a `title` or `description` it left out.
   */
  link: ResourceLink;
  /** The call that first linked to it, wrote it, or — for a declaration alone — last touched it. */
  callId: string;
  /** That call's tool. For a `call_tool`, the tool it named. */
  tool: string;
  /** The loop's step that call was made in, from 0. */
  step: number;
  /**
   * How many calls linked to it or wrote it. A deduplicated repeat does not count, since nothing
   * was made twice, a call that links one uri twice counts once, and a declaration counts none.
   */
  count: number;
  /**
   * How it came to be known: `linked` where absent, which is every artifact a call's answer
   * linked to, so the shape from before the other two sources still reads the same. A declaration
   * over a detection takes the source over; a link over either does too.
   */
  source?: ArtifactSource;
  /**
   * What the latest write a detection read did to it. Absent where no detection did: a link or a
   * declaration says a thing exists, not what was done to it.
   */
  action?: ArtifactAction;
  /** The bytes the latest detected write carried, where its arguments held the content. */
  sizeBytes?: number;
}
