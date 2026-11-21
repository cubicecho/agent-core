import {
  type AgentConfig,
  type Endpoint,
  RESERVED_BODY_FIELDS,
  ReasoningReplay,
  ToolDiscovery,
} from '../core/config.ts';
import { AGENT_DEFAULTS } from '../core/defaults.ts';
import { isAbsent, isRecord } from '../core/guards.ts';
import { HOOK_EVENTS, HookEvent, INJECT_EVENTS } from '../hooks/hook-events.ts';
import {
  APP_PART_PREFIX,
  PART_OWNERS,
  PROMPT_LAYOUTS,
  PROMPT_MODES,
  PROMPT_ROLES,
  type PromptLayout,
  type PromptMode,
  type PromptRole,
  type StackedPart,
} from './parts.ts';
import { type AppPart, numberedName, plainPrompt } from './stack.ts';

/**
 * A JSON document that defines an agent, and the rules for reading one.
 *
 * The apps on this package each spelled "an agent" differently, to the point that `maxTokens: 0`
 * meant three different things; this is the shape they can all write and read, argued out in
 * `docs/agent-spec-v2.md`. Nothing outside `src/spec/` imports this module, and it imports nothing that
 * needs Node, so the loop has no opinion on where an agent comes from and an app can validate a
 * pasted document in a browser.
 */

/** The token a document declares itself with. A loader refuses anything else. */
export const AGENT_SPEC = 'cubicecho.agent/2';

/** The major version `AGENT_SPEC` pins. Raised only when a field changes meaning. */
export const AGENT_SPEC_VERSION = 2;

/** The token of version 1, which `parseSpec` refuses and `upgradeSpec` converts. */
const AGENT_SPEC_V1 = 'cubicecho.agent/1';

/**
 * The side tasks this package has code for: documentation and a sensible UI order, not a
 * validator.
 *
 * @remarks
 * `tasks` is an open record on purpose — an app may run tasks this package has never heard of,
 * and an unknown key is carried through untouched rather than warned about.
 */
export const AGENT_TASKS = ['compaction', 'toolSelect', 'title', 'followups'] as const;

/**
 * Every event a hook may be bound to: `HOOK_EVENTS`, under the name a document's reader knows.
 *
 * @remarks
 * The same array, not a copy. It comes from `hook-events.ts` rather than `hooks.ts` because that
 * module's `createHash` would otherwise come with it, into a file whose whole point is that a
 * browser can load it.
 */
export const SPEC_EVENTS: readonly HookEvent[] = HOOK_EVENTS;

/** One agent, as a document. Every field but `spec` is optional, because a layer says only what it changes. */
export interface AgentSpec {
  /** Exactly `AGENT_SPEC`. Missing, mistyped or another major is refused. */
  spec: typeof AGENT_SPEC;
  /** A URL for an editor's autocompletion. Never fetched, never read, never validated against. */
  $schema?: string;

  /** A stable handle within an app: `reviewer`, `local-qwen`. Absent in a layer of pure defaults. */
  id?: string;
  /** What a person calls it. Absent falls back to `id`. */
  name?: string;
  /** One line for an operator choosing between agents. Never sent to a model — that is `prompt`. */
  description?: string;

  endpoint?: EndpointSpec;
  model?: ModelSpec;
  /** Ordered parts of the system prompt, merged by part `name`. */
  prompt?: PromptPart[];
  /** How the parts are written for the model. Absent inherits; nowhere is `plain`. */
  promptLayout?: PromptLayout;
  tools?: ToolsSpec;
  retry?: RetrySpec;
  /** Side tasks run on a model other than the agent's. Open by design; see `AGENT_TASKS`. */
  tasks?: Record<string, TaskSpec>;
  hooks?: AgentHook[];
  /** Definitions carried so an agent travels whole. Executable by proxy; see `parseSpec`. */
  bundle?: SpecBundle;

  /** App payloads keyed by reverse domain. Carries no semantics and is never validated. */
  extensions?: Record<string, unknown>;
  /** Extension keys an app must understand, or it refuses to run this agent. */
  requires?: string[];

  /** Keys from a later 2.x, kept so an edit-and-export cycle does not erase them. */
  [key: string]: unknown;
}

/** Where a model is reached, and how long to wait for it. There is no credential field, by design. */
export interface EndpointSpec {
  /** Any OpenAI-compatible base URL. Absent inherits; absent everywhere means it cannot run. */
  baseUrl?: string;
  /** Seconds of silence allowed between chunks. Zero is no limit. */
  requestTimeoutSeconds?: number;
  /** Seconds allowed for the first chunk. Zero is no limit; absent is five times the above. */
  firstTokenSeconds?: number;
  // There is no credential field here, or at any other depth. See `parseSpec`.
}

/** Which model answers and how, including the request fields this interface cannot spell. */
export interface ModelSpec {
  /** Absent inherits. Empty names no model, which cannot run. */
  model?: string;
  /** The reply's ceiling. Zero sends none and lets the server decide — a value, not a sentinel. */
  maxTokens?: number;
  /** Zero to two. Zero means zero. */
  temperature?: number;
  /** `reasoning_effort`. `"off"` and `""` send nothing; any other string passes through. */
  reasoningEffort?: string;
  /** Which assistant messages replay the model's scratchpad. Absent is `all`. */
  reasoningReplay?: ReasoningReplay;
  /** What the operator says this model reads, in tokens. Zero asks the model server. */
  contextLength?: number;
  /**
   * Request fields the interface cannot spell. The `RESERVED_BODY_FIELDS` are dropped, and so are
   * the `SPELLED_BODY_FIELDS`, which the fields above set.
   */
  extraBody?: Record<string, unknown>;
  /**
   * Request fields a layer above this one may not change, by their wire names: `temperature`,
   * `max_tokens` (which covers `max_completion_tokens`), `reasoning_effort`, or any key that would
   * go in `extraBody`, such as `top_p`, `seed` or a provider's own field. Absent locks nothing:
   * every field is open by default.
   */
  lockedFields?: string[];
}

/** One named piece of the system prompt, written as a chat message is, so a layer above can change it. */
export interface PromptPart {
  /** As a chat message's. Both are written into the system prompt the same way. */
  role: PromptRole;
  /**
   * What the part is for: `identity`, `rules`, `format`, `lane`. Merging happens on it, and a name
   * whose first word is `app` (`app_lane`, `App lane`) is refused, since that prefix is an app's.
   */
  name: string;
  /** The text. Empty deletes the part a layer below contributed, and every part that names it. */
  content: string;
  /**
   * How it changes the part below with its name: `extend` adds a part of its own marked as adding
   * to it, `replace` one marked as taking its place. Absent overwrites in place.
   */
  mode?: PromptMode;
  /** The modes an app may use on this part. Absent is `["extend"]`; `[]` locks it. */
  allowedModes?: readonly PromptMode[];
}

/** How tools reach the model, and which servers this agent may reach at all. */
export interface ToolsSpec {
  /**
   * How tool definitions reach the model: all of them on every request, a name-only catalogue
   * the model loads from, or that catalogue behind a fixed `load_tools` and `call_tool`.
   */
  discovery?: ToolDiscovery;
  /** The hard stop on a tool loop. At least one. */
  maxIterations?: number;
  /**
   * The MCP servers this agent may reach, by effective slug (`row.slug ?? row.id`).
   * Absent is every server the app offers, `[]` is none, and a list is exactly those.
   * Three different answers, and a loader must never collapse one into another.
   */
  servers?: string[];
}

/** What to do about a request lost before the model produced anything. */
export interface RetrySpec {
  /** Re-sends of a request lost before the model produced anything. Zero is none — a value. */
  maxRetries?: number;
  /**
   * Seconds to wait out a server loading its model. Zero is not at all; absent is
   * `MODEL_SERVER_DEFAULTS.loadingTimeoutSeconds`.
   */
  loadingTimeoutSeconds?: number;
}

/** One side task, which may run on a different model — and a different machine — than the agent. */
export interface TaskSpec {
  /** The model for this task. Empty turns it off, which is how a layer declines one below it. */
  model?: string;
  /** Where that model lives, when it is not on the agent's model server. */
  endpoint?: EndpointSpec;
  /** The reply's ceiling. Absent is the side task's own default, not the agent's `maxTokens`. */
  maxTokens?: number;
  /**
   * Sampling temperature, whatever the agent's own is.
   *
   * @defaultValue `SIDE_TASK_DEFAULTS.temperature`
   */
  temperature?: number;
  /**
   * A level has the task deliberate. Absent and `"off"` leave it with the no-thinking hints a
   * side task is sent by default; see `SideTaskOptions.reasoningEffort`.
   */
  reasoningEffort?: string;
  /** Request fields the interface cannot spell, as `model.extraBody` but for this task alone. */
  extraBody?: Record<string, unknown>;
}

