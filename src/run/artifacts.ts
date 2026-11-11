import type OpenAI from 'openai';
import {
  ArtifactAction,
  ArtifactSource,
  type ResourceLink,
  type RunArtifact,
  type ToolCallRequest,
} from '../wire/tool-calls.ts';
import { FUNCTION_TOOL, SchemaType } from '../wire/wire.ts';

/**
 * What a run left behind, from the two sources that take a guess: the model saying so, and a call
 * that reads as a write. kanban-server and telos each grew these rules, and this is them in one
 * place; a call's `links`, which take no guessing, are kept by the same ledger.
 *
 * A declaration is believed only where some call in the run was given or answered with that
 * location. Without that, a model with no file tools "saves" its answer to a file it never wrote.
 */

/** The name of the tool the loop declares and answers itself when `artifacts.declare` is on. */
export const RECORD_ARTIFACT = 'record_artifact';

/** The definition of `record_artifact`, as the loop declares it beside the host's own tools. */
export const RECORD_ARTIFACT_TOOL: OpenAI.ChatCompletionFunctionTool = {
  type: FUNCTION_TOOL,
  function: {
    name: RECORD_ARTIFACT,
    description:
      'Name something a tool call in this run stored, so the run lists it: a file one of your tools ' +
      'wrote, a page it published, an object it uploaded. Only for a location a tool was actually ' +
      'given or answered with, and only after that call: one that no tool call in this run touched ' +
      'is refused. Your reply is already kept, so never record it, and never invent a file to put ' +
      'it in. Calling this adds the title and description a person would want.',
    parameters: {
      type: SchemaType.Object,
      properties: {
        location: {
          type: SchemaType.String,
          description: 'The path or URI, exactly as the tool that stored it was given it.',
        },
        title: { type: SchemaType.String, description: 'A short name for it.' },
        description: { type: SchemaType.String, description: 'One sentence on what it is for.' },
        mediaType: { type: SchemaType.String, description: 'e.g. text/markdown. Optional.' },
      },
      required: ['location'],
      additionalProperties: false,
    },
  },
};

/**
 * Which of the guessing sources a run collects, beside the links every run keeps.
 *
 * @remarks
 * Both are off by default: `linked` is the source to rely on, and these are for servers that
 * never send a `resource_link`.
 */
export interface ArtifactOptions {
  /**
   * Declares `record_artifact` on every step and answers it in the loop, never through `dispatch`.
   * The host's own tool of that name, if it has one, is not dispatched while this is on.
   *
   * @defaultValue `false`
   */
  declare?: boolean;
  /**
   * Reads every successful call for the shape of a write. A predicate reads only the calls it
   * passes, which is how a host keeps its own tools' writes — a note on its board — off the list.
   *
   * @defaultValue `false`
   */
  detect?: boolean | ((call: ToolCallRequest) => boolean);
}

/** What one declaration or detection said of a location, before it is merged into the run's. */
export interface ArtifactDraft {
  /** The path or URI, trimmed. */
  location: string;
  source: typeof ArtifactSource.Declared | typeof ArtifactSource.Detected;
  /** What was done to it. A declaration says `created`, and never moves an earlier write's. */
  action: ArtifactAction;
  title?: string;
  description?: string;
  /** As declared, or else a guess off the extension. */
  mediaType?: string;
  /** The bytes of the content the write carried, where its arguments held it. */
  sizeBytes?: number;
}

/** The call an artifact is put down to: the one that linked it, wrote it, or touched it. */
export type ArtifactFrom = Pick<RunArtifact, 'callId' | 'tool' | 'step'>;

/** A verb at the front of a tool name that means something was written somewhere. */
const WRITE_VERB = /^(write|create|save|upload|put|append|edit|move|rename|copy|publish|delete|remove)(_|$)/;

/** Writes that leave nothing a person would call an artifact behind. */
const NOT_ARTIFACTS = new Set(['create_directory', 'create_dir', 'create_folder', 'mkdir']);

/** The argument names a location goes by, in the order they are believed. */
const LOCATION_KEYS = [
  'destination',
  'dest',
  'target',
  'path',
  'file_path',
  'filePath',
  'filename',
  'file',
  'uri',
  'url',
  'key',
];

