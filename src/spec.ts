import type { AgentConfig, Endpoint } from "./config.ts";
import type { HookEvent } from "./hooks.ts";

/**
 * A JSON document that defines an agent, and the rules for reading one.
 *
 * Four applications sit on this package and each one spells "an agent" differently: a singleton
 * settings row, a deliberately jobless agent table whose job comes from three other rows, an
 * override profile that resolves into a whole synthesised settings object. None of them can read
 * another's agents, and `maxTokens: 0` means *no ceiling* in one, *inherit* in the next and *a
 * real ceiling of zero* in the third. This is the shape they can all write and all read, argued
 * out in `docs/agent-spec.md` before any of it was code.
 *
 * Nothing else in `src/` imports this module, and this module imports nothing but types. That is
 * the same seam `config.ts` draws — the loop takes the parts it reads, not a config object — and
 * it is what lets the document travel between hosts without the loop growing an opinion about
 * where an agent comes from. It is also why this is importable in a browser, where `client.ts`
 * and `hooks.ts` are not: a host validating a pasted document in a form needs no `node:crypto`.
 */

/** The token a document declares itself with. A loader refuses anything else. */
export const AGENT_SPEC = "cubicecho.agent/1";

/** The major version `AGENT_SPEC` pins. Raised only when a field changes meaning. */
export const AGENT_SPEC_VERSION = 1;

/**
 * The side tasks this package has code for: documentation and a sensible UI order, not a
 * validator.
 *
 * `tasks` is an open record on purpose — a host may run tasks this package has never heard of,
 * and an unknown key is carried through untouched rather than warned about.
 */
export const AGENT_TASKS = ["compaction", "toolSelect", "title", "followups"] as const;

/**
 * Every event a hook may be bound to, restated so this module stays free of `node:crypto`.
 *
 * `hooks.ts` owns the list; importing its `HOOK_EVENTS` would pull the whole module, and its
 * `createHash` with it, into a file whose whole point is that a browser can load it. The `HookEvent`
 * type is imported and erased, so a removed event fails to compile here, and a test asserts this
 * list and `HOOK_EVENTS` are the same list so an added one cannot drift quietly.
 */
export const SPEC_EVENTS: readonly HookEvent[] = [
  "sessionStart",
  "beforeTurn",
  "afterTurn",
  "beforeCompact",
  "sessionEnd",
  "sessionDelete",
];

/** The events whose output can still reach a request, so the only ones `inject` means anything on. */
const SPEC_INJECT: ReadonlySet<string> = new Set(["sessionStart", "beforeTurn"]);

/** Body fields the loop owns. `buildBody` would overwrite them anyway; better to say so on import. */
const RESERVED_BODY = ["model", "messages", "stream", "tools"];

/** One agent, as a document. Every field but `spec` is optional, because a layer says only what it changes. */
export interface AgentSpec {
  /** Exactly `AGENT_SPEC`. Missing, mistyped or another major is refused. */
  spec: typeof AGENT_SPEC;
  /** A URL for an editor's autocompletion. Never fetched, never read, never validated against. */
  $schema?: string;

  /** A stable handle within a host: `reviewer`, `local-qwen`. Absent in a layer of pure defaults. */
  id?: string;
  /** What a person calls it. Absent falls back to `id`. */
  name?: string;
  /** One line for an operator choosing between agents. Never sent to a model — that is `prompt`. */
  description?: string;

  endpoint?: EndpointSpec;
  model?: ModelSpec;
  /** Ordered layers of system prompt, merged by `id` and joined with blank lines on resolve. */
  prompt?: PromptPart[];
  tools?: ToolsSpec;
  retry?: RetrySpec;
  /** Side tasks run on a model other than the agent's. Open by design; see `AGENT_TASKS`. */
  tasks?: Record<string, TaskSpec>;
  hooks?: AgentHook[];
  /** Definitions carried so an agent travels whole. Executable by proxy; see `parseSpec`. */
  bundle?: SpecBundle;

  /** Host payloads keyed by reverse domain. Carries no semantics and is never validated. */
  extensions?: Record<string, unknown>;
  /** Extension keys a host must understand, or it refuses to run this agent. */
  requires?: string[];