/** A tool call bound to a lifecycle event, run by the app rather than the model. */
export interface AgentHook {
  /** Unique within the agent. Merging happens on it. */
  id: string;
  /** One of `SPEC_EVENTS`. An event this app never fires is a warning, not an error. */
  on: HookEvent;
  /** The server whose tool this is, by effective slug. */
  server: string;
  /** The server's own name for the tool, not the qualified one the model sees. */
  tool: string;
  /** Arguments as JSON, with `{{path}}` placeholders filled from the event's context. */
  args?: unknown;
  /** Hand what the tool returns to the model. Only the events that run before one may. */
  inject?: boolean;
  /** Let this hook decline what its event announces. `beforeCompact` only. */
  veto?: boolean;
  maxTokens?: number;
  timeoutMs?: number;
  /** `false` keeps the hook in the document without running it. */
  enabled?: boolean;
}

/** A bundled MCP server, validated only as far as a round trip needs and otherwise passed through. */
export interface SpecServer {
  id?: string;
  slug?: string;
  [key: string]: unknown;
}

/** What an agent carries so it can travel whole: the definitions of the servers it names. */
export interface SpecBundle {
  /**
   * Full MCP server definitions. Validated only as far as a round trip needs — an object, a
   * non-empty `id` or `slug`, no duplicate slugs — with every other key passed through untouched.
   *
   * @remarks
   * This package deliberately does not restate the pool's `McpServerConfig`. Restating a union it
   * never reads is a version-skew generator: the pool carries `coerceArguments`, `maxResultChars`
   * and three separate timeouts, and a strict parse here would silently delete a server's
   * ninety-second call timeout on a round trip. Importing the type is not an option either, since
   * the pool pulls the MCP SDK and `openai` is this package's only peer dependency.
   */
  mcpServers?: SpecServer[];
}

/**
 * One side task, resolved: a model, and the model server it is reached through.
 *
 * @remarks
 * The settings are present only where a layer stated them, and nothing is filled in from
 * the agent's own model — `taskCall` turns one into a call, and what is absent there is left to
 * the side task's default.
 */
export interface ResolvedTask {
  model: string;
  /** This task's model server, which is the agent's unless a layer named another. */
  endpoint: Endpoint;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: string;
  /** Merged key by key across the layers. `model.extraBody` is the agent's and never reaches it. */
  extraBody?: Record<string, unknown>;
}

/**
 * What layered documents resolve to: the flat shape the loop already takes, plus the parts of an
 * agent that are the app's to act on.
 *
 * @remarks
 * `extends AgentConfig` is the whole point — `getClient(resolved)` and
 * `runAgentLoop({ config: resolved })` take this unchanged, and no adapter is needed.
 */
export interface ResolvedAgent extends AgentConfig {
  id: string;
  name: string;
  description: string;
  /** The tri-state preserved: absent is every server the app offers, empty is none. */
  servers?: readonly string[];
  /**
   * The merged prompt parts, in order, without the ones a layer deleted: owned by the agent, and
   * each that extends or replaces another marked against it. `systemPrompt` is `plainPrompt` of them.
   */
  prompt: readonly StackedPart[];
  /** The merged layout; `AGENT_DEFAULTS.promptLayout` where no layer set one. */
  promptLayout: PromptLayout;
  /** Only the tasks a layer configured and none declined. `toolSelect` also flattens to `toolSelectModel`. */
  tasks: Readonly<Record<string, ResolvedTask>>;
  /**
   * Merged by id. An `inject` or a `veto` the merged hook's event cannot honour is dropped, as
   * `parseSpec` drops it from one layer, but silently: resolving reports nothing.
   */
  hooks: readonly AgentHook[];
  /** Bundled server definitions, merged by effective slug. Empty unless a bundle was parsed. */
  mcpServers: readonly SpecServer[];
  extensions: Readonly<Record<string, unknown>>;
  /** Every layer's requirements, unioned, so a layer above cannot quietly drop one below it. */
  requires: readonly string[];
  /**
   * Every layer's `model.lockedFields`, unioned, less the `RESERVED_BODY_FIELDS`: the request fields
   * an app may not change. `max_completion_tokens` is listed as `max_tokens`. See `lockedFieldsIn`.
   */
  lockedFields: readonly string[];
}

/** What `parseSpec` hands back. A refused document is `spec: null` with the reasons in `errors`. */
export interface ParsedSpec {
  /** The document with everything that did not survive dropped, or null if it was refused. */
  spec: AgentSpec | null;
  /** Why it was refused. Empty when it was not. */
  errors: string[];
  /** What was dropped, and what is worth an operator's attention. Never a reason to refuse. */
  warnings: string[];
}

/** What `parseSpec` takes besides the document. */
export interface ParseSpecOptions {
  /**
   * Parse `bundle` rather than dropping it. Opt-in, because a bundled server carries a command
   * line and an environment map: loading one is equivalent to running a program, exactly as
   * dangerous as pasting somebody's `.mcp.json`, and an app has to make that decision rather than
   * inherit it from a default.
   *
   * @defaultValue `false`
   */
  bundle?: boolean;
  /**
   * The events this app actually fires. A hook bound elsewhere warns.
   *
   * @defaultValue `SPEC_EVENTS`, which is all of them
   */
  events?: readonly string[];
  /** The `extensions` keys this app understands. A `requires` entry outside it refuses the load. */
  understands?: readonly string[];
}

/** A `${VAR}`-shaped string, which is kept as the literal it is rather than expanded. */
const VARIABLE = /\$\{[^}]*\}/;

/**
 * A path as text, in `parseSpec`'s spelling, with a segment holding a dot quoted so it reads as one.
 *
 * @param path - The segments.
 * @returns `extensions["com.acme"].plan` for the key `com.acme`, and `extensions.com.acme` for
 * the key `acme` beneath the key `com`.
 */
export function pathText(path: readonly string[]): string {
  let text = '';
  for (const segment of path) {
    const holdsDot = segment.includes('.');
    if (holdsDot) {
      text += `[${JSON.stringify(segment)}]`;
    } else {
      text += text === '' ? segment : `.${segment}`;
    }
  }
  return text;
}

/** Problems in the order they were found, in `validateHooks`'s `path: what is wrong` shape. */
class Report {
  readonly errors: string[] = [];
  readonly warnings: string[] = [];

  /**
   * Records a reason to refuse the document.
   *
   * @param path - Where in the document the problem is, as `requires[2]`.
   * @param problem - What is wrong there, worded to follow the path and a colon.
   */
  fail(path: string, problem: string) {
    this.errors.push(`${path}: ${problem}`);
  }

  /**
   * Records a field that did not survive, as a warning.
   *
   * @param path - Where in the document the field is.
   * @param problem - Why it could not be used, worded to read before ", and was dropped".
   */
  drop(path: string, problem: string) {
    this.warnings.push(`${path}: ${problem}, and was dropped`);
  }

  /**
   * Records a warning about something that was kept as it is.
   *
   * @param path - Where in the document it is.
   * @param problem - What is worth an operator's attention there.
   */
  note(path: string, problem: string) {
    this.warnings.push(`${path}: ${problem}`);
  }

  /**
   * A string field, or nothing.
   *
   * @param path - Where the field is, for the warnings.
   * @param value - What the document held there.
   * @returns The string exactly as written, an empty one included. `undefined` where it is absent,
   * and where it is not a string, which is warned about as well.
   *
   * @remarks
   * Interpolation is never performed, so a `${VAR}` is reported as the literal it will stay — the
   * alternative hands whoever wrote the document the ability to read any variable the process has,
   * which is why the formats that do it need a credential denylist bolted on afterwards.
   */
  string(path: string, value: unknown): string | undefined {
    if (isAbsent(value)) {
      return undefined;
    }
    if (typeof value !== 'string') {
      return void this.drop(path, 'must be a string');
    }
    if (VARIABLE.test(value)) {
      this.note(path, 'looks like a variable reference, which is never expanded');
    }
    return value;
  }

  /**
   * A number field held to its bounds, or nothing.
   *
   * @param path - Where the field is, for the warning.
   * @param value - What the document held there.
   * @param least - The lowest value accepted, itself included.
   * @param [most] - The highest value accepted, itself included.
   * @returns The number as written. `undefined` where it is absent, and where it is not a finite
   * number or lies outside the bounds — dropped with a warning, never clamped.
   */
  number(path: string, value: unknown, least: number, most = Infinity): number | undefined {
    if (isAbsent(value)) {
      return undefined;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return void this.drop(path, 'must be a number');
    }
    // Dropped, never clamped: a clamp invents a number the author did not write, while dropping
    // falls back to one somebody did — the layer below, or nothing.
    if (value < least || value > most) {
      return void this.drop(
        path,
        `must be ${most === Infinity ? `at least ${least}` : `between ${least} and ${most}`}`,
      );
    }
    return value;
  }

  /**
   * A field that must be one member of a closed set, or nothing.
   *
   * @typeParam T - The set's members.
   * @param path - Where the field is, for the warning.
   * @param value - What the document held there.
   * @param members - Every member, in the order the warning lists them.
   * @returns The member as written. `undefined` where it is absent, and where it is not a member —
   * dropped with a warning that lists them all.
   */
  oneOf<T extends string>(path: string, value: unknown, members: readonly T[]): T | undefined {
    if (isAbsent(value)) {
      return undefined;
    }
    const member = members.find((known) => known === value);
    if (member === undefined) {
      const quoted = members.map((known) => `"${known}"`);
      return void this.drop(path, `must be ${quoted.slice(0, -1).join(', ')} or ${quoted.at(-1)}`);
    }
    return member;
  }

