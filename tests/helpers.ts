import OpenAI from 'openai';
import { SUMMARY_ACK, SUMMARY_LEAD } from '../src/context/compaction.ts';
import { HookEvent } from '../src/hooks/hook-events.ts';
import { type HookOutcome, textOf } from '../src/hooks/hooks.ts';
import type { CatalogServer } from '../src/tools/catalog.ts';
import { FinishReason, FUNCTION_TOOL, Role, SchemaType } from '../src/wire/wire.ts';

/**
 * What more than one test file builds the same way: the fake client, the errors the SDK raises,
 * a streamed turn, a hook's outcome, and the smallest config, tool and message that will do.
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

/**
 * What a call that does not stream is answered with.
 *
 * @param content - What the model says.
 * @returns The completion, with only its message set.
 */
export const answer = (content: string) => ({ choices: [{ message: { content } }] });

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
 * @returns The message, answering a call with the id `c`.
 */
export const result = (content: string): Message => ({ role: Role.Tool, tool_call_id: 'c', content });

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
  event: HookEvent.BeforeTurn,
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