  /** Keys from a later 1.x, kept so an edit-and-export cycle does not erase them. */
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
  /** What the operator says this model reads, in tokens. Zero asks the endpoint. */
  contextLength?: number;
  /** Request fields the interface cannot spell. `model`, `messages`, `stream`, `tools` are dropped. */
  extraBody?: Record<string, unknown>;
}

/** One layer of system prompt, named so a layer above can stack beside it or replace it. */
export interface PromptPart {
  /** Names this layer: `project`, `identity`, `role`, `lane`. Merging happens on it. */
  id: string;
  /** The text. Empty deletes the part a layer below contributed. Absent only when `ref` is given. */
  text?: string;
  /** Where the text lives instead. The shape is validated; the reference is never resolved. */
  ref?: { type: "file" | "url"; value: string };
}

/** How tools reach the model, and which servers this agent may reach at all. */
export interface ToolsSpec {
  discovery?: "eager" | "ondemand";
  /** The hard stop on a tool loop. At least one. */
  maxIterations?: number;
  /**
   * The MCP servers this agent may reach, by effective slug (`row.slug ?? row.id`).
   * Absent is every server the host offers, `[]` is none, and a list is exactly those.
   * Three different answers, and a loader must never collapse one into another.
   */
  servers?: string[];
}

/** What to do about a request lost before the model produced anything. */
export interface RetrySpec {
  /** Re-sends of a request lost before the model produced anything. Zero is none — a value. */
  maxRetries?: number;
  /** Seconds to wait out a server loading its model. Zero is not at all; absent is two minutes. */
  loadingTimeoutSeconds?: number;
}

/** One side task, which may run on a different model — and a different machine — than the agent. */
export interface TaskSpec {
  /** The model for this task. Empty turns it off, which is how a layer declines one below it. */
  model?: string;
  /** Where that model lives, when it is not on the agent's endpoint. */
  endpoint?: EndpointSpec;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: string;
}

/** A tool call bound to a lifecycle event, run by the host rather than the model. */
export interface AgentHook {
  /** Unique within the agent. Merging happens on it. */
  id: string;
  /** One of `SPEC_EVENTS`. An event this host never fires is a warning, not an error. */
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

/** One bundled MCP server, as far as this package reads it. */
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
   * This package deliberately does not restate the pool's `McpServerConfig`. Restating a union it
   * never reads is a version-skew generator: the pool carries `coerceArguments`, `maxResultChars`
   * and three separate timeouts, and a strict parse here would silently delete a server's
   * ninety-second call timeout on a round trip. Importing the type is not an option either, since
   * the pool pulls the MCP SDK and `openai` is this package's only peer dependency.
   */
  mcpServers?: SpecServer[];
}

/** One side task, resolved: a model, and the endpoint it is reached through. */
export interface ResolvedTask {
  model: string;
  /** This task's endpoint, which is the agent's unless a layer named another. */
  endpoint: Endpoint;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: string;
}

/**
 * What layered documents resolve to: the flat shape the loop already takes, plus the parts of an
 * agent that are the host's to act on.
 *
 * `extends AgentConfig` is the whole point — `getClient(resolved)` and
 * `runAgentLoop({ config: resolved })` take this unchanged, and no adapter is needed.
 */
export interface ResolvedAgent extends AgentConfig {
  id: string;
  name: string;
  description: string;
  /** The tri-state preserved: absent is every server the host offers, empty is none. */
  servers?: readonly string[];
  /**
   * The merged prompt parts, in order. `systemPrompt` is the join of their texts, so a part that
   * is only a `ref` contributes nothing to it — the host resolves the reference and re-resolves,
   * or reads it from here and does what it likes.
   */
  prompt: readonly PromptPart[];
  /** Only the tasks a layer configured and none declined. `toolSelect` also flattens to `toolSelectModel`. */
  tasks: Readonly<Record<string, ResolvedTask>>;
  hooks: readonly AgentHook[];
  /** Bundled server definitions, merged by effective slug. Empty unless a bundle was parsed. */
  mcpServers: readonly SpecServer[];
  extensions: Readonly<Record<string, unknown>>;
  /** Every layer's requirements, unioned, so a layer above cannot quietly drop one below it. */
  requires: readonly string[];
}

/**
 * What a field falls back to when no layer said anything at all.
 *
 * Not sentinels, and not invented: `toolDiscovery`, `maxRetries` and `contextLength` are the
 * "absent everywhere" column of the document's own table, and `temperature` and `maxToolIterations`
 * are what all three consumers store as their defaults today. A field left out here is left out of
 * the resolved object too, which is how `requestTimeoutSeconds` keeps meaning "no opinion".
 */