  /**
   * A boolean field, or nothing.
   *
   * @param path - Where the field is, for the warning.
   * @param value - What the document held there.
   * @returns The boolean as written. `undefined` where it is absent, and where it is anything but
   * `true` or `false` — dropped with a warning, never coerced.
   */
  boolean(path: string, value: unknown): boolean | undefined {
    if (isAbsent(value)) {
      return undefined;
    }
    if (typeof value !== 'boolean') {
      return void this.drop(path, 'must be true or false');
    }
    return value;
  }
}

/** What `kept` hands back: a field that could be undefined is one that may be absent instead. */
type Kept<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/**
 * Drops the keys whose value did not survive, so an absent field stays absent.
 *
 * @param fields - Read, not written to. Only `undefined` counts as not surviving: `0`, `""`,
 * `false` and `null` stay.
 * @returns A new object holding the keys that are left.
 */
function kept<T extends object>(fields: T): Kept<T> {
  // The one assertion: `Object.entries` forgets which keys it was handed, and `Kept` says them again.
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Kept<T>;
}

/**
 * Whether a parsed sub-object said anything at all.
 *
 * @param value - The object to ask about. Only its own keys are counted.
 * @returns `false` for an object with no keys, whatever the ones it has hold.
 *
 * @remarks
 * An empty one is the same as an absent one.
 */
const said = (value: object) => Object.keys(value).length > 0;

/**
 * Reads an endpoint section, the agent's or a side task's.
 *
 * @param report - Where what is dropped is written.
 * @param path - Where the section sits in the document: `endpoint`, or `tasks.title.endpoint`.
 * @param value - What the document held there.
 * @returns The fields that survived, or `undefined` where the section is absent, is not an object
 * or held nothing usable.
 *
 * @remarks
 * An `apiKey` or an `api_key` is dropped with a warning: a document carries no credentials.
 */
function parseEndpoint(report: Report, path: string, value: unknown): EndpointSpec | undefined {
  if (isAbsent(value)) {
    return undefined;
  }
  if (!isRecord(value)) {
    return void report.drop(path, 'must be an object');
  }
  const endpoint = kept({
    baseUrl: report.string(`${path}.baseUrl`, value.baseUrl),
    requestTimeoutSeconds: report.number(`${path}.requestTimeoutSeconds`, value.requestTimeoutSeconds, 0),
    firstTokenSeconds: report.number(`${path}.firstTokenSeconds`, value.firstTokenSeconds, 0),
  });
  if (!isAbsent(value.apiKey) || !isAbsent(value.api_key)) {
    report.drop(`${path}.apiKey`, 'is not part of this format — a document carries no credentials');
  }
  return said(endpoint) ? endpoint : undefined;
}

/** The highest temperature the wire takes. */
const MAX_TEMPERATURE = 2;

/**
 * The three fields a model and a side task both carry, held to the same bounds in each.
 *
 * @param report - Where what is dropped is written.
 * @param path - The section the fields sit in: `model`, or `tasks.title`.
 * @param value - That section.
 * @returns All three keys, each `undefined` where its field is absent or was dropped — a caller
 * puts the result through `kept`.
 */
const parseSampling = (report: Report, path: string, value: Record<string, unknown>) => ({
  maxTokens: report.number(`${path}.maxTokens`, value.maxTokens, 0),
  temperature: report.number(`${path}.temperature`, value.temperature, 0, MAX_TEMPERATURE),
  reasoningEffort: report.string(`${path}.reasoningEffort`, value.reasoningEffort),
});

/**
 * Reads the `model` section.
 *
 * @param report - Where what is dropped is written.
 * @param value - What the document held under `model`.
 * @returns The fields that survived — an empty object where none did — or `undefined` where the
 * section is absent or is not an object.
 */
function parseModel(report: Report, value: unknown): ModelSpec | undefined {
  if (isAbsent(value)) {
    return undefined;
  }
  if (!isRecord(value)) {
    return void report.drop('model', 'must be an object');
  }
  const reasoningReplay = report.oneOf('model.reasoningReplay', value.reasoningReplay, Object.values(ReasoningReplay));
  return kept({
    model: report.string('model.model', value.model),
    ...parseSampling(report, 'model', value),
    reasoningReplay,
    contextLength: report.number('model.contextLength', value.contextLength, 0),
    extraBody: parseExtraBody(report, 'model.extraBody', value.extraBody),
    lockedFields: parseLockedFields(report, value.lockedFields),
  });
}

/** The sampling fields `model` and each task spell as fields of their own, rather than in `extraBody`. */
type SpelledField = 'maxTokens' | 'temperature' | 'reasoningEffort';

/**
 * The request fields `model` and each task spell for themselves, by the field that spells each.
 *
 * @remarks
 * Apart from `RESERVED_BODY_FIELDS`, which are what the loop sets: these are what the document
 * sets elsewhere. Kept in `extraBody`, a copy would be spread over the stated value at send time,
 * past the negotiation that sends a temperature only to a model that takes one.
 */
const SPELLED_BODY_FIELDS: Readonly<Record<string, SpelledField>> = Object.freeze({
  temperature: 'temperature',
  max_tokens: 'maxTokens',
  max_completion_tokens: 'maxTokens',
  reasoning_effort: 'reasoningEffort',
});

/** The name `model.lockedFields` gives each spelled field: its request field's, `max_tokens` for both. */
const SPELLED_LOCK_NAMES: Readonly<Record<SpelledField, string>> = Object.freeze({
  maxTokens: 'max_tokens',
  temperature: 'temperature',
  reasoningEffort: 'reasoning_effort',
});

/**
 * The name a spelled field is locked by.
 *
 * @param field - A `ModelSpec` field's name, as `maxTokens`.
 * @returns Its request field's name, as `max_tokens`, or `undefined` for a field that is not spelled.
 */
function spelledLockName(field: unknown): string | undefined {
  return Object.entries(SPELLED_LOCK_NAMES).find(([spelled]) => spelled === field)?.[1];
}

/**
 * The name a request field is locked by.
 *
 * @param field - A request field's name, as a request or `model.lockedFields` writes it.
 * @returns `max_tokens` for `max_completion_tokens`, and any other name as it is.
 */
function lockName(field: string): string {
  const isSpelled = Object.hasOwn(SPELLED_BODY_FIELDS, field);
  return isSpelled ? SPELLED_LOCK_NAMES[SPELLED_BODY_FIELDS[field]] : field;
}

/**
 * Reads `model.lockedFields`.
 *
 * @param report - Where what is refused or dropped is written.
 * @param value - What the document held there.
 * @returns The names as written, less a repeat. `undefined` where it is absent or is refused.
 *
 * @remarks
 * Any name is kept, since it may be a provider's field, but a reserved one refuses the document: the
 * loop sets those, so locking one is a mistake about what the field is. A name listed twice, which
 * `max_tokens` and `max_completion_tokens` are, is warned about and kept once.
 */
function parseLockedFields(report: Report, value: unknown): string[] | undefined {
  if (isAbsent(value)) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return void report.fail('model.lockedFields', 'must be an array of request-field names');
  }
  const lockedFields: string[] = [];
  const seen = new Map<string, string>();
  for (const [index, name] of value.entries()) {
    const path = `model.lockedFields[${index}]`;
    if (typeof name !== 'string') {
      report.drop(path, 'must be a string');
    } else if (RESERVED_BODY_FIELDS.includes(name)) {
      report.fail(path, `"${name}" is the loop's to set, so it cannot be locked`);
    } else if (seen.has(lockName(name))) {
      report.drop(path, `"${name}" is listed already, as "${seen.get(lockName(name))}"`);
    } else {
      seen.set(lockName(name), name);
      lockedFields.push(name);
    }
  }
  return lockedFields;
}

/**
 * An `extraBody` less the fields something else sets: the `RESERVED_BODY_FIELDS` and the
 * `SPELLED_BODY_FIELDS`.
 *
 * @param extraBody - Read, not written to.
 * @returns A new object holding every other key.
 *
 * @remarks
 * `parseExtraBody` drops the same fields from one document and warns. This holds the rule for a
 * layer that never went through it: one built in code, or by `defineSpecColumns().toLayer`.
 */
function unownedFields(extraBody: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(extraBody).filter(([key]) => {
      const isOwned = RESERVED_BODY_FIELDS.includes(key) || Object.hasOwn(SPELLED_BODY_FIELDS, key);
      return isOwned === false;
    }),
  );
}

/**
 * Reads an `extraBody`, the agent's model's or a side task's.
 *
 * @param report - Where what is dropped is written.
 * @param path - Where it sits in the document: `model.extraBody`, or `tasks.title.extraBody`.
 * @param value - What the document held there.
 * @returns A new object without the `RESERVED_BODY_FIELDS` or the `SPELLED_BODY_FIELDS`, each of
 * which is warned about, or `undefined` where it is absent or is not an object. An empty one
 * survives as an empty one.
 */
