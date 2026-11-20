import { isAbsent, isRecord } from '../core/guards.ts';
import { PROMPT_ROLES } from './parts.ts';
import {
  AGENT_SPEC,
  type AgentSpec,
  type EndpointSpec,
  type ModelSpec,
  pathText,
  type RetrySpec,
  type TaskSpec,
  type ToolsSpec,
} from './spec.ts';

/**
 * An app's stored agent, read as a spec layer and written back: one table of columns, and the
 * marker each column stores for "inherit".
 *
 * Every app with profiles had written this projection by hand, three times with three markers —
 * `""` and `-1` and the word `inherit` in one, `null` in the next, none at all in the third — and
 * the import half of it once more, with a list of what a row could not keep. The merge was already
 * `resolveAgentSpec`; what each repeated was which column feeds which field, and how a column at
 * its marker becomes a field the layer does not have, which is the only spelling of "inherit" a
 * spec knows.
 *
 * Browser-safe for the reason `spec.ts` is: it imports that module and a guard, and nothing that
 * needs Node, so a form can preview an import with it.
 */

/**
 * Where in a spec a column lives, as a dotted path. A path the format has no field for does not
 * typecheck.
 *
 * @remarks
 * `prompt.<name>` is the content of the prompt part with that name, since a row holds a prompt as
 * one string and a spec holds it as named parts. A task name is everything between `tasks.` and the
 * next dot, so a task whose name has a dot in it cannot be addressed — nor can an extension's
 * reverse-domain key, which is what `ExtensionPath` is for.
 */
export type SpecPath =
  | 'id'
  | 'name'
  | 'description'
  | `endpoint.${keyof EndpointSpec}`
  | `model.${keyof ModelSpec}`
  | `prompt.${string}`
  | 'promptLayout'
  | `tools.${keyof ToolsSpec}`
  | `retry.${keyof RetrySpec}`
  | `tasks.${string}.endpoint.${keyof EndpointSpec}`
  | `tasks.${string}.${Exclude<keyof TaskSpec, 'endpoint'>}`;

/**
 * A path into an app's own extension, as segments, because its key is a reverse domain and has
 * dots of its own.
 */
export type ExtensionPath = readonly ['extensions', string, ...string[]];

/** The top-level keys of a spec, for naming a whole section an app reads by hand. */
export type SpecSection =
  | '$schema'
  | 'id'
  | 'name'
  | 'description'
  | 'endpoint'
  | 'model'
  | 'prompt'
  | 'promptLayout'
  | 'tools'
  | 'retry'
  | 'tasks'
  | 'hooks'
  | 'bundle'
  | 'extensions'
  | 'requires';

/**
 * One column: where its value lives in a spec, what it stores for "inherit", and how its value
 * crosses when the column and the field do not hold the same thing.
 *
 * @typeParam Value - The column's own type, which `inherit` and both conversions are checked
 * against.
 */
export interface SpecColumn<Value> {
  path: SpecPath | ExtensionPath;
  /**
   * What the column stores for "say nothing here": a value at it is a field the layer leaves out,
   * and a field the layer leaves out reads back as it. Compared with `===`. Left out, the column
   * has no marker — every value it holds is said, which is an app's bottom layer — and an absent
   * field leaves the column out of what `fromLayer` returns.
   *
   * @remarks
   * `null` and `undefined` are absent whatever the marker is, as they are to `parseSpec`, so a
   * nullable column needs no marker to inherit and `inherit: null` only adds the read-back.
   */
  inherit?: Value;
  /**
   * The column's value as the field holds it, for a column that stores something else — a switch
   * for a mode, say. Called for a value that is neither absent nor the marker, and `undefined`
   * back says nothing, which is how a marker that is a range rather than one value (a trimmed
   * blank, any negative) is spelled. Left out, the value crosses as it is.
   */
  toSpec?: (value: Exclude<Value, null | undefined>) => unknown;
  /**
   * The field's value as the column would store it, or `undefined` where the column cannot hold
   * it — which `fromLayer` writes as the marker and `dropped` reports against this column. Left
   * out, the value crosses as `parseSpec` left it, and the path is what says its type.
   */
  fromSpec?: (value: unknown) => Value | undefined;
}

/**
 * A row's columns, each mapped to a field: keyed by column, so a name the row does not have is an
 * excess property and a marker of the wrong type does not typecheck.
 *
 * @typeParam Row - The stored row. Only the columns named here are read or written.
 */
export type SpecColumns<Row> = { [Column in keyof Row]?: SpecColumn<Row[Column]> };

