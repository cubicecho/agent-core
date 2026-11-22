import OpenAI from 'openai';
import { expect, vi } from 'vitest';
import { SUMMARY_ACK, SUMMARY_LEAD } from '../src/context/compaction.ts';
import { HookEvent } from '../src/hooks/hook-events.ts';
import type { HookOutcome } from '../src/hooks/hooks.ts';
import { PART_OWNERS, PROMPT_ROLES, type StackedPart } from '../src/spec/parts.ts';
import { type AgentSpec, parseSpec } from '../src/spec/spec.ts';
import type { CatalogServer } from '../src/tools/catalog.ts';
import { toolName } from '../src/tools/tool-loading.ts';
import { textOf } from '../src/wire/text.ts';
import type { ToolCall } from '../src/wire/tool-calls.ts';
import { FinishReason, FUNCTION_TOOL, HttpStatus, Role, SchemaType } from '../src/wire/wire.ts';

/**
 * What more than one test file builds the same way: the fake client, the errors the SDK raises,
 * a streamed turn, a server answered by a function, a hook's outcome, and the smallest config,
 * tool and message that will do.
 *
 * A helper only one file uses stays in that file. One that closes over a file's own mock (`create`,
 * `list`) stays there too, since `vi.mock` is hoisted per file and the mock cannot be shared.
 */

export type Body = OpenAI.ChatCompletionCreateParamsStreaming;

/** The shape of every id the loop makes up: what Mistral's tokenizers before V13 accept. */
export const MINTED_ID = /^[A-Za-z0-9]{9}$/;
export type Chunk = OpenAI.ChatCompletionChunk;
export type Message = OpenAI.ChatCompletionMessageParam;

/**
 * The SDK's `chat.completions.create` as the code calls it, which every fake of it is typed as.
 *
 * The body is either kind, since a test may call the client itself without streaming. What the
 * fake answers is left to the test: the SDK promises a whole stream or completion, which no test
 * builds.
 */
export type Create = (body: OpenAI.ChatCompletionCreateParams, options?: OpenAI.RequestOptions) => unknown;

/**
 * A client whose only working part is `chat.completions.create`.
 *
 * @param create - What answers a request: it is handed the body and the request's options.
 * @returns The fake, typed as the SDK's client — the one place the suite asserts that.
 */
export const clientOf = (create: (body: Body, options: { signal: AbortSignal }) => unknown) =>
  ({ chat: { completions: { create } } }) as unknown as OpenAI;

/**
 * A hand-written chunk, carrying only the fields under test.
 *
 * @param partial - The fields. The SDK's `Choice` wants more than a test has any reason to write.
 * @returns The same object, typed as a whole chunk.
 */
export const chunk = (partial: unknown) => partial as Chunk;

/**
 * A chunk that adds this to the answer.
 *
 * @param content - The words the delta carries.
 * @returns The chunk.
 */
export const text = (content: string): Chunk => chunk({ choices: [{ delta: { content } }] });

/**
 * A stream that hands over its chunks and ends, the way a request that answered does.
 *
 * @param list - The chunks, whole or hand-written, in the order they arrive.
 * @returns What `create` resolves to for a streamed request.
 */
export const chunks = (...list: unknown[]) => ({
  async *[Symbol.asyncIterator]() {
    yield* list.map(chunk);
  },
});

/**
 * A streamed turn that asks for these calls, numbered `c0`, `c1`… in order.
 *
 * @param list - Each call's tool name and arguments text.
 * @returns The stream.
 */
export const asksFor = (...list: [name: string, args: string][]) =>
  chunks({
    choices: [
      {
        delta: {
          tool_calls: list.map(([name, args], index) => ({
            index,
            id: `c${index}`,
            function: { name, arguments: args },
          })),
        },
        finish_reason: FinishReason.ToolCalls,
      },
    ],
  });

/**
 * A streamed turn that answers in words, then reports ten tokens in and two out.
 *
 * @param content - What the model says.
 * @param [finish] - Why the turn stopped.
 * @returns The stream.
 */
export const says = (content: string, finish: FinishReason = FinishReason.Stop) =>
  chunks(
    { choices: [{ delta: { content } }] },
    { choices: [{ delta: {}, finish_reason: finish }], usage: null },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
  );