/** The argument names a write's content goes by, in the order they are believed. */
const CONTENT_KEYS = ['content', 'contents', 'text', 'body', 'data'];

/** The separator between a server's slug and its tool, in the names a pool hands the loop. */
const SLUG_SEPARATOR = '__';

const encoder = new TextEncoder();

/**
 * What a write did, read off its verb.
 *
 * @param verb - The tool's own name, lowercased, after any slug.
 * @returns `updated` for an edit or append, `moved` for a move or rename, `deleted` for a delete or
 * remove, and `created` for everything else.
 */
function actionOf(verb: string): ArtifactAction {
  if (/^(edit|append)/.test(verb)) {
    return ArtifactAction.Updated;
  }
  if (/^(move|rename)/.test(verb)) {
    return ArtifactAction.Moved;
  }
  if (/^(delete|remove)/.test(verb)) {
    return ArtifactAction.Deleted;
  }
  return ArtifactAction.Created;
}

/**
 * The first of these arguments that is a string, under the first key that holds one.
 *
 * @param args - The call's arguments.
 * @param keys - The names to try, in order.
 * @param [isBlankOk] - Whether an empty or all-space string counts. It does for content.
 * @returns The string, or `undefined` where none of the keys held one.
 */
function firstString(args: Record<string, unknown>, keys: string[], isBlankOk = false): string | undefined {
  return keys
    .map((key) => args[key])
    .find((value): value is string => typeof value === 'string' && (isBlankOk || value.trim() !== ''));
}

/**
 * What a successful call wrote, if its name and arguments look like a write.
 *
 * @param name - The tool, as the call named it: `fs__write_file` and `write_file` read alike, the
 * verb being the last `__` segment.
 * @param args - The call's arguments.
 * @returns The draft, or `null` where the name has no write verb, names a folder, or the arguments
 * hold no location.
 */
export function detectArtifact(name: string, args: Record<string, unknown>): ArtifactDraft | null {
  const verb = name.split(SLUG_SEPARATOR).at(-1)?.toLowerCase() ?? '';
  const isWrite = WRITE_VERB.test(verb) && NOT_ARTIFACTS.has(verb) === false;
  const location = isWrite ? firstString(args, LOCATION_KEYS) : undefined;
  if (location === undefined) {
    return null;
  }
  const content = firstString(args, CONTENT_KEYS, true);
  const mediaType = mediaTypeFor(location);
  return {
    location: location.trim(),
    source: ArtifactSource.Detected,
    action: actionOf(verb),
    ...(mediaType ? { mediaType } : {}),
    ...(content === undefined ? {} : { sizeBytes: encoder.encode(content).byteLength }),
  };
}

/**
 * What the model said through `record_artifact`.
 *
 * @param args - The call's arguments.
 * @returns The draft, or `null` where it named no location.
 */
export function declaredArtifact(args: Record<string, unknown>): ArtifactDraft | null {
  const text = (key: string) => (typeof args[key] === 'string' ? args[key].trim() : '');
  const location = text('location');
  if (location === '') {
    return null;
  }
  const mediaType = text('mediaType') || mediaTypeFor(location);
  return {
    location,
    source: ArtifactSource.Declared,
    action: ArtifactAction.Created,
    ...(text('title') ? { title: text('title') } : {}),
    ...(text('description') ? { description: text('description') } : {}),
    ...(mediaType ? { mediaType } : {}),
  };
}

const MEDIA_TYPES: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  xml: 'application/xml',
  js: 'text/javascript',
  ts: 'text/x-typescript',
  tsx: 'text/x-typescript',
  py: 'text/x-python',
  sh: 'application/x-sh',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  zip: 'application/zip',
};

/**
 * A media type guessed off a location's extension.
 *
 * @param location - The path or URI. A query or fragment is ignored.
 * @returns The media type, or `null` for a name with no extension, a dotfile, or an extension this
 * table does not know.
 */