function parseExtraBody(report: Report, path: string, value: unknown): Record<string, unknown> | undefined {
  if (isAbsent(value)) {
    return undefined;
  }
  if (!isRecord(value)) {
    return void report.drop(path, 'must be an object');
  }
  // `model`, or `tasks.title`: where the field that spells a dropped one sits.
  const owner = path.slice(0, -'.extraBody'.length);
  const extraBody: Record<string, unknown> = {};
  for (const [key, held] of Object.entries(value)) {
    const spelledAs = Object.hasOwn(SPELLED_BODY_FIELDS, key) ? SPELLED_BODY_FIELDS[key] : undefined;
    // The request is built around them and they would be overwritten anyway; better to say so on import.
    if (RESERVED_BODY_FIELDS.includes(key)) {
      report.drop(`${path}.${key}`, "is the loop's to set");
    } else if (spelledAs) {
      report.drop(`${path}.${key}`, `is ${owner}.${spelledAs}'s to set`);
    } else {
      extraBody[key] = held;
    }
  }
  return extraBody;
}

/** The roles a part may have, in the order a warning lists them. */
const ROLES = Object.values(PROMPT_ROLES);

/** The modes a part may have, in the order a warning lists them. */
const MODES = Object.values(PROMPT_MODES);

/** The first word of a name only an app's part may have: `APP_PART_PREFIX` without its `_`. */
const APP_WORD = APP_PART_PREFIX.replace(/_$/, '');

/** What a part name is split into words on, so `app_lane`, `app-lane` and `app lane` all begin `app`. */
const NAME_WORDS = /[\s_-]+/;

/**
 * Whether a part name is one only an app's part may have.
 *
 * @param name - The part's name, as written.
 * @returns `true` when its first word, read without case, is `app`: `app`, `app_lane`, `App lane`.
 */
const isAppName = (name: string) => name.split(NAME_WORDS).find(Boolean)?.toLowerCase() === APP_WORD;

/**
 * Reads the fields a prompt part has in common with a chat message: its role, name, content and mode.
 *
 * @param report - Where what is dropped is written.
 * @param path - Where the part sits: `prompt[2]`.
 * @param held - What was held there.
 * @returns The part, or `undefined` where it is not an object or has no name or no content.
 *
 * @remarks
 * A role that is missing or not one of `PROMPT_ROLES` is read as `system`, with a warning, since
 * every part has one and both are written alike. A mode that is not one of `PROMPT_MODES` is dropped.
 */
function readPart(report: Report, path: string, held: unknown): AppPart | undefined {
  if (!isRecord(held)) {
    return void report.drop(path, 'must be an object');
  }
  const name = report.string(`${path}.name`, held.name);
  if (!name) {
    return void report.drop(path, 'has no name, and merging happens on the name');
  }
  // An empty content is how a layer deletes the part below it, so it is not the same as none.
  const content = report.string(`${path}.content`, held.content);
  if (content === undefined) {
    return void report.drop(path, 'has no content');
  }
  let role = ROLES.find((known) => known === held.role);
  if (role === undefined) {
    const quoted = ROLES.map((known) => `"${known}"`).join(' or ');
    const problem = isAbsent(held.role) ? 'is missing' : `must be ${quoted}`;
    report.note(`${path}.role`, `${problem}, and was read as "${PROMPT_ROLES.system}"`);
    role = PROMPT_ROLES.system;
  }
  return kept({ role, name, content, mode: report.oneOf(`${path}.mode`, held.mode, MODES) });
}

/**
 * Reads a part's `allowedModes`.
 *
 * @param report - Where what is dropped is written.
 * @param path - Where the list sits: `prompt[2].allowedModes`.
 * @param value - What the document held there.
 * @returns The modes, in the order written. `undefined` where it is absent or is not an array.
 *
 * @remarks
 * An entry that is not a mode is dropped and the list kept, so a list that loses every entry locks
 * the part: a mistake leaves an app able to do less, never more.
 */
function parseAllowedModes(report: Report, path: string, value: unknown): PromptMode[] | undefined {
  if (isAbsent(value)) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return void report.drop(path, 'must be an array of modes');
  }
  const modes: PromptMode[] = [];
  for (const [index, held] of value.entries()) {
    const mode = report.oneOf(`${path}[${index}]`, held, MODES);
    if (mode) {
      modes.push(mode);
    }
  }
  return modes;
}

/**
 * Reads the `prompt` array, part by part.
 *
 * @param report - Where what is dropped, and a name only an app may use, is written.
 * @param value - The array, already known to be one.
 * @returns The parts that survived, in the document's order. Empty where none did.
 *
 * @remarks
 * A part goes whole where `readPart` refuses it, and a name whose first word is `app` refuses the
 * document. An empty content is kept, since it is how a layer deletes the part below it, but a mode
 * beside one means nothing and goes.
 */
function parsePrompt(report: Report, value: unknown[]): PromptPart[] {
  const parts: PromptPart[] = [];
  for (const [index, held] of value.entries()) {
    const path = `prompt[${index}]`;
    const part = readPart(report, path, held);
    if (!part) {
      continue;
    }
    if (isAppName(part.name)) {
      report.fail(`${path}.name`, `"${part.name}" has "${APP_WORD}" as its first word, which only an app's parts may`);
      continue;
    }
    const allowedModes = isRecord(held)
      ? parseAllowedModes(report, `${path}.allowedModes`, held.allowedModes)
      : undefined;
    const deletesWithMode = part.content === '' && part.mode !== undefined;
    if (deletesWithMode) {
      report.drop(`${path}.mode`, 'means nothing beside an empty content, which deletes the part');
    }
    parts.push(kept({ ...part, mode: deletesWithMode ? undefined : part.mode, allowedModes }));
  }
  return parts;
}

/** What `parseAppParts` hands back. */
export interface ParsedAppParts {
  /** The parts that survived, in the order sent. */
  parts: AppPart[];
  /** What was dropped, in `parseSpec`'s `path: what is wrong` shape, each path opening `prompt`. */
  warnings: string[];
}

/**
 * Reads the parts an app sent in a request's `agent_core.prompt`, dropping what it cannot use.
 *
 * @param value - What the request held under `prompt`: anything at all. Absent is no parts.
 * @returns The parts that survived, and what was dropped. Nothing is refused.
 *
 * @remarks
 * A part is read as a document's is: one with no name or no content goes, a role that is missing or
 * unknown is read as `system`, and an unknown mode is dropped. `allowedModes` is the agent's to set,
 * so it is dropped too. The names are the app's own and are not checked here; `stackAppParts` holds
 * them to its rules.
 */
export function parseAppParts(value: unknown): ParsedAppParts {
  const report = new Report();
  const parts: AppPart[] = [];
  if (isAbsent(value)) {
    return { parts, warnings: report.warnings };
  }
  if (!Array.isArray(value)) {
    report.drop('prompt', 'must be an array');
    return { parts, warnings: report.warnings };
  }
  for (const [index, held] of value.entries()) {
    const path = `prompt[${index}]`;
    const part = readPart(report, path, held);
    if (!part) {
      continue;
    }
    const setsAllowedModes = isRecord(held) && isAbsent(held.allowedModes) === false;
    if (setsAllowedModes) {
      report.drop(`${path}.allowedModes`, "is the agent's to set");
    }
    parts.push(part);
  }
  return { parts, warnings: report.warnings };
}

/**
 * Reads the `tools` section.
 *
 * @param report - Where what is dropped is written.
 * @param value - What the document held under `tools`.
 * @returns The fields that survived — an empty object where none did — or `undefined` where the
 * section is absent or is not an object.
 *
 * @remarks
 * `servers` keeps its three answers apart: absent stays absent, and an empty array comes back as
 * one. An entry that is empty or not a string is left out, and a list that loses every entry is
 * still a list.
 */
function parseTools(report: Report, value: unknown): ToolsSpec | undefined {
  if (isAbsent(value)) {
    return undefined;
  }
  if (!isRecord(value)) {
    return void report.drop('tools', 'must be an object');
  }
  const discovery = report.oneOf('tools.discovery', value.discovery, Object.values(ToolDiscovery));
  let servers: string[] | undefined;
  if (!isAbsent(value.servers)) {
    if (!Array.isArray(value.servers)) {
      report.drop('tools.servers', 'must be an array of slugs');
    } else {
      // The empty array survives on purpose: it is "no servers", and collapsing it into absent
      // would turn a scoped agent into one holding every tool on the box.
      servers = [];
      for (const [index, slug] of value.servers.entries()) {
        const name = report.string(`tools.servers[${index}]`, slug);
        if (name) {
          servers.push(name);
        } else if (name === '') {
          report.drop(`tools.servers[${index}]`, 'is empty');
        }
      }
    }
  }
  return kept({
    discovery,
    maxIterations: report.number('tools.maxIterations', value.maxIterations, 1),
    servers,
  });
}

/**
 * Reads the `retry` section.
 *
 * @param report - Where what is dropped is written.
 * @param value - What the document held under `retry`.
 * @returns The fields that survived, or `undefined` where the section is absent, is not an object
 * or held nothing usable.
 */