/** What a side task's reply carries beside its text. */
export interface AnswerParts {
  /** Why the model stopped. Absent or `null` is a server that never said. */
  finishReason?: string | null;
  /** A scratchpad sent in `reasoning_content`, beside the text rather than fenced inside it. */
  reasoning?: string;
}

/**
 * A side task's reply, streamed: what it says as one delta, then why it stopped.
 *
 * @param content - What the model says.
 * @param [parts] - Why it stopped, and a scratchpad in its own field.
 * @returns The stream.
 */
export const answer = (content: string, { finishReason = null, reasoning }: AnswerParts = {}) =>
  chunks(
    { choices: [{ delta: { content, ...(reasoning === undefined ? {} : { reasoning_content: reasoning }) } }] },
    { choices: [{ delta: {}, finish_reason: finishReason }] },
  );

/**
 * A streamed reply in words, as a server on a port sends one.
 *
 * @param content - What the model says.
 * @returns The response.
 */
export const respondInWords = (content: string) =>
  streamed({ choices: [{ index: 0, delta: { content }, finish_reason: FinishReason.Stop }] });

/** An answer for a test that does not care what was said. */
export const reply = answer('ok');

/**
 * An `APIError` as the SDK raises it for a response with this status.
 *
 * @param status - The HTTP status.
 * @param [message] - The server's own words.
 * @returns The error, whose message reads `400 rejected`: the status, then the words.
 *
 * @remarks
 * The SDK hands the constructor the body's `error` object, already unwrapped, and builds the
 * message from that rather than from its own `message` argument, which is left out. Wrapped once
 * more, the message would be the JSON of the body, which no server sends.
 */
export const apiError = (status: number, message = 'rejected') =>
  new OpenAI.APIError(status, { message }, undefined, undefined);

/**
 * A JSON answer, as a server on a port would send it.
 *
 * @param body - What the response carries.
 * @param [status] - The HTTP status.
 * @returns The response.
 */
export const respond = (body: unknown, status: number = HttpStatus.Ok) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A streamed answer: each chunk as a server-sent event, then `[DONE]`.
 *
 * @param events - The chunks, in order.
 * @returns The response.
 */
export const streamed = (...events: unknown[]) =>
  new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });

/**
 * An `Endpoint.fetch` that answers every request itself, with no server on a port.
 *
 * @param handle - Answers one request, handed it whole: URL, method, headers and body.
 * @returns The function, a mock, so a test can say what reached it.
 */
export const answeredBy = (handle: (request: Request) => Response | Promise<Response>) =>
  vi.fn<typeof globalThis.fetch>(async (input, init) => handle(new Request(input, init)));

/**
 * A tool definition that takes no arguments.
 *
 * @param name - The tool's name, and its description.
 * @returns The definition.
 */
export const tool = (name: string): OpenAI.ChatCompletionTool => ({
  type: FUNCTION_TOOL,
  function: { name, description: name, parameters: { type: SchemaType.Object, properties: {} } },
});

/**
 * The names a request's tool list declares.
 *
 * @param [tools] - The list, as a body declares it. Absent reads as none.
 * @returns Each tool's name, in order: `undefined` for a tool that is not a function.
 */
export const toolNames = (tools: readonly OpenAI.ChatCompletionTool[] = []) => tools.map(toolName);

/**
 * A call's arguments, as the transcript holds them.
 *
 * @param call - A call off an assistant message.
 * @returns The arguments text, or `undefined` for a call that is not a function call.
 */
export const callArguments = (call: OpenAI.ChatCompletionMessageToolCall) =>
  call.type === FUNCTION_TOOL ? call.function.arguments : undefined;

/**
 * A message of the role a test expects, failing the test where it is another.
 *
 * @param message - The message, such as `result.messages[1]`.
 * @param role - The role it should have.
 * @returns The message, typed as that role's.
 */
export function ofRole<R extends Message['role']>(
  message: Message | undefined,
  role: R,
): Extract<Message, { role: R }> {
  const isRole = message !== undefined && hasRole(message, role);
  if (isRole) {
    return message;
  }
  throw new Error(`expected a ${role} message, got ${message?.role ?? 'none'}`);
}