export const RESOLVED_DEFAULTS = {
  temperature: 0.7,
  maxTokens: 0,
  contextLength: 0,
  toolDiscovery: "eager",
  maxToolIterations: 20,
  maxRetries: 0,
} as const;

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
   * Parse `bundle` rather than dropping it. Off by default, because a bundled server carries a
   * command line and an environment map: loading one is equivalent to running a program, exactly
   * as dangerous as pasting somebody's `.mcp.json`, and a host has to make that decision rather
   * than inherit it from a default.
   */
  bundle?: boolean;
  /** The events this host actually fires, defaulting to all of them. A hook bound elsewhere warns. */
  events?: readonly string[];
  /** The `extensions` keys this host understands. A `requires` entry outside it refuses the load. */
  understands?: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Absent and null are the same thing: a nullable column round-trips through JSON as `null`. */
const absent = (value: unknown) => value === undefined || value === null;

/** A `${VAR}`-shaped string, which is kept as the literal it is rather than expanded. */
const VARIABLE = /\$\{[^}]*\}/;

/** Problems in the order they were found, in `validateHooks`'s `path: what is wrong` shape. */
class Report {
  readonly errors: string[] = [];
  readonly warnings: string[] = [];

  fail(path: string, problem: string) {
    this.errors.push(`${path}: ${problem}`);
  }

  drop(path: string, problem: string) {
    this.warnings.push(`${path}: ${problem}, and was dropped`);
  }

  note(path: string, problem: string) {
    this.warnings.push(`${path}: ${problem}`);
  }

  /**
   * A string field, or nothing. Interpolation is never performed, so a `${VAR}` is reported as
   * the literal it will stay — the alternative hands whoever wrote the document the ability to
   * read any variable the process has, which is why the formats that do it need a credential
   * denylist bolted on afterwards.
   */
  string(path: string, value: unknown): string | undefined {
    if (absent(value)) return undefined;
    if (typeof value !== "string") return void this.drop(path, "must be a string");
    if (VARIABLE.test(value))
      this.note(path, "looks like a variable reference, which is never expanded");
    return value;
  }

  number(path: string, value: unknown, least: number, most = Infinity): number | undefined {
    if (absent(value)) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value))
      return void this.drop(path, "must be a number");
    // Dropped, never clamped: a clamp invents a number the author did not write, while dropping
    // falls back to one somebody did — the layer below, or nothing.
    if (value < least || value > most)
      return void this.drop(
        path,
        `must be ${most === Infinity ? `at least ${least}` : `between ${least} and ${most}`}`,
      );
    return value;
  }

  boolean(path: string, value: unknown): boolean | undefined {
    if (absent(value)) return undefined;
    if (typeof value !== "boolean") return void this.drop(path, "must be true or false");
    return value;
  }
}

/** Drops the keys whose value did not survive, so an absent field stays absent. */
function kept<T extends object>(fields: T): { [K in keyof T]: T[K] } {
  const out = {} as T;
  for (const [key, value] of Object.entries(fields))
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  return out;
}

/** Whether a parsed sub-object said anything at all. An empty one is the same as an absent one. */
const said = (value: object) => Object.keys(value).length > 0;

function parseEndpoint(report: Report, path: string, value: unknown): EndpointSpec | undefined {
  if (absent(value)) return undefined;
  if (!isRecord(value)) return void report.drop(path, "must be an object");
  const endpoint = kept({
    baseUrl: report.string(`${path}.baseUrl`, value.baseUrl),
    requestTimeoutSeconds: report.number(
      `${path}.requestTimeoutSeconds`,
      value.requestTimeoutSeconds,
      0,
    ),
    firstTokenSeconds: report.number(`${path}.firstTokenSeconds`, value.firstTokenSeconds, 0),
  });
  if (!absent(value.apiKey) || !absent(value.api_key))
    report.drop(`${path}.apiKey`, "is not part of this format — a document carries no credentials");
  return said(endpoint) ? endpoint : undefined;
}