function parseRetry(report: Report, value: unknown): RetrySpec | undefined {
  if (isAbsent(value)) {
    return undefined;
  }
  if (!isRecord(value)) {
    return void report.drop('retry', 'must be an object');
  }
  const retry = kept({
    maxRetries: report.number('retry.maxRetries', value.maxRetries, 0),
    loadingTimeoutSeconds: report.number('retry.loadingTimeoutSeconds', value.loadingTimeoutSeconds, 0),
  });
  return said(retry) ? retry : undefined;
}

/**
 * Reads the `tasks` record, whatever its keys are.
 *
 * @param report - Where what is dropped is written.
 * @param value - The record, already known to be one.
 * @returns A new record of the tasks that are objects, under the keys the document used. A task
 * that said nothing usable comes back as an empty object; one that is `null` or not an object is
 * left out.
 */
function parseTasks(report: Report, value: Record<string, unknown>): Record<string, TaskSpec> {
  const tasks: Record<string, TaskSpec> = {};
  for (const [key, held] of Object.entries(value)) {
    const path = pathText(['tasks', key]);
    if (isAbsent(held)) {
      continue;
    }
    if (!isRecord(held)) {
      report.drop(path, 'must be an object');
      continue;
    }
    // An unknown key is not warned about: an app may run side tasks this package has never
    // heard of, and `AGENT_TASKS` is documentation rather than a validator.
    tasks[key] = kept({
      model: report.string(`${path}.model`, held.model),
      endpoint: parseEndpoint(report, `${path}.endpoint`, held.endpoint),
      ...parseSampling(report, path, held),
      extraBody: parseExtraBody(report, `${path}.extraBody`, held.extraBody),
    });
  }
  return tasks;
}

/**
 * A hook's `inject` and `veto`, less the ones its event cannot honour.
 *
 * @param hook - The event, and the flags as stated.
 * @returns Each flag as stated, or `undefined` where it is `true` on an event that cannot honour
 * it, and why under `dropped`, by flag. `dropped` is empty where both stand.
 *
 * @remarks
 * Only `INJECT_EVENTS` run before a model reply a hook's result could reach, and only
 * `beforeCompact` announces something a hook can decline.
 */
function honouredFlags({ on, inject, veto }: Pick<AgentHook, 'on' | 'inject' | 'veto'>) {
  const dropped: { inject?: string; veto?: string } = {};
  if (inject && !INJECT_EVENTS.has(on)) {
    dropped.inject = `"${on}" runs after the model has already answered`;
  }
  if (veto && on !== HookEvent.BeforeCompact) {
    dropped.veto = `"${on}" announces nothing a hook can decline`;
  }
  return {
    inject: dropped.inject ? undefined : inject,
    veto: dropped.veto ? undefined : veto,
    dropped,
  };
}

/**
 * Reads the `hooks` array, hook by hook.
 *
 * @param report - Where what is dropped or noted is written.
 * @param value - The array, already known to be one.
 * @param events - The events this app fires. A hook bound to any other of `SPEC_EVENTS` is kept
 * and noted.
 * @returns The hooks that survived, in the document's order. Empty where none did.
 *
 * @remarks
 * A hook goes whole where it is not an object, lacks a non-empty `id`, `on`, `server` or `tool`,
 * or is bound to something that is not one of `SPEC_EVENTS`. An `inject: true` or a `veto: true`
 * its event cannot honour goes alone. `args` is carried unread.
 */
function parseHooks(report: Report, value: unknown[], events: readonly string[]): AgentHook[] {
  const hooks: AgentHook[] = [];
  for (const [index, held] of value.entries()) {
    const path = `hooks[${index}]`;
    if (!isRecord(held)) {
      report.drop(path, 'must be an object');
      continue;
    }
    const id = report.string(`${path}.id`, held.id);
    const server = report.string(`${path}.server`, held.server);
    const tool = report.string(`${path}.tool`, held.tool);
    const written = report.string(`${path}.on`, held.on);
    if (!id || !server || !tool || !written) {
      report.drop(path, 'needs an id, an event, a server and a tool');
      continue;
    }
    const event = SPEC_EVENTS.find((known) => known === written);
    if (!event) {
      report.drop(`${path}.on`, `"${written}" is not an event`);
      continue;
    }
    // An app that never compacts refuses to save a `beforeCompact` hook today, which makes an
    // otherwise good agent unimportable. Kept and noted instead.
    if (!events.includes(event)) {
      report.note(`${path}.on`, `"${event}" is never fired by this host`);
    }
    const { dropped, inject, veto } = honouredFlags({
      on: event,
      inject: report.boolean(`${path}.inject`, held.inject),
      veto: report.boolean(`${path}.veto`, held.veto),
    });
    for (const [flag, reason] of Object.entries(dropped)) {
      report.drop(`${path}.${flag}`, reason);
    }
    hooks.push(
      kept({
        id,
        on: event,
        server,
        tool,
        args: isAbsent(held.args) ? undefined : held.args,
        inject,
        veto,
        maxTokens: report.number(`${path}.maxTokens`, held.maxTokens, 0),
        timeoutMs: report.number(`${path}.timeoutMs`, held.timeoutMs, 0),
        enabled: report.boolean(`${path}.enabled`, held.enabled),
      }),
    );
  }
  return hooks;
}

/**
 * Reads the `bundle` section, which `parseSpec` hands over only once an app has opted in.
 *
 * @param report - Where what is dropped is written.
 * @param value - What the document held under `bundle`.
 * @returns The servers that survived, possibly none, or `undefined` where the section or its
 * `mcpServers` is absent or of the wrong kind. Each server is the object the document held, not a
 * copy, and no other key of `bundle` is carried.
 *
 * @remarks
 * A server goes where it is not an object, has neither a non-empty `slug` nor a non-empty `id`, or
 * repeats the effective slug of one before it. Nothing else about it is read.
 */
function parseBundle(report: Report, value: unknown): SpecBundle | undefined {
  if (isAbsent(value)) {
    return undefined;
  }
  if (!isRecord(value)) {
    return void report.drop('bundle', 'must be an object');
  }
  if (isAbsent(value.mcpServers)) {
    return undefined;
  }
  if (!Array.isArray(value.mcpServers)) {
    return void report.drop('bundle.mcpServers', 'must be an array');
  }
  const seen = new Set<string>();
  const servers: SpecServer[] = [];
  for (const [index, held] of value.mcpServers.entries()) {
    const path = `bundle.mcpServers[${index}]`;
    if (!isRecord(held)) {
      report.drop(path, 'must be an object');
      continue;
    }
    const slug = typeof held.slug === 'string' && held.slug ? held.slug : undefined;
    const id = typeof held.id === 'string' && held.id ? held.id : undefined;
    const effective = slug ?? id;
    if (!effective) {
      report.drop(path, 'needs an id or a slug');
      continue;
    }
    if (seen.has(effective)) {
      report.drop(path, `is a second server called "${effective}"`);
      continue;
    }
    seen.add(effective);
    // Everything else is passed through untouched, including keys this package has no name for.
    servers.push(held as SpecServer);
  }
  return { mcpServers: servers };
}

/** The keys this version names. Anything else is a later 2.x, and is carried rather than erased. */
const KNOWN = new Set([
  'spec',
  '$schema',
  'id',
  'name',
  'description',
  'endpoint',
  'model',
  'prompt',
  'promptLayout',
  'tools',
  'retry',
  'tasks',
  'hooks',
  'bundle',
  'extensions',
  'requires',
]);

/**
 * Reads a document, dropping what it cannot use and refusing only what it cannot identify.
 *
 * @param document - Anything at all — this is the front door, and it is given parsed JSON from a
 * form, a file or another app.
 * @param [options] - Whether to parse a bundle, which events this app fires, and which extension
 * keys it understands.
 * @returns The document that survived — a new object, never the one handed in — or `spec: null`
 * where `errors` holds anything. `warnings` is filled either way.
 *
 * @remarks
 * Every problem is reported at once, in `validateHooks`'s `path: what is wrong` shape, so an
 * operator fixes a document in one round trip. The hard errors are about the document itself — not
 * an object, a missing or foreign `spec` token, a container of the wrong kind, a prompt part named
 * as an app's, a `requires` entry that is not a string or not understood — and anything else drops
 * the field with a warning, an out-of-range value dropped rather than clamped. A foreign version,
 * version 1 included, is refused where `importCapabilities` shrugs, because an agent of the wrong
 * version is not the agent its author described; `upgradeSpec` converts a version 1 document.
 */