/** What `defineSpecColumns` takes besides the columns. */
export interface SpecColumnsOptions {
  /**
   * What the app reads by hand, so `dropped` does not report it: a section (`bundle`), a path
   * (`tools.servers`, where a list of slugs becomes a list of row ids) or an extension. `spec` is
   * never reported, and needs no entry here.
   */
  handled?: readonly (SpecSection | SpecPath | `tasks.${string}` | ExtensionPath)[];
}

/** One thing a document says that a row will not keep. */
export interface SpecDrop<Row> {
  /**
   * Where it is, in `parseSpec`'s spelling: `model.extraBody`, `prompt[1]`, `hooks[0]`. A key
   * holding a dot is quoted, as in `extensions["com.acme"]`.
   */
  path: string;
  /** What the document held there. */
  value: unknown;
  /**
   * The column that refused it: present when there is a column for the field and its `fromSpec`
   * could not store this value, absent when there is no column for the field at all.
   */
  column?: keyof Row;
}

/**
 * A row's column table, both ways.
 *
 * @typeParam Row - The stored row.
 */
export interface SpecColumnMapping<Row> {
  /**
   * The row as a spec layer, saying only what the row says.
   *
   * @param row - The row, or any part of it: a column the row does not carry says nothing.
   * @returns A layer holding every column that is neither absent nor at its marker. A section
   * nothing was said in is left out, and the layer is not yet parsed.
   */
  toLayer(row: Partial<Row>): AgentSpec;
  /**
   * A spec layer as the row would store it.
   *
   * @param layer - A layer `parseSpec` has read, so each field is of its path's type.
   * @returns Every mapped column: its field's value, or its marker where the field is absent or
   * `fromSpec` refused it. A column with no marker is left out where its field is absent.
   */
  fromLayer(layer: AgentSpec): Partial<Row>;
  /**
   * What a spec says that `fromLayer` would not keep: a field with no column, and a value a column
   * refused.
   *
   * @param spec - A layer `parseSpec` has read.
   * @returns Each loss once, in the document's order. Empty when the row keeps everything.
   *
   * @remarks
   * A field this format names is reported at its own path, a section with nothing mapped in it
   * whole beneath that: an `extraBody` no column takes is one entry, not one per key. A prompt
   * part is a column's when its name is, and since a column holds only the content, a `mode`, an
   * `allowedModes` or a role other than `system` is reported.
   */
  dropped(spec: AgentSpec): SpecDrop<Row>[];
}

/** One column, with its path split into segments. */
interface Entry<Row> {
  column: keyof Row;
  segments: readonly string[];
  hasMarker: boolean;
  definition: SpecColumn<Row[keyof Row]>;
}

/**
 * The sections `dropped` always walks into, so a field the format names is reported at its own
 * path. Anything deeper — one task, one extension — is walked into only where a column is mapped
 * beneath it, and is otherwise reported whole: a side task this app does not run is one loss.
 */
const STRUCTURAL = ['endpoint', 'model', 'tools', 'retry', 'tasks', 'extensions'];

/** The section whose entries are named parts of text, addressed by `prompt.<name>`. */
const PROMPT = 'prompt';

/** The section whose entries are hooks, which `dropped` reports one by one. */
const HOOKS = 'hooks';

/** The key every layer declares itself under, which belongs to no column. */
const TOKEN = 'spec';

/**
 * A path as segments.
 *
 * @param path - A dotted path or an extension's segments.
 * @returns The segments: a prompt part's name is one segment whatever it holds, and a task name the
 * text up to the next dot.
 */
function segmentsOf(path: SpecPath | ExtensionPath | SpecSection | `tasks.${string}`): readonly string[] {
  if (typeof path !== 'string') {
    return path;
  }
  const prefix = `${PROMPT}.`;
  if (path.startsWith(prefix)) {
    return [PROMPT, path.slice(prefix.length)];
  }
  return path.split('.');
}

/**
 * Whether one path is the other or lies beneath it.
 *
 * @param prefix - The shorter path.
 * @param path - The path that may lie beneath it.
 * @returns `true` when every segment of `prefix` begins `path`.
 */
const startsWith = (prefix: readonly string[], path: readonly string[]) =>
  prefix.length <= path.length && prefix.every((segment, index) => segment === path[index]);

/**
 * Whether two paths are the same segments.
 *
 * @param a - One path.
 * @param b - The other.
 * @returns `true` when they are the same length and agree throughout.
 */