function parseModel(report: Report, value: unknown): ModelSpec | undefined {
  if (absent(value)) return undefined;
  if (!isRecord(value)) return void report.drop("model", "must be an object");
  let extraBody: Record<string, unknown> | undefined;
  if (!absent(value.extraBody)) {
    if (!isRecord(value.extraBody)) report.drop("model.extraBody", "must be an object");
    else {
      extraBody = {};
      for (const [key, held] of Object.entries(value.extraBody)) {
        if (RESERVED_BODY.includes(key))
          report.drop(`model.extraBody.${key}`, "is the loop's to set");
        else extraBody[key] = held;
      }
    }
  }
  return kept({
    model: report.string("model.model", value.model),
    maxTokens: report.number("model.maxTokens", value.maxTokens, 0),
    temperature: report.number("model.temperature", value.temperature, 0, 2),
    reasoningEffort: report.string("model.reasoningEffort", value.reasoningEffort),
    contextLength: report.number("model.contextLength", value.contextLength, 0),
    extraBody,
  });
}

function parsePrompt(report: Report, value: unknown[]): PromptPart[] {
  const parts: PromptPart[] = [];
  for (const [index, held] of value.entries()) {
    const path = `prompt[${index}]`;
    if (!isRecord(held)) {
      report.drop(path, "must be an object");
      continue;
    }
    const id = report.string(`${path}.id`, held.id);
    if (!id) {
      report.drop(path, "has no id, and merging happens on the id");
      continue;
    }
    const text = report.string(`${path}.text`, held.text);
    let ref: PromptPart["ref"];
    if (!absent(held.ref)) {
      const raw = held.ref;
      const type = isRecord(raw) ? raw.type : undefined;
      const value = isRecord(raw) ? report.string(`${path}.ref.value`, raw.value) : undefined;
      if ((type === "file" || type === "url") && value) ref = { type, value };
      else report.drop(`${path}.ref`, 'must be { type: "file" | "url", value }');
    }
    // An empty text is how a layer deletes the part below it, so it is not the same as neither.
    if (text === undefined && !ref) {
      report.drop(path, "has neither text nor a reference");
      continue;
    }
    parts.push(kept({ id, text, ref }) as PromptPart);
  }
  return parts;
}

function parseTools(report: Report, value: unknown): ToolsSpec | undefined {
  if (absent(value)) return undefined;
  if (!isRecord(value)) return void report.drop("tools", "must be an object");
  let discovery: ToolsSpec["discovery"];
  if (!absent(value.discovery)) {
    if (value.discovery === "eager" || value.discovery === "ondemand") discovery = value.discovery;
    else report.drop("tools.discovery", 'must be "eager" or "ondemand"');
  }
  let servers: string[] | undefined;
  if (!absent(value.servers)) {
    if (!Array.isArray(value.servers)) report.drop("tools.servers", "must be an array of slugs");
    else {
      // The empty array survives on purpose: it is "no servers", and collapsing it into absent
      // would turn a scoped agent into one holding every tool on the box.
      servers = [];
      for (const [index, slug] of value.servers.entries()) {
        const name = report.string(`tools.servers[${index}]`, slug);
        if (name) servers.push(name);
        else if (name === "") report.drop(`tools.servers[${index}]`, "is empty");
      }
    }
  }
  return kept({
    discovery,
    maxIterations: report.number("tools.maxIterations", value.maxIterations, 1),
    servers,
  });
}

function parseRetry(report: Report, value: unknown): RetrySpec | undefined {
  if (absent(value)) return undefined;
  if (!isRecord(value)) return void report.drop("retry", "must be an object");
  const retry = kept({
    maxRetries: report.number("retry.maxRetries", value.maxRetries, 0),
    loadingTimeoutSeconds: report.number(
      "retry.loadingTimeoutSeconds",
      value.loadingTimeoutSeconds,
      0,
    ),
  });
  return said(retry) ? retry : undefined;
}

function parseTasks(report: Report, value: Record<string, unknown>): Record<string, TaskSpec> {
  const tasks: Record<string, TaskSpec> = {};
  for (const [key, held] of Object.entries(value)) {
    const path = `tasks.${key}`;
    if (absent(held)) continue;
    if (!isRecord(held)) {
      report.drop(path, "must be an object");
      continue;
    }
    // An unknown key is not warned about: a host may run side tasks this package has never
    // heard of, and `AGENT_TASKS` is documentation rather than a validator.
    tasks[key] = kept({
      model: report.string(`${path}.model`, held.model),
      endpoint: parseEndpoint(report, `${path}.endpoint`, held.endpoint),
      maxTokens: report.number(`${path}.maxTokens`, held.maxTokens, 0),
      temperature: report.number(`${path}.temperature`, held.temperature, 0, 2),
      reasoningEffort: report.string(`${path}.reasoningEffort`, held.reasoningEffort),
    });
  }
  return tasks;
}