export function parseSpec(document: unknown, options: ParseSpecOptions = {}): ParsedSpec {
  const report = new Report();
  const events = options.events ?? SPEC_EVENTS;
  if (!isRecord(document)) {
    report.fail('spec', 'must be an object');
    return { spec: null, errors: report.errors, warnings: report.warnings };
  }

  const token = document.spec;
  if (typeof token !== 'string') {
    report.fail('spec', `must be "${AGENT_SPEC}"`);
  } else if (token !== AGENT_SPEC) {
    const major = Number(token.split('/')[1]);
    const named = token.startsWith('cubicecho.agent/') && Number.isInteger(major);
    const upgrade = token === AGENT_SPEC_V1 ? ', which upgradeSpec converts it to' : '';
    report.fail(
      'spec',
      named
        ? `is version ${major}, and this build reads version ${AGENT_SPEC_VERSION}${upgrade}`
        : `must be "${AGENT_SPEC}"`,
    );
  }

  // Containers are checked before their contents: "prompt must be an array" is a different
  // mistake from "this prompt part has no id", and only the first is worth refusing over.
  if (!isAbsent(document.prompt) && !Array.isArray(document.prompt)) {
    report.fail('prompt', 'must be an array');
  }
  if (!isAbsent(document.tasks) && !isRecord(document.tasks)) {
    report.fail('tasks', 'must be an object');
  }
  if (!isAbsent(document.hooks) && !Array.isArray(document.hooks)) {
    report.fail('hooks', 'must be an array');
  }

  const requires: string[] = [];
  if (!isAbsent(document.requires)) {
    if (!Array.isArray(document.requires)) {
      report.fail('requires', 'must be an array');
    } else {
      for (const [index, key] of document.requires.entries()) {
        if (typeof key !== 'string') {
          report.fail(`requires[${index}]`, 'must be a string');
          continue;
        }
        // Fails closed: an agent that must not run without its sandbox extension can say so.
        if (options.understands && !options.understands.includes(key)) {
          report.fail(`requires[${index}]`, `"${key}" is not understood by this host`);
        }
        requires.push(key);
      }
    }
  }

  let extensions: Record<string, unknown> | undefined;
  if (!isAbsent(document.extensions)) {
    if (!isRecord(document.extensions)) {
      report.drop('extensions', 'must be an object');
    }
    // Never validated beyond being an object. It is the escape hatch, and the one place an app
    // can put what this package has no name for without being told about it.
    else {
      extensions = document.extensions;
    }
  }

  if (!isAbsent(document.bundle) && !options.bundle) {
    report.drop('bundle', 'carries a command line, so it is only read with { bundle: true }');
  }

  const spec: AgentSpec = {
    spec: AGENT_SPEC,
    ...kept({
      $schema: report.string('$schema', document.$schema),
      id: report.string('id', document.id),
      name: report.string('name', document.name),
      description: report.string('description', document.description),
      endpoint: parseEndpoint(report, 'endpoint', document.endpoint),
      model: parseModel(report, document.model),
      prompt: Array.isArray(document.prompt) ? parsePrompt(report, document.prompt) : undefined,
      promptLayout: report.oneOf('promptLayout', document.promptLayout, Object.values(PROMPT_LAYOUTS)),
      tools: parseTools(report, document.tools),
      retry: parseRetry(report, document.retry),
      tasks: isRecord(document.tasks) ? parseTasks(report, document.tasks) : undefined,
      hooks: Array.isArray(document.hooks) ? parseHooks(report, document.hooks, events) : undefined,
      bundle: options.bundle ? parseBundle(report, document.bundle) : undefined,
      extensions,
      requires: isAbsent(document.requires) ? undefined : requires,
    }),
  };

  for (const [key, held] of Object.entries(document)) {
    if (KNOWN.has(key)) {
      continue;
    }
    // Kept, not erased: an app stores what it was given and resolves on read, so a key from a
    // later 2.x survives an edit-and-export cycle instead of dying at the first app to open it.
    report.note(key, 'is not a key this version names, and was carried through unread');
    spec[key] = held;
  }

  return {
    spec: report.errors.length ? null : spec,
    errors: report.errors,
    warnings: report.warnings,
  };
}

/** What `upgradeSpec` hands back. */
export interface UpgradedSpec {
  /** The version 2 document, new; or the one handed in, untouched, where it was not version 1. */
  document: unknown;
  /** Whether it was a version 1 document, and so was converted. */
  upgraded: boolean;
  /** What the conversion dropped, in `parseSpec`'s `path: what is wrong` shape. */
  warnings: string[];
}

/**
 * Converts a version 1 agent document into version 2, for `parseSpec` to read.
 *
 * @param document - Anything at all: a stored document of either version, or parsed JSON.
 * @returns The converted document and what it lost. Anything that is not a version 1 document, a
 * version 2 one included, comes back as it was, with `upgraded: false`.
 *
 * @remarks
 * Only the token and the prompt parts change: each part's `id` becomes its `name`, its `text` its
 * `content`, and its `role` is `system`. Version 2 has no references, so a `ref` goes, and a part
 * that had only a `ref` goes whole, each with a warning. Nothing else is checked here; `parseSpec`
 * does that next.
 */
export function upgradeSpec(document: unknown): UpgradedSpec {
  const isVersion1 = isRecord(document) && document.spec === AGENT_SPEC_V1;
  if (isVersion1 === false) {
    return { document, upgraded: false, warnings: [] };
  }
  const report = new Report();
  const { prompt } = document;
  const upgraded: Record<string, unknown> = { ...document, spec: AGENT_SPEC };
  if (Array.isArray(prompt)) {
    upgraded.prompt = prompt.flatMap((held, index) => upgradePart(report, `prompt[${index}]`, held));
  }
  return { document: upgraded, upgraded: true, warnings: report.warnings };
}

/**
 * One version 1 prompt part as version 2 writes it.
 *
 * @param report - Where a dropped reference is written.
 * @param path - Where the part sits: `prompt[2]`.
 * @param held - The part as version 1 held it.
 * @returns The part, new, in a list of one; an empty list where it had only a reference. What is
 * not an object comes back as it was, for `parseSpec` to report.
 */
function upgradePart(report: Report, path: string, held: unknown): unknown[] {
  if (!isRecord(held)) {
    return [held];
  }
  const { id, text, ref, ...rest } = held;
  const hasRef = isAbsent(ref) === false;
  const hasText = isAbsent(text) === false;
  if (hasRef && hasText) {
    report.drop(`${path}.ref`, 'is a reference, which version 2 does not read');
  } else if (hasRef) {
    report.drop(path, 'had only a reference, which version 2 does not read');
    return [];
  }
  return [{ role: PROMPT_ROLES.system, ...rest, ...kept({ name: id ?? undefined, content: text ?? undefined }) }];
}

/**
 * Merges the layers that named a key, last one winning, and leaves it absent if none did.
 *
 * @param layers - One section from each document, weakest first. A document without the section
 * gives `undefined`, which is skipped, and a key holding `undefined` overrides nothing.
 * @returns A new object, one level deep — empty where no layer said anything.
 */
const mergeLayers = <T extends object>(layers: readonly (T | undefined)[]): T =>
  Object.assign({}, ...layers.map((layer) => kept(layer ?? {})));

/**
 * An `Endpoint` as the loop takes one.
 *
 * @param spec - The merged endpoint section. Read, not written to.
 * @returns A new object: `baseUrl` is `""` where no layer gave one, and a timeout no layer stated
 * stays absent.
 *
 * @remarks
 * `apiKey` is always empty; see `resolveAgentSpec`.
 */
const asEndpoint = (spec: EndpointSpec): Endpoint => ({
  baseUrl: spec.baseUrl ?? '',
  apiKey: '',
  ...kept({
    requestTimeoutSeconds: spec.requestTimeoutSeconds,
    firstTokenSeconds: spec.firstTokenSeconds,
  }),
});

/**
 * The layers' `model` sections as one, with their `extraBody` merged by top-level key beside it.
 *
 * @param layers - The documents, weakest first. None is written to.
 * @returns `model`, holding the last stated value of every field but `extraBody` and `lockedFields`;
 * `extraBody` apart from it, less the fields something else sets; and `lockedFields`, every layer's.
 *
 * @remarks
 * A lock binds the layers above the one that states it, so a locked field keeps the value the
 * locking layer gave it, or the one resolved below it. The `RESERVED_BODY_FIELDS` never lock.
 */
function mergeModel(layers: readonly AgentSpec[]) {
  const model: ModelSpec = {};
  const extraBody: Record<string, unknown> = {};
  const locked = new Set<string>();
  for (const layer of layers) {
    const { extraBody: layerBody, lockedFields: layerLocks, ...fields } = layer.model ?? {};
    for (const [key, value] of Object.entries(fields)) {
      const requestName = spelledLockName(key);
      const isLocked = requestName !== undefined && locked.has(requestName);
      if (value !== undefined && isLocked === false) {
        (model as Record<string, unknown>)[key] = value;
      }
    }
    for (const [key, value] of Object.entries(layerBody ?? {})) {
      if (value !== undefined && locked.has(lockName(key)) === false) {
        extraBody[key] = value;
      }
    }
    for (const name of layerLocks ?? []) {
      if (RESERVED_BODY_FIELDS.includes(name) === false) {
        locked.add(lockName(name));
      }
    }
  }
  return { model, extraBody: unownedFields(extraBody), lockedFields: [...locked] };
}

/**
 * The locked fields among those a would-be layer or an app's request sets, so a host can name them.
 *
 * @param resolved - The agent, as `resolveAgentSpec` returned it.
 * @param fields - Wire names: a request body's keys, its `extra_body` spread in, or a layer's fields.
 * @returns The ones locked, as given: `max_completion_tokens` stays itself when `max_tokens` is locked.
 * Empty when none is.
 *
 * @remarks
 * Setting a field is changing it, whatever the value, so pass the keys a request sets rather than
 * the ones whose value differs. Resolving drops what this names, silently.
 */
