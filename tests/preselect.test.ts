import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';
import type { CatalogServer } from '../src/catalog.ts';
import { MAX_PER_LOAD } from '../src/tool-loading.ts';
import { JSON_SCHEMA_FORMAT } from '../src/wire.ts';

const create = vi.fn();
/** Only the SDK-touching half is replaced; the rest of the client module is pure. */
vi.mock('../src/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/client.ts')>()),
  getClient: () => ({ chat: { completions: { create } } }),
}));

const { PRESELECT_SYSTEM, preselect, preselectByKeywords, preselectInput, preselection, preselectSystem } =
  await import('../src/preselect.ts');
const { resetCapabilities } = await import('../src/capabilities.ts');

const config = {
  baseUrl: 'http://local/v1',
  apiKey: '',
  model: 'm',
  maxTokens: 100,
  temperature: 0.2,
  maxToolIterations: 4,
};

const tool = (name: string) => ({ name, description: `does ${name}` });

const catalog: CatalogServer[] = [
  {
    id: '1',
    label: 'Gmail',
    tools: [tool('gmail__send_email'), tool('gmail__list_labels'), tool('gmail__read_email')],
  },
  { id: '2', label: 'Files', tools: [tool('files__read_file'), tool('files__write_file')] },
];

beforeEach(() => create.mockReset());
afterEach(() => resetCapabilities());