function parseHooks(report: Report, value: unknown[], events: readonly string[]): AgentHook[] {
  const hooks: AgentHook[] = [];
  for (const [index, held] of value.entries()) {
    const path = `hooks[${index}]`;
    if (!isRecord(held)) {
      report.drop(path, "must be an object");
      continue;
    }
    const id = report.string(`${path}.id`, held.id);
    const server = report.string(`${path}.server`, held.server);
    const tool = report.string(`${path}.tool`, held.tool);
    const on = report.string(`${path}.on`, held.on);
    if (!id || !server || !tool || !on) {
      report.drop(path, "needs an id, an event, a server and a tool");
      continue;
    }
    if (!SPEC_EVENTS.includes(on as HookEvent)) {
      report.drop(`${path}.on`, `"${on}" is not an event`);
      continue;
    }
    // A host that never compacts refuses to save a `beforeCompact` hook today, which makes an
    // otherwise good agent unimportable. Kept and noted instead.
    if (!events.includes(on)) report.note(`${path}.on`, `"${on}" is never fired by this host`);
    let inject = report.boolean(`${path}.inject`, held.inject);
    if (inject && !SPEC_INJECT.has(on)) {
      report.drop(`${path}.inject`, `"${on}" runs after the model has already answered`);
      inject = undefined;
    }
    let veto = report.boolean(`${path}.veto`, held.veto);
    if (veto && on !== "beforeCompact") {
      report.drop(`${path}.veto`, `"${on}" announces nothing a hook can decline`);
      veto = undefined;
    }
    hooks.push(
      kept({
        id,
        on: on as HookEvent,
        server,
        tool,
        args: absent(held.args) ? undefined : held.args,
        inject,
        veto,
        maxTokens: report.number(`${path}.maxTokens`, held.maxTokens, 0),
        timeoutMs: report.number(`${path}.timeoutMs`, held.timeoutMs, 0),
        enabled: report.boolean(`${path}.enabled`, held.enabled),
      }) as AgentHook,
    );
  }
  return hooks;
}

