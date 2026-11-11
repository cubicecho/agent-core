/**
 * The words the chat-completions wire is written in, each under a name.
 *
 * A leaf with no imports, because every module that builds a message or reads one needs these and
 * they share nothing else. The `openai` types still say which word a field takes — these are the
 * same literals, so a message built from them is checked exactly as one built from strings — and
 * what the names add is that a role or a finish reason is spelled in one place.
 */

/** Who a message is from. */
export const Role = {
  /** The instructions a conversation opens with. */
  System: 'system',
  /** What a reasoning model takes in place of `system`. */
  Developer: 'developer',
  /** The person, or whatever stands in for one. */
  User: 'user',
  /** The model. */
  Assistant: 'assistant',
  /** A tool's result, answering the call whose id it carries. */
  Tool: 'tool',
} as const;

/** Any one of the roles in `Role`. */
export type Role = (typeof Role)[keyof typeof Role];

/** Why a model stopped writing. */
export const FinishReason = {
  /** It was done. */
  Stop: 'stop',
  /** It ran into the reply ceiling, and what it wrote is cut off. */
  Length: 'length',
  /** It asked for tools. */
  ToolCalls: 'tool_calls',
  /** A filter withheld the reply. */
  ContentFilter: 'content_filter',
} as const;

/** Any one of the reasons in `FinishReason`. */
export type FinishReason = (typeof FinishReason)[keyof typeof FinishReason];

/** What a part of a message's content is. */
export const PartType = {
  /** Text. */
  Text: 'text',
  /** The model declining, in place of an answer. */
  Refusal: 'refusal',
  /** An image, by URL or inline. */
  ImageUrl: 'image_url',
  /** An attached file. */
  File: 'file',
} as const;

/** Any one of the part types in `PartType`. */
export type PartType = (typeof PartType)[keyof typeof PartType];

/** The types JSON Schema has, as the `type` keyword spells them. */
export const SchemaType = {
  Object: 'object',
  Array: 'array',
  String: 'string',
  Number: 'number',
  Integer: 'integer',
  Boolean: 'boolean',
  Null: 'null',
} as const;

/** Any one of the types in `SchemaType`. */
export type SchemaType = (typeof SchemaType)[keyof typeof SchemaType];

/** The one `type` a tool definition or a tool call has on this wire. */
export const FUNCTION_TOOL = 'function' as const;

/** The `response_format` type that carries a schema the reply has to fit. */
export const JSON_SCHEMA_FORMAT = 'json_schema' as const;

/**
 * The assistant message field a model's scratchpad is replayed in where it did not arrive as
 * `reasoning`. Not in the OpenAI types; llama.cpp reads only this, as do DeepSeek and the Qwen
 * templates.
 */
export const REASONING_CONTENT = 'reasoning_content' as const;

/**
 * The other spelling of that field: what Ollama's `/v1` sends and the only one it reads back, and
 * OpenRouter's own. vLLM reads either.
 */
export const REASONING = 'reasoning' as const;

/** Either field a scratchpad travels in. */
export type ReasoningField = typeof REASONING_CONTENT | typeof REASONING;

/**
 * OpenRouter's field for reasoning as blocks: summaries, raw text with a signature, or encrypted
 * data. It comes beside `reasoning` and goes back on the assistant message unmodified and in order.
 */
export const REASONING_DETAILS = 'reasoning_details' as const;

/**
 * The keys of a streamed tool call, besides `index`, `id`, `type` and `function`, that are kept on
 * the call and sent back as they came.
 *
 * @remarks
 * `extra_content` is where Gemini puts `google.thought_signature`, on the first call of a step, and
 * Gemini refuses with a 400 a request that replays the step without it. It is an allowlist rather
 * than every key a server sent, because a key no server asked to have back is one a strict server
 * may refuse. llama.cpp keeps an unknown key of a call aside, and vLLM ignores it.
 */
export const CALL_EXTRA_KEYS = Object.freeze(['extra_content'] as const);

/** Any one of `CALL_EXTRA_KEYS`. */
export type CallExtraKey = (typeof CALL_EXTRA_KEYS)[number];

/** The HTTP statuses this package reads a meaning into. */
export const HttpStatus = {
  Ok: 200,
  BadRequest: 400,
  Unauthorized: 401,
  Forbidden: 403,
  NotFound: 404,
  MethodNotAllowed: 405,
  RequestTimeout: 408,
  Conflict: 409,
  UnprocessableEntity: 422,
  TooManyRequests: 429,
  /** The first of the 5xx range, and so the floor of "the server's fault". */
  InternalServerError: 500,
  NotImplemented: 501,
  ServiceUnavailable: 503,
} as const;