/**
 * Whether a message has a role.
 *
 * @param message - The message.
 * @param role - The role.
 * @returns `true` where it has it, narrowing the message to that role's.
 */
const hasRole = <R extends Message['role']>(message: Message, role: R): message is Extract<Message, { role: R }> =>
  message.role === role;

/**
 * A message's content where the test expects it to be one string, failing the test where it is a list of parts.
 *
 * @param message - The message.
 * @returns The content.
 */
export function stringContent(message: Message | undefined): string {
  const content = message?.content;
  if (typeof content === 'string') {
    return content;
  }
  throw new Error(`expected string content, got ${JSON.stringify(content)}`);
}

/**
 * A tool as a catalogue lists it.
 *
 * @param name - The tool's name.
 * @returns The entry: the name, and a description made from it.
 */
export const catalogTool = (name: string) => ({ name, description: `does ${name}` });

/** A catalogue of two servers, with names that share a prefix and names that share a word. */
export const catalog: CatalogServer[] = [
  {
    id: '1',
    label: 'Gmail',
    tools: [catalogTool('gmail__send_email'), catalogTool('gmail__list_labels'), catalogTool('gmail__read_email')],
  },
  { id: '2', label: 'Files', tools: [catalogTool('files__read_file'), catalogTool('files__write_file')] },
];

/**
 * A user message.
 *
 * @param content - What it says.
 * @returns The message.
 */
export const user = (content: string): Message => ({ role: Role.User, content });

/**
 * An assistant message.
 *
 * @param content - What it says.
 * @returns The message.
 */
export const assistant = (content: string): Message => ({ role: Role.Assistant, content });

/**
 * A tool result.
 *
 * @param content - What the tool gave back.
 * @param [id] - The id of the call it answers.
 * @returns The message.
 */
export const result = (content: string, id = 'c'): Message => ({ role: Role.Tool, tool_call_id: id, content });

/**
 * A fold's summary as `applyCompaction` writes it.
 *
 * @param notes - The summary, without the lead.
 * @returns The `user` message carrying it and the `assistant` reply that closes the pair.
 */
export const summarised = (notes: string): Message[] => [user(`${SUMMARY_LEAD}${notes}`), assistant(SUMMARY_ACK)];

/**
 * What a chat template would raise over a request, for the templates agent-core is most often
 * refused by.
 *
 * @param messages - The request's messages, as sent.
 * @returns The exception's text, or `undefined` where every template here renders it.
 *
 * @remarks
 * The rules are transcribed rather than rendered, so no Jinja engine is needed. Qwen3.5, 3.6 and
 * 3.8 (`chat_template.jinja`, the loop over `messages`) raise "System message must be at the
 * beginning." on any `system` message that is not the first, and "No user query found in
 * messages." where no user message is more than a `<tool_response>` block; Devstral-2512 has the
 * first rule too. Mistral v0.3 raises when the messages after an optional first `system` do not
 * alternate user and assistant, tool calls and their results left out of the count.
 */
export const templateRefusal = (messages: Message[]): string | undefined => {
  if (messages.some((message, at) => message.role === Role.System && at > 0)) {
    return 'System message must be at the beginning.';
  }
  const isQuery = (message: Message) => {
    const content = textOf(message.content).trim();
    return (
      message.role === Role.User &&
      (content.startsWith('<tool_response>') && content.endsWith('</tool_response>')) === false
    );
  };
  if (messages.some(isQuery) === false) {
    return 'No user query found in messages.';
  }
  const spoken = messages.filter(
    (message, at) =>
      (at === 0 && message.role === Role.System) === false &&
      message.role !== Role.Tool &&
      ('tool_calls' in message && (message.tool_calls?.length ?? 0) > 0) === false,
  );
  const alternates = spoken.every((message, at) => (message.role === Role.User) === (at % 2 === 0));
  return alternates ? undefined : 'After the optional system message, conversation roles must alternate';
};