const samePath = (a: readonly string[], b: readonly string[]) => a.length === b.length && startsWith(a, b);

/**
 * The value at a path in a layer.
 *
 * @param layer - The layer.
 * @param segments - Where to look. `['prompt', name]` reads that part's content.
 * @returns What is there, or `undefined`.
 */
function read(layer: AgentSpec, segments: readonly string[]): unknown {
  if (segments[0] === PROMPT) {
    return layer.prompt?.find((part) => part.name === segments[1])?.content;
  }
  let held: unknown = layer;
  for (const segment of segments) {
    if (isRecord(held) === false) {
      return undefined;
    }
    held = held[segment];
  }
  return held;
}

/**
 * Puts a value at a path in a layer being built, making the sections on the way.
 *
 * @param layer - The layer, as a plain object.
 * @param segments - Where it goes. `['prompt', name]` appends a `system` part.
 * @param value - What goes there.
 */
function write(layer: Record<string, unknown>, segments: readonly string[], value: unknown) {
  if (segments[0] === PROMPT) {
    const parts = Array.isArray(layer.prompt) ? layer.prompt : [];
    layer.prompt = [...parts, { role: PROMPT_ROLES.system, name: segments[1], content: value }];
    return;
  }
  let section = layer;
  for (const segment of segments.slice(0, -1)) {
    const held = section[segment];
    const next = isRecord(held) ? held : {};
    section[segment] = next;
    section = next;
  }
  section[segments[segments.length - 1]] = value;
}

/**
 * Refuses a table that cannot be read both ways.
 *
 * @param entries - The table's columns.
 * @throws When a path has an empty segment, or one column's path is another's or lies beneath it —
 * two columns writing one field, or one writing a section another writes inside.
 */
function checkTable<Row>(entries: readonly Entry<Row>[]) {
  for (const [index, entry] of entries.entries()) {
    if (entry.segments.some((segment) => segment === '')) {
      throw new Error(`defineSpecColumns: ${String(entry.column)} has an empty segment in its path`);
    }
    for (const other of entries.slice(index + 1)) {
      if (startsWith(entry.segments, other.segments) || startsWith(other.segments, entry.segments)) {
        throw new Error(`defineSpecColumns: ${String(entry.column)} and ${String(other.column)} write the same field`);
      }
    }
  }
}

/**
 * A column table from a stored row to a spec layer and back, with each column's "inherit" marker
 * a parameter.
 *
 * @typeParam Row - The stored row: a settings row, a profile, an override layer.
 * @param columns - Each mapped column, keyed by its name on the row.
 * @param [options] - What the app reads by hand, outside the table.
 * @returns `toLayer`, `fromLayer` and `dropped` over that one table.
 * @throws When two columns write the same field, or one writes a section another writes inside.
 *
 * @example
 * ```ts
 * const profile = defineSpecColumns<Agent>({
 *   model: { path: 'model.model', inherit: '' },
 *   maxTokens: { path: 'model.maxTokens', inherit: -1 },
 *   toolDiscovery: { path: 'tools.discovery', inherit: 'inherit' },
 *   compactionModel: { path: 'tasks.compaction.model', inherit: '' },
 *   toolExecution: { path: ['extensions', 'com.example.host', 'toolExecution'], inherit: 'inherit' },
 * });
 * resolveAgentSpec([settings.toLayer(row), profile.toLayer(agent)]);
 * ```
 *
 * @remarks
 * Keyed by column rather than by field, so the marker and the conversions are typed against that
 * column's own type and a column cannot be mapped twice. A column feeds one field: a row that
 * spreads one field over several columns, or a record column over many fields, reads that part by
 * hand and names it in `handled`.
 */