export function lockedFieldsIn(resolved: ResolvedAgent, fields: Iterable<string>): string[] {
  return [...fields].filter((field) => resolved.lockedFields.includes(lockName(field)));
}

/**
 * Items merged by id, ordered by first appearance: different ids stack, and the same id is laid
 * over the one before it.
 *
 * @param items - Every layer's items in one list, weakest first. None is written to.
 * @param idOf - What an item merges on. `""` is an id like any other.
 * @returns A new array of new objects, each the shallow merge of the items that shared its id. An
 * item `idOf` gives no id for is left out.
 */
function mergeById<T extends object>(items: readonly T[], idOf: (item: T) => string | undefined): T[] {
  const merged = new Map<string, T>();
  for (const item of items) {
    const id = idOf(item);
    if (id !== undefined) {
      merged.set(id, { ...merged.get(id), ...item });
    }
  }
  return [...merged.values()];
}

/**
 * A document's prompt part as stacking leaves it: the agent's, under a name, perhaps marked.
 *
 * @param part - The part as the document has it. Not written to.
 * @param name - The name it is stacked under: its own, or a numbered one when it adds a part.
 * @param [mark] - The part it extends or replaces.
 * @returns A new part, with its own copy of `allowedModes`.
 */
const asStacked = (part: PromptPart, name: string, mark?: StackedPart['mark']): StackedPart =>
  kept({
    role: part.role,
    name,
    content: part.content,
    owner: PART_OWNERS.agent,
    mark,
    allowedModes: part.allowedModes && [...part.allowedModes],
  });

/**
 * The layers' prompt parts as one list, each part applied to the parts before it.
 *
 * @param layers - The documents, weakest first. None is written to.
 * @returns New parts, owned by the agent, in the order their names were first taken.
 *
 * @remarks
 * With no mode, a part overwrites the content of the part with its name in place, still marked as
 * that part was, or is added under its own name. With a mode and a name already there, it adds a
 * part of its own, numbered (`identity_2`), after the parts already there and marked against that
 * name. An empty content deletes the part and every part marked against it; a part that names it
 * later starts afresh, in the place the name first had.
 */
function resolvePrompt(layers: readonly AgentSpec[]): StackedPart[] {
  // A deleted name keeps its key, holding nothing, so a part above it takes the same place.
  const merged = new Map<string, StackedPart | undefined>();
  const remove = (name: string) => {
    merged.set(name, undefined);
    for (const [other, part] of merged) {
      if (part?.mark?.target === name) {
        remove(other);
      }
    }
  };

  for (const part of layers.flatMap((layer) => layer.prompt ?? [])) {
    const below = merged.get(part.name);
    const isDeletion = part.content === '';
    if (isDeletion) {
      remove(part.name);
      continue;
    }
    const { mode } = part;
    const addsOwnPart = mode !== undefined && below !== undefined;
    if (addsOwnPart) {
      const name = numberedName(part.name, merged);
      merged.set(name, asStacked(part, name, { mode, target: part.name }));
      continue;
    }
    const allowedModes = part.allowedModes ?? below?.allowedModes;
    merged.set(part.name, asStacked({ ...part, allowedModes }, part.name, below?.mark));
  }
  return [...merged.values()].filter((part) => part !== undefined);
}

/**
 * The layers' side tasks as the loop takes them, each on the agent's endpoint with its own laid
 * over it.
 *
 * @param layers - The documents, weakest first. None is written to.
 * @param endpoint - The agent's merged endpoint. Read, not written to.
 * @returns The tasks whose merged `model` is not empty, keyed as the documents keyed them — one a
 * layer declined with `model: ""` is not among them. A task's `extraBody` merges by key, less the
 * fields something else sets.
 */
function resolveTasks(layers: readonly AgentSpec[], endpoint: EndpointSpec) {
  const merged = new Map<string, TaskSpec>();
  for (const layer of layers) {
    for (const [key, task] of Object.entries(layer.tasks ?? {})) {
      const below = merged.get(key);
      merged.set(key, {
        ...below,
        ...task,
        endpoint: mergeLayers([below?.endpoint, task.endpoint]),
        extraBody: mergeLayers([below?.extraBody, task.extraBody]),
      });
    }
  }
  const tasks: Record<string, ResolvedTask> = {};
  for (const [key, task] of merged) {
    // `model: ""` is how a layer declines a task a layer below it configured, so the entry goes
    // rather than coming back with an empty model for the app to interpret.
    if (!task.model) {
      continue;
    }
    const extraBody = task.extraBody && unownedFields(task.extraBody);
    tasks[key] = kept({
      model: task.model,
      endpoint: asEndpoint(mergeLayers([endpoint, task.endpoint])),
      maxTokens: task.maxTokens,
      temperature: task.temperature,
      reasoningEffort: task.reasoningEffort,
      extraBody: extraBody && said(extraBody) ? extraBody : undefined,
    });
  }
  return tasks;
}

/**
 * Layers documents into the flat object the loop takes, weakest first.
 *
 * @param layers - The documents, weakest first: settings, then the agent, then a task, then
 * a stage.
 * @returns The resolved agent, built new. Always whole: an empty list gives empty strings and
 * `AGENT_DEFAULTS` rather than an error, and `apiKey` is `""` whatever the layers said.
 *
 * @remarks
 * Absent inherits, and nothing else does: `0`, `-1`, `""` and `[]` are values that mean what they
 * say. Scalars take the last layer that has the key, `extraBody` and `extensions` merge by top-level
 * key, `prompt` merges by part name as each part's mode says, `hooks` and `tasks` merge by id
 * (different ids stack, the same id replaces), `tools.servers` replaces whole, and `requires` and
 * `model.lockedFields` union, a locked field keeping its value from below. No layer is ever fetched, and
 * `apiKey` comes back empty so that a document naming somebody else's model server cannot make this
 * app send its own key there; an app that wants inheritance applies `resolveApiKey` afterwards.
 */
export function resolveAgentSpec(layers: readonly AgentSpec[]): ResolvedAgent {
  const endpoint = mergeLayers(layers.map((layer) => layer.endpoint));

  const { model, extraBody, lockedFields } = mergeModel(layers);

  // `servers` is replaced whole rather than unioned: a list, an empty list and no list are three
  // answers, and a union of the first two is the first, which loses the scoping the operator
  // asked for. Copied, so the resolved agent does not share an array with the layer it came from.
  const tools = mergeLayers(layers.map((layer) => layer.tools));
  if (tools.servers) {
    tools.servers = [...tools.servers];
  }

  const retry = mergeLayers(layers.map((layer) => layer.retry));

  const tasks = resolveTasks(layers, endpoint);
  const prompt = resolvePrompt(layers);
  // Each layer's flags were checked against that layer's event, and the merge may have moved the
  // hook to another one, so they are checked again. Nothing is reported: resolving has no warnings.
  const hooks = mergeById(
    layers.flatMap((layer) => layer.hooks ?? []),
    (hook) => hook.id,
  ).map((hook) => {
    const { dropped, ...flags } = honouredFlags(hook);
    return kept({ ...hook, ...flags });
  });
  const servers = mergeById(
    layers.flatMap((layer) => layer.bundle?.mcpServers ?? []),
    (server) => (server.slug ?? server.id) || undefined,
  );

  const extensions: Record<string, unknown> = {};
  for (const layer of layers) {
    Object.assign(extensions, layer.extensions ?? {});
  }

  const requires = new Set<string>();
  for (const layer of layers) {
    for (const key of layer.requires ?? []) {
      requires.add(key);
    }
  }

  const id = layers.findLast((layer) => !isAbsent(layer.id))?.id ?? '';
  const name = layers.findLast((layer) => !isAbsent(layer.name))?.name;
  const description = layers.findLast((layer) => !isAbsent(layer.description))?.description;
  const promptLayout = layers.findLast((layer) => !isAbsent(layer.promptLayout))?.promptLayout;

  return {
    id,
    name: name ?? id,
    description: description ?? '',
    baseUrl: endpoint.baseUrl ?? '',
    apiKey: '',
    ...kept({
      requestTimeoutSeconds: endpoint.requestTimeoutSeconds,
      firstTokenSeconds: endpoint.firstTokenSeconds,
      loadingTimeoutSeconds: retry.loadingTimeoutSeconds,
      reasoningEffort: model.reasoningEffort,
      reasoningReplay: model.reasoningReplay,
      extraBody: said(extraBody) ? extraBody : undefined,
      servers: tools.servers,
    }),
    model: model.model ?? '',
    maxTokens: model.maxTokens ?? AGENT_DEFAULTS.maxTokens,
    temperature: model.temperature ?? AGENT_DEFAULTS.temperature,
    contextLength: model.contextLength ?? AGENT_DEFAULTS.contextLength,
    toolDiscovery: tools.discovery ?? AGENT_DEFAULTS.toolDiscovery,
    toolSelectModel: tasks.toolSelect?.model ?? '',
    maxToolIterations: tools.maxIterations ?? AGENT_DEFAULTS.maxToolIterations,
    maxRetries: retry.maxRetries ?? AGENT_DEFAULTS.maxRetries,
    // Byte-identical to what a consumer's `systemPromptFor` produces where no part has a mode, so
    // four sources survive a round trip instead of flattening into one blob nobody can edit a third of.
    systemPrompt: plainPrompt(prompt),
    prompt,
    promptLayout: promptLayout ?? AGENT_DEFAULTS.promptLayout,
    tasks,
    hooks,
    mcpServers: servers,
    extensions,
    requires: [...requires],
    lockedFields,
  };
}