describe('preselect', () => {
  const catalog = [{ id: 's', label: 'S', tools: [{ name: 's__read', description: 'reads' }] }];

  it('hands back the catalogued names the small model picked', async () => {
    create.mockResolvedValue({ choices: [{ message: { content: '["s__read", "nope"]' } }] });
    expect(await preselect(config, 'small', catalog, 'read it')).toEqual(['s__read']);
    expect(create.mock.calls[0][0]).toMatchObject({
      response_format: { type: JSON_SCHEMA_FORMAT, json_schema: { name: 'preselection' } },
    });
    create.mockResolvedValue({ choices: [{ message: { content: '{"tools": ["s__read"]}' } }] });
    expect(await preselect(config, 'small', catalog, 'read it')).toEqual(['s__read']);
  });

  it('picks nothing without a model, and nothing when the call fails', async () => {
    expect(await preselect(config, '', catalog, 'read it')).toEqual([]);
    const notices: string[] = [];
    create.mockRejectedValueOnce(new Error('boom'));
    const got = await preselect(config, 'small', catalog, 'x', {
      onNotice: (n) => notices.push(n),
    });
    expect(got).toEqual([]);
    expect(notices).toEqual([expect.stringContaining('boom')]);
  });

  it("spends no round trip when the request's own words name the tool", async () => {
    // A catalogue with something to discriminate between: a term is only distinctive against
    // other terms, so one tool alone can never be a confident match, and does not need to be.
    const desks = [
      { id: 's', label: 'S', tools: [{ name: 's__read', description: 'Read a file' }] },
      { id: 'd', label: 'D', tools: [{ name: 'd__query', description: 'Query the database' }] },
      { id: 'c', label: 'C', tools: [{ name: 'c__event', description: 'Add a calendar event' }] },
      { id: 'w', label: 'W', tools: [{ name: 'w__fetch', description: 'Fetch a URL' }] },
    ];
    const notices: string[] = [];
    const got = await preselect(config, 'small', desks, 'read the file', {
      keywords: true,
      onNotice: (n) => notices.push(n),
    });
    expect(got).toEqual(['s__read']);
    // The whole point: the model was never asked.
    expect(create).not.toHaveBeenCalled();
    expect(notices).toEqual([expect.stringContaining('by name')]);
  });

  it('falls through to the model when the words settle nothing', async () => {
    create.mockResolvedValue({ choices: [{ message: { content: '{"tools": ["s__read"]}' } }] });
    expect(await preselect(config, 'small', catalog, 'sing me a song', { keywords: true })).toEqual(['s__read']);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('asks for no preselection at all without a model, words or not', async () => {
    // `toolSelectModel: ""` means don't preselect, and the cheap path does not reinterpret it.
    expect(await preselect(config, '', catalog, 'read the file', { keywords: true })).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });
});

test('a preselection is resolved against the catalogue and capped', () => {
  expect(preselection(['gmail__send_email', 'invented'], catalog)).toEqual(['gmail__send_email']);
  expect(preselection({ tools: ['gmail__send_email', 'invented'] }, catalog)).toEqual(['gmail__send_email']);
  // A model that answers with prose instead of an array selects nothing at all.
  expect(preselection('gmail__send_email', catalog)).toEqual([]);
});

test('the preselect prompt carries the catalogue and the task, and not the meta-tool', () => {
  const input = preselectInput(catalog, 'read my notes file');
  expect(input).toContain('files__read_file');
  expect(input).toContain('read my notes file');
  // Preselection happens before `load_tools` exists to the model; naming it here would invite
  // an answer that asks for it.
  expect(input).not.toContain('load_tools');
});

test('a malformed preselection reply means no preselection, not a failure', () => {
  expect(preselection(undefined, catalog)).toEqual([]);
  expect(preselection({ names: ['gmail__send_email'] }, catalog)).toEqual([]);
  expect(preselection({ tools: 'gmail__send_email' }, catalog)).toEqual([]);
  expect(preselection(['', 7, null], catalog)).toEqual([]);
});

test('the preselector is told the cap it will be held to', () => {
  expect(preselectSystem(3)).toContain('at most 3');
  expect(PRESELECT_SYSTEM).toContain(`at most ${MAX_PER_LOAD}`);
  expect(preselection(['gmail__send_email', 'gmail__read_email'], catalog, 1)).toEqual(['gmail__send_email']);
});

test('the preselect prompt is cut where the caller says', () => {
  const input = preselectInput(catalog, 'read my notes file', 7);
  expect(input).toContain('read my');
  expect(input).not.toContain('notes');
});

/**
 * A catalogue the size of a real one, with the descriptions a pool actually hands over — the
 * shared vocabulary ("list", "get", "file", "the repository") is the point, since that is what
 * a plain overlap count drowns in.
 */
const desks: CatalogServer[] = [
  {
    id: 'git',
    label: 'Git',
    tools: [
      { name: 'git__commit', description: 'Record staged changes in the repository as a commit' },
      { name: 'git__status', description: 'Show the working tree status of the repository' },
      { name: 'git__diff', description: 'Show changes between commits in the repository' },
      { name: 'git__log', description: 'List the commit history of the repository' },
      { name: 'git__branch', description: 'List or create branches in the repository' },
      { name: 'git__push', description: 'Send local commits to the remote repository' },
    ],
  },
  {
    id: 'fs',
    label: 'Files',
    tools: [
      { name: 'fs__read_file', description: 'Read the contents of a file from disk' },
      { name: 'fs__write_file', description: 'Write contents to a file on disk' },
      { name: 'fs__list_directory', description: 'List the files in a directory on disk' },
      { name: 'fs__move_file', description: 'Move or rename a file on disk' },
      { name: 'fs__search_files', description: 'Search for files on disk matching a pattern' },
    ],
  },
  {
    id: 'web',
    label: 'Web',
    tools: [
      { name: 'web__fetch_url', description: 'Fetch the contents of a URL over HTTP' },
      { name: 'web__search', description: 'Search the web and get a list of result pages' },
      { name: 'web__screenshot', description: 'Take a screenshot of a page in a browser' },
    ],
  },
  {
    id: 'db',
    label: 'Database',
    tools: [
      { name: 'db__query', description: 'Run a read-only SQL query against the database' },
      { name: 'db__execute', description: 'Run a statement that writes to the database' },
      { name: 'db__list_tables', description: 'List the tables in the database' },
      { name: 'db__describe_table', description: 'Show the columns of a table in the database' },
    ],
  },
  {
    id: 'cal',
    label: 'Calendar',
    tools: [
      { name: 'cal__list_events', description: 'List events on the calendar for a date range' },
      { name: 'cal__create_event', description: 'Add an event to the calendar' },
      { name: 'cal__delete_event', description: 'Remove an event from the calendar' },
    ],
  },
];

/** Requests, and the one tool each is really asking for. */
const asked: [string, string][] = [
  ['Commit the staged changes with a short message', 'git__commit'],
  ['What branches exist in this repo?', 'git__branch'],
  ['Push my work to the remote', 'git__push'],
  ['Read the file at src/index.ts and tell me what it exports', 'fs__read_file'],
  ['Rename that file to something clearer', 'fs__move_file'],
  ['Which directory are the fixtures in? List it.', 'fs__list_directory'],
  ['Take a screenshot of the landing page', 'web__screenshot'],
  ['Fetch https://example.com and summarise it', 'web__fetch_url'],
  ['What columns does the users table have?', 'db__describe_table'],
  ['Put a dentist appointment on my calendar for Tuesday', 'cal__create_event'],
];

test('the words alone find the tool a request is asking for', () => {
  // Recall over the whole fixture, which is the number worth having: on a catalogue this size
  // the top of the ranking is the tool asked for every time, and every one of those is a round
  // trip to a model not spent. A regression here is a threshold or a stopword gone wrong.
  for (const [prompt, want] of asked) {
    const picked = preselectByKeywords(desks, prompt);
    expect([prompt, picked.ranked[0]?.name]).toEqual([prompt, want]);
    expect(picked.names).toContain(want);
    expect(picked.confident).toBe(true);
  }
});

test('a word the whole catalogue uses is worth less than one that names a tool', () => {
  const shared: CatalogServer[] = [
    {
      id: '1',
      label: 'Desk',
      tools: [
        { name: 'desk__alpha', description: 'Get the thing and hand the thing back' },
        { name: 'desk__beta', description: 'Put the thing somewhere and say so' },
        { name: 'desk__gamma', description: 'Count the thing, then count the thing again' },
        { name: 'desk__zebra', description: 'Get the zebra' },
      ],
    },
  ];
  // "thing" is in three of four descriptions and twice in two of them, so on a shared-word count
  // it decides the ranking. What the request is actually about is the word only one tool uses.
  const ranked = preselectByKeywords(shared, 'the thing zebra').ranked;
  expect(ranked[0].name).toBe('desk__zebra');
});

test('words the catalogue does not use pick nothing, and say so', () => {
  // The words cannot tell a request that needs no tools from one whose words are not in the
  // catalogue, so neither is a confident answer and both go to the model.
  for (const prompt of ['Sing me a song about autumn', 'Could you have a look at that for me']) {
    const none = preselectByKeywords(desks, prompt);
    expect(none.names).toEqual([]);
    expect(none.confident).toBe(false);
  }
});

test('a request that names a whole server is not confident about which of its tools', () => {
  // Every database tool scores nearly the same on "database", so the cut between them is
  // arbitrary — which is the case the model is worth spending on.
  const broad = preselectByKeywords(desks, 'Do something with the database', { maxPerLoad: 2 });
  expect(broad.names.length).toBe(2);
  expect(broad.confident).toBe(false);
});

test('the ranking does not depend on the order servers connected in', () => {
  const prompt = 'read the file and commit it';
  const forwards = preselectByKeywords(desks, prompt);
  const backwards = preselectByKeywords([...desks].reverse(), prompt);
  expect(backwards.names).toEqual(forwards.names);
});

test('plurals and camelCase meet the names they are asking for', () => {
  // "files" against `fs__read_file`, and a camelCase catalogue split the same way as a snake one.
  expect(preselectByKeywords(desks, 'list the files in src').names).toContain('fs__list_directory');
  const camel: CatalogServer[] = [
    { id: '1', label: 'Notes', tools: [{ name: 'notes__createNote', description: 'Add a note' }] },
  ];
  expect(preselectByKeywords(camel, 'create a note').names).toEqual(['notes__createNote']);
});

test('the request is read only as far as the preselector reads it', () => {
  const buried = `${'filler words '.repeat(300)}commit the changes`;
  expect(preselectByKeywords(desks, buried).names).not.toContain('git__commit');
  expect(preselectByKeywords(desks, buried, { maxPromptChars: 10_000 }).names).toContain('git__commit');
});
