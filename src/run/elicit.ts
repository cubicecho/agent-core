import { isRecord } from '../core/guards.ts';
import { ABORT_EVENT } from '../core/platform.ts';
import { type RunEventInput, RunEventKind } from './events.ts';

/**
 * A remote agent asking its caller for input: an MCP server behind it sent `elicitation/create`, and
 * only the app at the far end of the request can answer.
 *
 * The run ends its response with a handed-back call of a reserved name, whose arguments are the
 * server's request. The loop answers it through `onElicit` and resumes by itself.
 */

/** The reserved call a remote agent asks for input with. No tool may take the name. */
export const ELICIT_TOOL = 'agent_core_elicit' as const;

/** How a person, or the app for them, answered a request for input: MCP's three actions. */
export const ElicitAction = {
  /** They answered. `content` holds what they gave. */
  Accept: 'accept',
  /** They said no. */
  Decline: 'decline',
  /** They walked away, or the handler failed. */
  Cancel: 'cancel',
} as const;

/** Any one of the actions in `ElicitAction`. */
export type ElicitAction = (typeof ElicitAction)[keyof typeof ElicitAction];

/** What a server asks with: MCP's `ElicitRequestParams`, written out so this package needs no MCP SDK. */
export interface ElicitParams {
  /** The question, for a person to read. */
  message: string;
  /** `form` or `url`. Absent means a form. */
  mode?: string;
  /** The form's JSON Schema. */
  requestedSchema?: object;
  /** Where to send the person, in `url` mode. */
  url?: string;
}

/** What the server is told: MCP's `ElicitResult`. */
export interface ElicitAnswer {
  /** How it was answered. */
  action: ElicitAction;
  /** What was given, on `accept` and on no other action. */
  content?: Record<string, unknown>;
}

/**
 * Answers a call of `ELICIT_TOOL` for the exchange.
 *
 * @param id - The call's id.
 * @param args - Its arguments as read, `undefined` where they did not parse.
 * @returns The tool message's text: the `ElicitAnswer` as JSON. Rejects only where the exchange
 * was stopped.
 */
export type Elicitor = (id: string, args: Record<string, unknown> | undefined) => Promise<string>;

/** What a handler's return is read as where it is no answer, and where the handler threw. */
const CANCELLED: ElicitAnswer = { action: ElicitAction.Cancel };

/** What the server is told where the app has no handler, or the request cannot be shown. */
const DECLINED: ElicitAnswer = { action: ElicitAction.Decline };

/** Every action, for reading one off a handler. */
const ACTIONS: ReadonlySet<unknown> = new Set(Object.values(ElicitAction));

/**
 * Whether a call's arguments are a request a person could be shown.
 *
 * @param args - The arguments as read.
 * @returns True of an object with a string `message`.
 */
const isParams = (args: Record<string, unknown> | undefined): args is Record<string, unknown> & ElicitParams =>
  typeof args?.message === 'string';

/**
 * A handler's return as the answer the server is sent.
 *
 * @param value - What it returned.
 * @returns The action, with `content` only on `accept`; `cancel` for anything that is not an answer.
 */
function answerFrom(value: unknown): ElicitAnswer {
  if (!isRecord(value) || !ACTIONS.has(value.action)) {
    return CANCELLED;
  }
  const action = value.action as ElicitAction;
  const isAccepted = action === ElicitAction.Accept;
  if (isAccepted === false) {
    return { action };
  }
  if (value.content !== undefined && !isRecord(value.content)) {
    return CANCELLED;
  }
  return { action, ...(value.content ? { content: value.content } : {}) };
}

/**
 * The names of the form's fields an answer filled in, which is all a run event says of it.
 *
 * @param params - The request, for the fields its schema declares.
 * @param answer - The answer.
 * @returns The declared fields it holds a value for. Never a value, and never a key the schema does
 * not declare, since a key the server did not ask for can be anything a handler wrote.
 */
function answeredFields(params: ElicitParams | undefined, { content }: ElicitAnswer): string[] {
  const schema = params?.requestedSchema;
  const properties = isRecord(schema) ? schema.properties : undefined;
  if (!content || !isRecord(properties)) {
    return [];
  }
  return Object.keys(content).filter((key) => Object.hasOwn(properties, key));
}

/**
 * Puts one request to the app's handler.
 *
 * @param handler - The app's `onElicit`.
 * @param asker - The agent asking, handed over as the handler's server id.
 * @param params - The request.
 * @param signal - The exchange's signal.
 * @returns The answer; `cancel` where the handler threw or returned something else. Rejects with
 * the signal's reason once it aborts, whether or not the handler is listening.
 */
async function askHandler(
  handler: NonNullable<OnElicit>,
  asker: string,
  params: ElicitParams,
  signal: AbortSignal,
): Promise<ElicitAnswer> {
  signal.throwIfAborted();
  // Aborted on the way out, which takes the listener off a signal that outlives this request.
  const settled = new AbortController();
  const stopped = new Promise<never>((_, reject) => {
    signal.addEventListener(ABORT_EVENT, () => reject(signal.reason), { once: true, signal: settled.signal });
  });
  try {
    const asked = (async () => handler(asker, params, { signal }))();
    return answerFrom(await Promise.race([asked, stopped]));
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    return CANCELLED;
  } finally {
    settled.abort();
  }
}

/**
 * Answers a server's request for input, with the signature of `agent-mcp-pool`'s `ElicitHandler`, so
 * one prompt serves an app's own MCP servers and the agents behind a router.
 *
 * @param serverId - Who is asking: the remote agent's model name, since the server behind it is
 * the router's to know.
 * @param params - The request.
 * @param extra - `signal` aborts when the exchange is stopped.
 * @returns The answer.
 */
export type OnElicit = {
  // A method, so a handler typed against the MCP SDK's narrower params is assignable.
  bivariant(
    serverId: string,
    params: ElicitParams,
    extra: { signal: AbortSignal },
  ): ElicitAnswer | Promise<ElicitAnswer>;
}['bivariant'];

/**
 * The exchange's answerer of `ELICIT_TOOL`.
 *
 * @param asker - The remote agent's model name.
 * @param onElicit - The app's handler. Absent, every request is declined.
 * @param signal - The exchange's signal, if any.
 * @param onEvent - Hears the question and how it was answered.
 * @returns The answerer.
 *
 * @remarks
 * What a person typed goes to the server in the tool message and nowhere else: the `elicit-answer`
 * event holds the action and the names of the fields filled in, never a value. A request that cannot
 * be shown is declined without troubling the handler.
 */
export function elicitor(
  asker: string,
  onElicit: OnElicit | undefined,
  signal: AbortSignal | undefined,
  onEvent: (input: RunEventInput) => void,
): Elicitor {
  const held = signal ?? new AbortController().signal;
  return async (id, args) => {
    const params = isParams(args) ? args : undefined;
    onEvent({ kind: RunEventKind.Elicit, id, text: params?.message ?? '' });
    const answer = params && onElicit ? await askHandler(onElicit, asker, params, held) : DECLINED;
    const fields = answeredFields(params, answer);
    onEvent({ kind: RunEventKind.ElicitAnswer, id, text: answer.action, ...(fields.length ? { fields } : {}) });
    return JSON.stringify(answer);
  };
}