/**
 * What Llama 3.x's chat template raises over a request with an assistant message of several calls.
 *
 * @param messages - The request's messages, as sent.
 * @returns The exception's text, or `undefined` where every assistant message with calls has one.
 *
 * @remarks
 * Transcribed, as `templateRefusal` is: the 3.1, 3.2 and 3.3 templates read
 * `{%- if not message.tool_calls|length == 1 %}` for any message with a `tool_calls` key and raise.
 */
export const singleCallRefusal = (messages: Message[]): string | undefined =>
  messages.some((message) => 'tool_calls' in message && message.tool_calls?.length !== 1)
    ? 'This model only supports single tool-calls at once!'
    : undefined;

/**
 * Whether every assistant message's results come straight after it, in the order of its calls,
 * which is the only pairing a template that matches by position — Qwen, GLM, DeepSeek V3.2 — reads.
 *
 * @param messages - The transcript.
 * @returns `true` where each run of `tool` messages answers, id for id and in order, the calls of
 * the assistant message just before it.
 */
export const pairsByPosition = (messages: Message[]): boolean =>
  messages.every((message, at) => {
    if (message.role !== Role.Assistant || (message.tool_calls?.length ?? 0) === 0) {
      return true;
    }
    const ids = message.tool_calls?.map((call) => call.id) ?? [];
    const answers = messages.slice(at + 1, at + 1 + ids.length);
    return (
      answers.length === ids.length &&
      answers.every((answer, index) => answer.role === Role.Tool && answer.tool_call_id === ids[index])
    );
  });

/**
 * What a hook's runner reports for one hook, whole, so a fake runner can be typed as a real one.
 *
 * @param [given] - The fields the test is about. The rest describe a memory hook that ran before
 * the turn, succeeded, and asked for nothing to be injected.
 * @returns The outcome.
 */
export const outcome = (given: Partial<HookOutcome> = {}): HookOutcome => ({
  serverId: 'mem',
  label: 'Memory',
  hookId: 'recall',
  event: HookEvent.BeforeExchange,
  ok: true,
  ms: 1,
  inject: false,
  maxTokens: 1000,
  ...given,
});

/** An endpoint with no key and a minute's timeout. */
export const endpoint = { baseUrl: 'http://local/v1', apiKey: '', requestTimeoutSeconds: 60 };

/** The least an agent loop runs on. */
export const config = {
  baseUrl: 'http://local/v1',
  apiKey: '',
  model: 'm',
  maxTokens: 100,
  temperature: 0.2,
  maxToolIterations: 4,
};

/**
 * A parsed agent document, insisting it survived so a test never asserts against `null`.
 *
 * @param document - The document, as a host would read it.
 * @param [options] - What `parseSpec` is told besides.
 * @returns The spec. A document with errors fails the test where it is parsed.
 */
export function parsed(document: unknown, options?: Parameters<typeof parseSpec>[1]): AgentSpec {
  const result = parseSpec(document, options);
  expect(result.errors).toEqual([]);
  if (!result.spec) {
    throw new Error('unreachable');
  }
  return result.spec;
}

/**
 * An agent's part, as stacking leaves it.
 *
 * @param name - Its name.
 * @param content - Its text.
 * @param [mark] - The part it adds to or replaces, where it does.
 * @returns The part.
 */
export const stackedAgent = (name: string, content: string, mark?: StackedPart['mark']): StackedPart => ({
  role: PROMPT_ROLES.system,
  name,
  content,
  owner: PART_OWNERS.agent,
  ...(mark && { mark }),
});

/**
 * An app's part, as stacking leaves it.
 *
 * @param name - Its name, prefix included.
 * @param content - Its text.
 * @param [mark] - The part it adds to or replaces, where it does.
 * @returns The part.
 */
export const stackedApp = (name: string, content: string, mark?: StackedPart['mark']): StackedPart => ({
  ...stackedAgent(name, content, mark),
  owner: PART_OWNERS.app,
});

/**
 * A call off an assistant message, of a tool named for its id unless told otherwise.
 *
 * @param id - The call's id, which its result answers.
 * @param [name] - The tool's name.
 * @returns The call, with empty arguments.
 */
export const toolCall = (id: string, name = id): ToolCall => ({
  id,
  type: FUNCTION_TOOL,
  function: { name, arguments: '{}' },
});
