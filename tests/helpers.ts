import OpenAI from 'openai';
import type { CatalogServer } from '../src/catalog.ts';
import { FinishReason, FUNCTION_TOOL, Role, SchemaType } from '../src/wire.ts';

/**
 * What more than one test file builds the same way: the fake client, the errors the SDK raises,
 * a streamed turn, and the smallest config, tool and message that will do.
 *
 * A helper only one file uses stays in that file. One that closes over a file's own mock (`create`,
 * `list`) stays there too, since `vi.mock` is hoisted per file and the mock cannot be shared.
 */

export type Body = OpenAI.ChatCompletionCreateParamsStreaming;
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
 * @param [message] - The server's own words, which the SDK reads out of the body.
 * @returns The error.
 *
 * @remarks
 * The SDK builds the message from the body, not from its own `message` argument, so that argument
 * is left out.
 */
export const apiError = (status: number, message = 'rejected') =>
  new OpenAI.APIError(status, { error: { message } }, undefined, undefined);

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