export function mediaTypeFor(location: string): string | null {
  const name = location.split(/[?#]/)[0].split(/[\\/]/).at(-1) ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) {
    return null;
  }
  return MEDIA_TYPES[name.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * How an artifact came to be known, reading an absent `source` as the link it always was.
 *
 * @param artifact - One of a run's artifacts.
 * @returns Its source, `linked` where it carries none.
 */
export const artifactSource = (artifact: Pick<RunArtifact, 'source'>) => artifact.source ?? ArtifactSource.Linked;

/**
 * A location as it is compared: no scheme, no leading slashes, no trailing ones.
 *
 * @param location - The path or URI.
 * @returns The bare form, so `/work/a.md`, `work/a.md` and `file:///work/a.md` compare equal.
 */
function bare(location: string): string {
  return location
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^\/+|\/+$/g, '');
}

/**
 * A declared or detected location as a link, the shape every artifact is kept in.
 *
 * @param draft - What was said of it.
 * @returns A link whose `uri` is the location and whose `name` is its last segment.
 */
function linkOf(draft: ArtifactDraft): ResourceLink {
  const name = draft.location.split(/[?#]/)[0].split(/[\\/]/).filter(Boolean).at(-1) ?? draft.location;
  return {
    uri: draft.location,
    name,
    ...(draft.title ? { title: draft.title } : {}),
    ...(draft.description ? { description: draft.description } : {}),
    ...(draft.mediaType ? { mimeType: draft.mediaType } : {}),
  };
}

/**
 * What tells one call from another across a run: an id is distinct only within its step.
 *
 * @param from - The call.
 * @returns Its step and id as one string.
 */
const callKey = ({ callId, step }: ArtifactFrom) => `${step}\0${callId}`;

/**
 * A run's artifacts, one per location, and what its calls touched for a declaration to be checked
 * against.
 *
 * @remarks
 * The merge rules are kanban-server's. A later write moves `action` and `sizeBytes` on and leaves
 * the rest; a declaration over a detection fills in what only the model could say and takes the
 * source over, without turning an `updated` back into `created`. A link is the server's word, so
 * a declaration over one fills only what it left out, and a link over either guess takes over.
 * Each method that adds a location answers with the new artifact, for the caller to announce;
 * a merge into one already known answers nothing, since the event says when a location was first
 * seen and the result says what it ended as.
 */
export class RunArtifacts {
  readonly #byLocation = new Map<string, RunArtifact>();
  /** Each string a call was given or answered with, bare, beside the call. Kept only to declare. */
  readonly #witnessed: { text: string; from: ArtifactFrom }[] = [];
  /** The last call each artifact was counted for, so a call that links and writes one counts once. */
  readonly #countedFor = new WeakMap<RunArtifact, string>();

  /**
   * The artifacts, in the order first seen.
   *
   * @returns A new array of the artifacts themselves, which later merges keep writing to.
   */
  list(): RunArtifact[] {
    return [...this.#byLocation.values()];
  }

  /**
   * Adds one call's links, counting a uri seen before and taking over a guess at the same one.
   *
   * @param links - What the call's answer linked to, a uri given twice counted once.
   * @param from - The call they came from.
   * @returns The artifacts this call added, in the order its links gave them.
   */
  link(links: ResourceLink[], from: ArtifactFrom): RunArtifact[] {
    const seen = new Set<string>();
    const added: RunArtifact[] = [];
    for (const link of links) {
      if (seen.has(link.uri)) {
        continue;
      }
      seen.add(link.uri);
      const known = this.#byLocation.get(link.uri);
      if (known === undefined) {
        const artifact: RunArtifact = { link, ...from, count: 1 };
        this.#byLocation.set(link.uri, artifact);
        this.#countedFor.set(artifact, callKey(from));
        added.push(artifact);
        continue;
      }
      this.#count(known, from);
      if (known.source !== undefined) {
        // What a guess said of it stays only where the server's own link says nothing.
        const { title, description, mimeType } = known.link;
        known.link = {
          ...(title ? { title } : {}),
          ...(description ? { description } : {}),
          ...(mimeType ? { mimeType } : {}),
          ...link,
        };
        delete known.source;
      }
    }
    return added;
  }

  /**
   * Keeps what a successful call was given and answered, so a declaration naming it is believed.
   *
   * @param args - The call's arguments. Every string in them, however deep, is kept bare.
   * @param answer - What the call answered, kept whole.
   * @param links - The uris its answer linked to.
   * @param from - The call.
   */
  witness(args: Record<string, unknown>, answer: string, links: ResourceLink[], from: ArtifactFrom): void {
    const strings = (value: unknown): void => {
      if (typeof value === 'string') {
        this.#witnessed.push({ text: bare(value), from });
      } else if (Array.isArray(value)) {
        value.forEach(strings);
      } else if (value && typeof value === 'object') {
        Object.values(value).forEach(strings);
      }
    };
    strings(args);
    this.#witnessed.push({ text: answer, from });
    for (const { uri } of links) {
      this.#witnessed.push({ text: bare(uri), from });
    }
  }

  /**
   * The latest call in the run that was given or answered with `location`, which is telos's rule
   * for believing a declaration.
   *
   * @param location - The path or URI a declaration names.
   * @returns That call, or `undefined` where none was. A blank location was touched by none.
   */
  seen(location: string): ArtifactFrom | undefined {
    const wanted = bare(location);
    if (wanted === '') {
      return undefined;
    }
    return this.#witnessed.findLast(({ text }) => text === wanted || text.includes(wanted))?.from;
  }

  /**
   * Merges a declaration or a detection into the artifact at its location, or adds one.
   *
   * @param draft - What was said of the location.
   * @param from - The call to put a new artifact down to: the write, or for a declaration the call
   * that touched the location. A merge keeps the earlier one's.
   * @returns The artifact where this added one, and `undefined` where it merged into one known.
   *
   * @remarks
   * A declaration also finds an artifact whose location is the same bare, so a model's
   * `/work/a.md` describes the `work/a.md` the write was given rather than standing beside it.
   */
  add(draft: ArtifactDraft, from: ArtifactFrom): RunArtifact | undefined {
    const known = this.#find(draft);
    if (known === undefined) {
      const artifact: RunArtifact = {
        link: linkOf(draft),
        ...from,
        count: 1,
        source: draft.source,
        ...(draft.source === ArtifactSource.Detected ? { action: draft.action } : {}),
        ...(draft.sizeBytes === undefined ? {} : { sizeBytes: draft.sizeBytes }),
      };
      this.#byLocation.set(draft.location, artifact);
      this.#countedFor.set(artifact, callKey(from));
      return artifact;
    }
    if (draft.source === ArtifactSource.Detected) {
      this.#count(known, from);
      known.action = draft.action;
      if (draft.sizeBytes !== undefined) {
        known.sizeBytes = draft.sizeBytes;
      }
      if (known.link.mimeType === undefined && draft.mediaType) {
        known.link = { ...known.link, mimeType: draft.mediaType };
      }
      return undefined;
    }
    const isLinked = known.source === undefined;
    // Over a link, only what it left out; over a guess, what the model said wins.
    const fill = (field: 'title' | 'description' | 'mimeType', value: string | undefined) => {
      const isTaken = isLinked && Boolean(known.link[field]);
      if (value && isTaken === false) {
        known.link = { ...known.link, [field]: value };
      }
    };
    fill('title', draft.title);
    fill('description', draft.description);
    fill('mimeType', draft.mediaType);
    if (isLinked === false) {
      known.source = ArtifactSource.Declared;
    }
    return undefined;
  }

  /**
   * Counts one more call that made an artifact, unless that call was counted for it already.
   *
   * @param artifact - The artifact. Written to.
   * @param from - The call.
   */
  #count(artifact: RunArtifact, from: ArtifactFrom): void {
    const key = callKey(from);
    if (this.#countedFor.get(artifact) !== key) {
      artifact.count++;
      this.#countedFor.set(artifact, key);
    }
  }

  /**
   * The artifact a draft lands on: the one at its location, or for a declaration one that is the
   * same location bare.
   *
   * @param draft - What was said.
   * @returns The artifact, or `undefined` where the location is new.
   */
  #find(draft: ArtifactDraft): RunArtifact | undefined {
    const exact = this.#byLocation.get(draft.location);
    if (exact !== undefined || draft.source === ArtifactSource.Detected) {
      return exact;
    }
    const wanted = bare(draft.location);
    return [...this.#byLocation.values()].find((artifact) => bare(artifact.link.uri) === wanted);
  }
}