export function defineSpecColumns<Row>(
  columns: SpecColumns<Row>,
  { handled = [] }: SpecColumnsOptions = {},
): SpecColumnMapping<Row> {
  const entries: Entry<Row>[] = [];
  for (const column of Object.keys(columns) as (keyof Row)[]) {
    const definition = columns[column];
    if (definition) {
      entries.push({ column, segments: segmentsOf(definition.path), hasMarker: 'inherit' in definition, definition });
    }
  }
  checkTable(entries);
  const handledPaths = handled.map(segmentsOf);

  /**
   * What a column stores for a field's value.
   *
   * @param entry - The column.
   * @param value - The field's value, present.
   * @returns The column's value, or `undefined` where it refused it.
   */
  const stored = (entry: Entry<Row>, value: unknown) =>
    entry.definition.fromSpec ? entry.definition.fromSpec(value) : (value as Row[keyof Row]);

  return {
    toLayer(row) {
      const layer: Record<string, unknown> = { spec: AGENT_SPEC };
      for (const { column, segments, hasMarker, definition } of entries) {
        const value = row[column];
        const inherits = isAbsent(value) || (hasMarker && value === definition.inherit);
        if (inherits) {
          continue;
        }
        const said = definition.toSpec ? definition.toSpec(value as Exclude<Row[keyof Row], null | undefined>) : value;
        if (isAbsent(said) === false) {
          write(layer, segments, said);
        }
      }
      // Built as a plain object because the paths are data; each field is the column's value, of
      // its path's type when the app's `toSpec` says so, and `parseSpec` is the check on that.
      return layer as AgentSpec;
    },

    fromLayer(layer) {
      const row: Partial<Row> = {};
      for (const entry of entries) {
        const value = read(layer, entry.segments);
        const kept = isAbsent(value) ? undefined : stored(entry, value);
        if (kept !== undefined) {
          row[entry.column] = kept;
        } else if (entry.hasMarker) {
          row[entry.column] = entry.definition.inherit;
        }
      }
      return row;
    },

    dropped(spec) {
      const drops: SpecDrop<Row>[] = [];
      const isHandled = (path: readonly string[]) => handledPaths.some((prefix) => startsWith(prefix, path));
      const columnAt = (path: readonly string[]) => entries.find((entry) => samePath(entry.segments, path));
      const mappedBeneath = (path: readonly string[]) =>
        entries.some((entry) => entry.segments.length > path.length && startsWith(path, entry.segments));
      const isStructural = (path: readonly string[]) =>
        path.length === 0 || (path.length === 1 && STRUCTURAL.includes(path[0]));

      /**
       * Reports a column's refusal of a value, if it refuses it.
       *
       * @param entry - The column at this path.
       * @param path - The path as `parseSpec` spells it.
       * @param value - The field's value, present.
       */
      const offer = (entry: Entry<Row>, path: string, value: unknown) => {
        if (stored(entry, value) === undefined) {
          drops.push({ path, value, column: entry.column });
        }
      };

      /**
       * Reports every part of a prompt no column takes, and what a column cannot hold of one it does.
       *
       * @param parts - The layer's prompt.
       */
      const walkPrompt = (parts: NonNullable<AgentSpec['prompt']>) => {
        for (const [index, part] of parts.entries()) {
          const path = [PROMPT, part.name];
          if (isHandled(path)) {
            continue;
          }
          const at = `${PROMPT}[${index}]`;
          const entry = columnAt(path);
          if (entry === undefined) {
            drops.push({ path: at, value: part });
            continue;
          }
          offer(entry, `${at}.content`, part.content);
          // `toLayer` writes a part as its name and content alone, so these would not come back.
          const isSystem = part.role === PROMPT_ROLES.system;
          const unheld = { role: isSystem ? undefined : part.role, mode: part.mode, allowedModes: part.allowedModes };
          for (const [field, value] of Object.entries(unheld)) {
            if (isAbsent(value) === false) {
              drops.push({ path: `${at}.${field}`, value });
            }
          }
        }
      };

      /**
       * Reports what lies at a path and is not kept, descending where something beneath is mapped.
       *
       * @param value - What the document holds at the path.
       * @param path - Where it is, as segments.
       */
      const walk = (value: unknown, path: readonly string[]) => {
        if (isAbsent(value) || isHandled(path)) {
          return;
        }
        const entry = columnAt(path);
        if (entry) {
          offer(entry, pathText(path), value);
          return;
        }
        const isPromptList = path.length === 1 && path[0] === PROMPT && Array.isArray(value);
        if (isPromptList) {
          walkPrompt(value);
          return;
        }
        const isHookList = path.length === 1 && path[0] === HOOKS && Array.isArray(value);
        if (isHookList) {
          for (const [index, hook] of value.entries()) {
            drops.push({ path: `${HOOKS}[${index}]`, value: hook });
          }
          return;
        }
        const shouldDescend = isRecord(value) && (isStructural(path) || mappedBeneath(path));
        if (shouldDescend) {
          for (const [key, held] of Object.entries(value)) {
            const isToken = path.length === 0 && key === TOKEN;
            if (isToken) {
              continue;
            }
            walk(held, [...path, key]);
          }
          return;
        }
        drops.push({ path: pathText(path), value });
      };

      walk(spec, []);
      return drops;
    },
  };
}