function parseBundle(report: Report, value: unknown): SpecBundle | undefined {
  if (absent(value)) return undefined;
  if (!isRecord(value)) return void report.drop("bundle", "must be an object");
  if (absent(value.mcpServers)) return undefined;
  if (!Array.isArray(value.mcpServers))
    return void report.drop("bundle.mcpServers", "must be an array");
  const seen = new Set<string>();
  const servers: SpecServer[] = [];
  for (const [index, held] of value.mcpServers.entries()) {
    const path = `bundle.mcpServers[${index}]`;
    if (!isRecord(held)) {
      report.drop(path, "must be an object");
      continue;
    }
    const slug = typeof held.slug === "string" && held.slug ? held.slug : undefined;
    const id = typeof held.id === "string" && held.id ? held.id : undefined;
    const effective = slug ?? id;
    if (!effective) {
      report.drop(path, "needs an id or a slug");
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

/** The keys this version names. Anything else is a later 1.x, and is carried rather than erased. */
const KNOWN = new Set([
  "spec",
  "$schema",
  "id",
  "name",
  "description",
  "endpoint",
  "model",
  "prompt",
  "tools",
  "retry",
  "tasks",
  "hooks",
  "bundle",
  "extensions",
  "requires",
]);

/**
 * Reads a document, dropping what it cannot use and refusing only what it cannot identify.
 *
 * Every problem is reported at once, in the `path: what is wrong` shape `validateHooks` already
 * uses, because a host showing an operator one error at a time makes them fix a document one
 * round trip at a time.
 *
 * There are exactly four hard errors, all of them about the document rather than a value: it is
 * not an object; the `spec` token is missing or of another major; a `requires` entry this host
 * does not understand; a container of the wrong kind. Everything else drops the offending field
 * and warns — the lesson a consumer learned the hard way when one stored out-of-range value
 * stopped its server booting. Out-of-range values are dropped rather than clamped, because a
 * clamp invents a number the author did not write while dropping falls back to one somebody did.
 *
 * Version handling is the deliberate opposite of `importCapabilities`, which shrugs at a foreign
 * version and returns false: degrade where the loss is performance, refuse where the loss is
 * identity. A snapshot of the wrong version costs a few refused requests; an agent of the wrong
 * version is not the agent its author described.
 *
 * @param document Anything at all — this is the front door, and it is given parsed JSON from a
 * form, a file or another host.
 * @param options Whether to parse a bundle, which events this host fires, and which extension
 * keys it understands.
 */
export function parseSpec(document: unknown, options: ParseSpecOptions = {}): ParsedSpec {
  const report = new Report();
  const events = options.events ?? SPEC_EVENTS;
  if (!isRecord(document)) {
    report.fail("spec", "must be an object");
    return { spec: null, errors: report.errors, warnings: report.warnings };
  }

  const token = document.spec;
  if (typeof token !== "string") report.fail("spec", `must be "${AGENT_SPEC}"`);
  else if (token !== AGENT_SPEC) {
    const major = Number(token.split("/")[1]);
    const named = token.startsWith("cubicecho.agent/") && Number.isInteger(major);
    report.fail(
      "spec",
      named
        ? `is version ${major}, and this build reads version ${AGENT_SPEC_VERSION}`
        : `must be "${AGENT_SPEC}"`,
    );
  }

  // Containers are checked before their contents: "prompt must be an array" is a different
  // mistake from "this prompt part has no id", and only the first is worth refusing over.
  if (!absent(document.prompt) && !Array.isArray(document.prompt))
    report.fail("prompt", "must be an array");
  if (!absent(document.tasks) && !isRecord(document.tasks))
    report.fail("tasks", "must be an object");
  if (!absent(document.hooks) && !Array.isArray(document.hooks))
    report.fail("hooks", "must be an array");

  const requires: string[] = [];
  if (!absent(document.requires)) {
    if (!Array.isArray(document.requires)) report.fail("requires", "must be an array");
    else
      for (const [index, key] of document.requires.entries()) {
        if (typeof key !== "string") {
          report.fail(`requires[${index}]`, "must be a string");
          continue;
        }
        // Fails closed: an agent that must not run without its sandbox extension can say so.
        if (options.understands && !options.understands.includes(key))
          report.fail(`requires[${index}]`, `"${key}" is not understood by this host`);
        requires.push(key);
      }
  }

  let extensions: Record<string, unknown> | undefined;
  if (!absent(document.extensions)) {
    if (!isRecord(document.extensions)) report.drop("extensions", "must be an object");
    // Never validated beyond being an object. It is the escape hatch, and the one place a host
    // can put what this package has no name for without being told about it.
    else extensions = document.extensions;
  }

  if (!absent(document.bundle) && !options.bundle)
    report.drop("bundle", "carries a command line, so it is only read with { bundle: true }");

  const spec: AgentSpec = {
    spec: AGENT_SPEC,
    ...kept({
      $schema: report.string("$schema", document.$schema),
      id: report.string("id", document.id),
      name: report.string("name", document.name),
      description: report.string("description", document.description),
      endpoint: parseEndpoint(report, "endpoint", document.endpoint),
      model: parseModel(report, document.model),
      prompt: Array.isArray(document.prompt) ? parsePrompt(report, document.prompt) : undefined,
      tools: parseTools(report, document.tools),
      retry: parseRetry(report, document.retry),
      tasks: isRecord(document.tasks) ? parseTasks(report, document.tasks) : undefined,
      hooks: Array.isArray(document.hooks) ? parseHooks(report, document.hooks, events) : undefined,
      bundle: options.bundle ? parseBundle(report, document.bundle) : undefined,
      extensions,
      requires: absent(document.requires) ? undefined : requires,
    }),
  };

  for (const [key, held] of Object.entries(document)) {
    if (KNOWN.has(key)) continue;
    // Kept, not erased: a host stores what it was given and resolves on read, so a key from a
    // later 1.x survives an edit-and-export cycle instead of dying at the first host to open it.
    report.note(key, "is not a key this version names, and was carried through unread");
    spec[key] = held;
  }

  return {
    spec: report.errors.length ? null : spec,
    errors: report.errors,
    warnings: report.warnings,
  };
}

/** Merges the layers that named a key, last one winning, and leaves it absent if none did. */
function mergeEndpoints(layers: (EndpointSpec | undefined)[]): EndpointSpec {
  const out: EndpointSpec = {};
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.baseUrl !== undefined) out.baseUrl = layer.baseUrl;
    if (layer.requestTimeoutSeconds !== undefined)
      out.requestTimeoutSeconds = layer.requestTimeoutSeconds;
    if (layer.firstTokenSeconds !== undefined) out.firstTokenSeconds = layer.firstTokenSeconds;
  }
  return out;
}

/** An `Endpoint` as the loop takes one. `apiKey` is always empty; see `resolveAgentSpec`. */
const asEndpoint = (spec: EndpointSpec): Endpoint => ({
  baseUrl: spec.baseUrl ?? "",
  apiKey: "",
  ...kept({
    requestTimeoutSeconds: spec.requestTimeoutSeconds,
    firstTokenSeconds: spec.firstTokenSeconds,
  }),
});

/**
 * Layers documents into the flat object the loop takes, weakest first.
 *
 * Absent inherits, and nothing else does: `0`, `-1`, `""` and `[]` are values that mean what they
 * say, which is the whole reason the format exists — `maxTokens: 0` means three different things
 * across the three applications this was extracted from, and `temperature: 0` is unsayable in one
 * of them. Scalars take the last layer that has the key. `extraBody` and `extensions` merge by
 * top-level key. `prompt`, `hooks` and `tasks` merge by id, ordered by first appearance, which is
 * one rule expressing two behaviours that look unrelated: different ids stack, and the same id
 * replaces. `tools.servers` replaces whole, because a tri-state cannot be unioned. `requires`
 * unions, so a layer above cannot quietly drop a requirement below it.
 *
 * No layer is ever fetched. There is no `extends` field and no URL resolution; which documents
 * layer is the host's call, the same answer `resolveApiKey` gives about keys. `apiKey` comes back
 * empty for the same reason: a document naming somebody else's endpoint must not be able to make
 * this host send its own provider key there. A host that wants inheritance applies `resolveApiKey`
 * afterwards.
 *
 * @param layers The documents, weakest first: settings, then the agent, then a task, then a step.
 */
export function resolveAgentSpec(layers: readonly AgentSpec[]): ResolvedAgent {
  const endpoint = mergeEndpoints(layers.map((layer) => layer.endpoint));

  const model: ModelSpec = {};
  const extraBody: Record<string, unknown> = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer.model ?? {})) {
      if (value === undefined) continue;
      if (key === "extraBody") Object.assign(extraBody, value);
      else (model as Record<string, unknown>)[key] = value;
    }
  }

  const parts = new Map<string, PromptPart>();
  for (const layer of layers)
    for (const part of layer.prompt ?? [])
      parts.set(part.id, { ...(parts.get(part.id) ?? { id: part.id }), ...part });

  const tools: ToolsSpec = {};
  for (const layer of layers) {
    if (layer.tools?.discovery !== undefined) tools.discovery = layer.tools.discovery;
    if (layer.tools?.maxIterations !== undefined) tools.maxIterations = layer.tools.maxIterations;
    // Replaced whole rather than unioned: a list, an empty list and no list are three answers,
    // and a union of the first two is the first, which loses the scoping the operator asked for.
    if (layer.tools?.servers !== undefined) tools.servers = [...layer.tools.servers];
  }

  const retry: RetrySpec = {};
  for (const layer of layers) {
    if (layer.retry?.maxRetries !== undefined) retry.maxRetries = layer.retry.maxRetries;
    if (layer.retry?.loadingTimeoutSeconds !== undefined)
      retry.loadingTimeoutSeconds = layer.retry.loadingTimeoutSeconds;
  }

  const merged = new Map<string, TaskSpec>();
  for (const layer of layers)
    for (const [key, task] of Object.entries(layer.tasks ?? {}))
      merged.set(key, {
        ...(merged.get(key) ?? {}),
        ...task,
        endpoint: mergeEndpoints([merged.get(key)?.endpoint, task.endpoint]),
      });
  const tasks: Record<string, ResolvedTask> = {};
  for (const [key, task] of merged) {
    // `model: ""` is how a layer declines a task a layer below it configured, so the entry goes
    // rather than coming back with an empty model for the host to interpret.
    if (!task.model) continue;
    tasks[key] = kept({
      model: task.model,
      endpoint: asEndpoint(mergeEndpoints([endpoint, task.endpoint])),
      maxTokens: task.maxTokens,
      temperature: task.temperature,
      reasoningEffort: task.reasoningEffort,
    }) as ResolvedTask;
  }

  const hooks = new Map<string, AgentHook>();
  for (const layer of layers)
    for (const hook of layer.hooks ?? [])
      hooks.set(hook.id, { ...(hooks.get(hook.id) ?? hook), ...hook });

  const servers = new Map<string, SpecServer>();
  for (const layer of layers)
    for (const server of layer.bundle?.mcpServers ?? []) {
      const slug = server.slug ?? server.id;
      if (slug) servers.set(slug, { ...(servers.get(slug) ?? {}), ...server });
    }

  const extensions: Record<string, unknown> = {};
  for (const layer of layers) Object.assign(extensions, layer.extensions ?? {});

  const requires = new Set<string>();
  for (const layer of layers) for (const key of layer.requires ?? []) requires.add(key);

  const id = [...layers].reverse().find((layer) => layer.id)?.id ?? "";
  const name = [...layers].reverse().find((layer) => layer.name)?.name;
  const description = [...layers].reverse().find((layer) => layer.description)?.description;
  const prompt = [...parts.values()];

  return {
    id,
    name: name ?? id,
    description: description ?? "",
    baseUrl: endpoint.baseUrl ?? "",
    apiKey: "",
    ...kept({
      requestTimeoutSeconds: endpoint.requestTimeoutSeconds,
      firstTokenSeconds: endpoint.firstTokenSeconds,
      loadingTimeoutSeconds: retry.loadingTimeoutSeconds,
      reasoningEffort: model.reasoningEffort,
      extraBody: said(extraBody) ? extraBody : undefined,
      servers: tools.servers,
    }),
    model: model.model ?? "",
    maxTokens: model.maxTokens ?? RESOLVED_DEFAULTS.maxTokens,
    temperature: model.temperature ?? RESOLVED_DEFAULTS.temperature,
    contextLength: model.contextLength ?? RESOLVED_DEFAULTS.contextLength,
    toolDiscovery: tools.discovery ?? RESOLVED_DEFAULTS.toolDiscovery,
    toolSelectModel: tasks.toolSelect?.model ?? "",
    maxToolIterations: tools.maxIterations ?? RESOLVED_DEFAULTS.maxToolIterations,
    maxRetries: retry.maxRetries ?? RESOLVED_DEFAULTS.maxRetries,
    // Byte-identical to what a consumer's `systemPromptFor` produces today, so four sources
    // survive a round trip instead of flattening into one blob nobody can edit a third of.
    systemPrompt: prompt
      .map((part) => part.text?.trim() ?? "")
      .filter(Boolean)
      .join("\n\n"),
    prompt,
    tasks,
    hooks: [...hooks.values()],
    mcpServers: [...servers.values()],
    extensions,
    requires: [...requires],
  };
}

/** What `exportSpec` takes besides the document. */
export interface ExportSpecOptions {
  /**
   * Keep the environment and headers of bundled servers. Off by default, mirroring the pool's
   * `state({ secrets })`, because those are where a bundled server's credentials live.
   */
  secrets?: boolean;
}

/**
 * A document fit to leave the host: the same agent, with the secrets of its bundled servers gone.
 *
 * The property worth keeping is that **a redacted spec is still a valid spec** — it parses, it
 * resolves, and what comes back is the same agent pointed at the same servers, needing only the
 * credentials the importing host supplies itself. So this removes values rather than keys, and
 * nothing outside `bundle` is touched: the format has no credential field at any depth, which is
 * the reason there is nothing else to strip.
 *
 * @param spec A document, ordinarily one `parseSpec` returned.
 * @param options Whether to keep the secrets. The default is not to.
 */
export function exportSpec(
  spec: AgentSpec,
  { secrets = false }: ExportSpecOptions = {},
): AgentSpec {
  if (secrets || !spec.bundle?.mcpServers) return { ...spec };
  return {
    ...spec,
    bundle: {
      ...spec.bundle,
      mcpServers: spec.bundle.mcpServers.map(({ env: _env, headers: _headers, ...rest }) => rest),
    },
  };
}