/** What `exportSpec` takes besides the document. */
export interface ExportSpecOptions {
  /**
   * Keep the environment and headers of bundled servers. Opt-in, mirroring the pool's
   * `state({ secrets })`, because those are where a bundled server's credentials live.
   *
   * @defaultValue `false`
   */
  secrets?: boolean;
}

/**
 * A document fit to leave the app: the same agent, with the secrets of its bundled servers gone.
 *
 * @param spec - A document, ordinarily one `parseSpec` returned.
 * @param [options] - Whether to keep the secrets.
 * @returns A copy one level deep, never `spec` itself: what is not redacted is shared with the
 * original.
 *
 * @remarks
 * The property worth keeping is that **a redacted spec is still a valid spec** — it parses, it
 * resolves, and what comes back is the same agent pointed at the same servers, needing only the
 * credentials the importing app supplies itself. So a bundled server loses its `env` and its
 * `headers` and nothing else, and nothing outside `bundle` is redacted: those two are the only
 * fields the format gives a credential. A server can still carry one where the format gives it no
 * field — an `--api-key` among its `args`, a token in its `url` — and that is kept, because
 * cutting it would point the agent at a different server. `findSpecSecrets` says where to look.
 */
export function exportSpec(spec: AgentSpec, { secrets = false }: ExportSpecOptions = {}): AgentSpec {
  if (secrets || !spec.bundle?.mcpServers) {
    return { ...spec };
  }
  return {
    ...spec,
    bundle: {
      ...spec.bundle,
      mcpServers: spec.bundle.mcpServers.map(({ env: _env, headers: _headers, ...rest }) => rest),
    },
  };
}

/** Why `findSpecSecrets` named a place. */
export const SecretSign = {
  /** A URL with a user or a password before its host. */
  Userinfo: 'userinfo',
  /** A URL query parameter whose name reads as a credential's. */
  Query: 'query',
  /** The value of a command-line flag, or of a header written as `Name: value`, so named. */
  Flag: 'flag',
  /** A value with the shape of a credential: a known key prefix, or `Bearer` and a token. */
  Value: 'value',
  /** A key of the server itself whose name reads as a credential's. */
  Field: 'field',
} as const;

/** Any one of the reasons in `SecretSign`. */
export type SecretSign = (typeof SecretSign)[keyof typeof SecretSign];

/** One place `findSpecSecrets` thinks a credential may be, and never the credential. */
export interface SecretHint {
  /** Where, in `parseSpec`'s spelling: `bundle.mcpServers[0].args[2]`. */
  path: string;
  /** The server's slug, or its id where it has no slug. */
  server: string;
  sign: SecretSign;
}

/** A name that reads as a credential's: `api-key`, `TOKEN`, `Authorization`. */
const SECRET_NAME = /key|token|secret|passw|auth|credential|bearer/i;

/** A value shaped like a credential, whatever it is called. */
const SECRET_VALUE = /^(sk-|pk-|rk-|ghp_|gho_|ghs_|github_pat_|glpat-|xox[abprs]-|AKIA)|\b(bearer|basic)\s+\S/i;

/** What an absolute URL opens with. */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** A header as one string, `Name: value`, as `--header` takes it. */
const HEADER = /^([\w-]+):\s*(\S.*)$/;

/** A flag carrying its own value, `--name=value`. */
const FLAG_WITH_VALUE = /^(-{1,2}[^=\s]+)=(.+)$/;

/** The keys of a server `findSpecSecrets` reads for itself, or `exportSpec` strips. */
const SERVER_KEYS_READ = new Set(['id', 'slug', 'url', 'command', 'args', 'env', 'headers']);

/**
 * Whether a string is a credential written out, as against a reference to one.
 *
 * @param value - What a field, a flag or a parameter holds.
 * @returns `false` for an empty string and for one holding a `${VAR}`, which names where the
 * credential is and is not it.
 */
const writtenOut = (value: string) => value !== '' && VARIABLE.test(value) === false;

/**
 * Why a URL may carry a credential.
 *
 * @param text - A string, which need not be a URL.
 * @returns `Userinfo`, `Query`, or `undefined` for a URL that shows neither and for a string
 * that is not an absolute URL.
 */
function urlSign(text: string): SecretSign | undefined {
  const isAbsoluteUrl = URL_SCHEME.test(text) && URL.canParse(text);
  if (isAbsoluteUrl === false) {
    return undefined;
  }
  const url = new URL(text);
  if (writtenOut(url.username) || writtenOut(url.password)) {
    return SecretSign.Userinfo;
  }
  for (const [name, value] of url.searchParams) {
    if (SECRET_NAME.test(name) && writtenOut(value)) {
      return SecretSign.Query;
    }
  }
  return undefined;
}

/**
 * Why one word of a command line may be a credential, read on its own.
 *
 * @param word - One argument.
 * @returns A sign, or `undefined` for a word that shows none. A flag with no value of its own
 * shows none here: `argumentSigns` reads the word after it.
 */
function wordSign(word: string): SecretSign | undefined {
  if (writtenOut(word) === false) {
    return undefined;
  }
  const flag = FLAG_WITH_VALUE.exec(word);
  if (flag?.[1] !== undefined && SECRET_NAME.test(flag[1])) {
    return SecretSign.Flag;
  }
  const header = HEADER.exec(word);
  if (header?.[1] !== undefined && SECRET_NAME.test(header[1])) {
    return SecretSign.Flag;
  }
  // A flag's own value is read as a word too: `--url=https://user:pass@host`.
  const value = flag?.[2] ?? word;
  return SECRET_VALUE.test(value) ? SecretSign.Value : urlSign(value);
}

/**
 * The words of a command line that may be credentials.
 *
 * @param words - The arguments in order. One that is not a string is passed over.
 * @returns Each suspect word's index and its sign, in order, at most one sign a word.
 *
 * @remarks
 * A flag named like a credential marks the word after it, unless that word is another flag.
 */
function argumentSigns(words: readonly unknown[]): [index: number, sign: SecretSign][] {
  const signs: [number, SecretSign][] = [];
  let flagged = false;
  for (const [index, word] of words.entries()) {
    if (typeof word !== 'string') {
      flagged = false;
      continue;
    }
    const isFlag = word.startsWith('-');
    const isFlaggedValue = flagged && isFlag === false && writtenOut(word);
    const sign = isFlaggedValue ? SecretSign.Flag : wordSign(word);
    if (sign) {
      signs.push([index, sign]);
    }
    flagged = isFlag && word.includes('=') === false && SECRET_NAME.test(word);
  }
  return signs;
}

/**
 * The places one bundled server may carry a credential, outside its `env` and `headers`.
 *
 * @param server - The server as the document holds it.
 * @param path - Where the server is, which each hint's path opens with.
 * @returns The hints in the order `url`, `command`, `args`, then the server's other keys.
 */
function serverSecrets(server: SpecServer, path: string): SecretHint[] {
  const name = server.slug ?? server.id ?? '';
  const hints: SecretHint[] = [];
  const hint = (at: string, sign: SecretSign | undefined) => {
    if (sign) {
      hints.push({ path: `${path}.${at}`, server: name, sign });
    }
  };
  if (typeof server.url === 'string') {
    hint('url', urlSign(server.url));
  }
  if (typeof server.command === 'string') {
    // A command written as one line is read as its words, and named once.
    hint('command', argumentSigns(server.command.split(/\s+/))[0]?.[1]);
  }
  if (Array.isArray(server.args)) {
    for (const [index, sign] of argumentSigns(server.args)) {
      hint(`args[${index}]`, sign);
    }
  }
  for (const [key, value] of Object.entries(server)) {
    const empty = isAbsent(value) || value === '' || (typeof value === 'string' && writtenOut(value) === false);
    const isSecretField = SERVER_KEYS_READ.has(key) === false && SECRET_NAME.test(key) && empty === false;
    if (isSecretField) {
      hint(key, SecretSign.Field);
    }
  }
  return hints;
}

/**
 * Where a document's bundled servers may still carry a credential after `exportSpec`.
 *
 * @param spec - A document, exported or not: `env` and `headers` are not reported either way,
 * since `exportSpec` strips them.
 * @returns One hint for each suspect place, in document order, each naming where and why and
 * none holding the value. Empty for a document with no bundle.
 *
 * @remarks
 * An app calls this before it offers an export as safe to share, and warns with what comes back.
 * It reads a server's `url`, its `command` and `args`, and the names of its other keys, and is a
 * guess both ways: a credential in a positional argument with no telling prefix is missed, and a
 * flag called `--keyboard` is named. A `${VAR}` is a reference and is never named.
 */
export function findSpecSecrets(spec: AgentSpec): SecretHint[] {
  const servers = spec.bundle?.mcpServers ?? [];
  return servers.flatMap((server, index) => serverSecrets(server, `bundle.mcpServers[${index}]`));
}
