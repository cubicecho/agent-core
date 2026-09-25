import { expect, test } from "vitest";
import type { CatalogServer } from "../src/catalog.ts";
import {
  carryOver,
  catalogPrompt,
  expandNames,
  inCatalog,
  loadedTools,
  loadResult,
  MAX_CARRIED,
  MAX_PER_LOAD,
  orderTools,
  PRESELECT_SYSTEM,
  preselectByKeywords,
  preselectInput,
  preselection,
  preselectSystem,
  requestedNames,
} from "../src/tool-loading.ts";

const tool = (name: string) => ({ name, description: `does ${name}` });

const catalog: CatalogServer[] = [
  {
    id: "1",
    label: "Gmail",
    tools: [tool("gmail__send_email"), tool("gmail__list_labels"), tool("gmail__read_email")],
  },
  { id: "2", label: "Files", tools: [tool("files__read_file"), tool("files__write_file")] },
];

test("matches exact names and unambiguous bare ones", () => {
  const resolved = expandNames(["gmail__send_email", "list_labels"], catalog);
  expect(resolved.matched.sort()).toEqual(["gmail__list_labels", "gmail__send_email"]);
  expect(resolved.unknown).toEqual([]);
});

test("a bare name matching two servers is not guessed at", () => {
  const ambiguous: CatalogServer[] = [
    { id: "1", label: "A", tools: [tool("a__read_file")] },
    { id: "2", label: "B", tools: [tool("b__read_file")] },
  ];
  expect(expandNames(["read_file"], ambiguous)).toMatchObject({
    matched: [],
    unknown: ["read_file"],
  });
});

test("a wildcard expands, by prefix or by suffix", () => {
  expect(expandNames(["gmail__*"], catalog).matched).toHaveLength(3);
  // The model dropped the server prefix; `__gmail` still finds the group.
  expect(expandNames(["files__read*"], catalog).matched).toEqual(["files__read_file"]);
});

test("an over-broad wildcard is refused with its hits listed", () => {
  const many: CatalogServer[] = [
    {
      id: "1",
      label: "Gmail",
      tools: Array.from({ length: MAX_PER_LOAD + 1 }, (_, i) => tool(`gmail__tool_${i}`)),
    },
  ];
  const resolved = expandNames(["gmail__*"], many);
  expect(resolved.matched).toEqual([]);
  expect(resolved.overBroad[0].hits).toHaveLength(MAX_PER_LOAD + 1);

  const report = loadResult(resolved, many);
  expect(report).toMatch(new RegExp(`more than the ${MAX_PER_LOAD}`));
  expect(report).toContain("gmail__tool_0");
});

test("loading reports the descriptions the catalogue withheld", () => {
  const resolved = expandNames(["gmail__send_email", "nope"], catalog);
  const report = loadResult(resolved, catalog);
  expect(report).toContain("gmail__send_email: does gmail__send_email");
  expect(report).toContain("Not in the catalogue: nope");
  expect(loadResult(expandNames([], catalog), catalog)).toBe("No tool names were given.");
});

test("the catalogue lists names only, marking what is already loaded", () => {
  const prompt = catalogPrompt(catalog, new Set(["gmail__send_email"]));
  expect(prompt).toContain("Gmail:");
  expect(prompt).toContain("  gmail__send_email (loaded)");
  expect(prompt).toContain("  gmail__read_email");
  // Descriptions are the expensive half; they arrive on load, not here.
  expect(prompt).not.toContain("does gmail__read_email");
  expect(catalogPrompt([])).toBe("");
});

test("the catalogue marks nothing unless asked, so it reads the same after a load", () => {
  expect(catalogPrompt(catalog)).not.toContain("(loaded)");
  expect(catalogPrompt(catalog)).toBe(catalogPrompt(catalog));
});

test("loading a tool already loaded says so instead of loading it again", () => {
  const resolved = expandNames(["gmail__send_email", "files__read_file"], catalog);
  const report = loadResult(resolved, catalog, new Set(["gmail__send_email"]));
  expect(report).toContain("Loaded 1 tool(s)");
  expect(report).toContain("files__read_file: does files__read_file");
  expect(report).not.toContain("gmail__send_email: does");
  expect(report).toContain("Already loaded and in your tool list: gmail__send_email");
  expect(loadResult(resolved, catalog)).toContain("Loaded 2 tool(s)");
});

test("loaded definitions are appended in load order, never moved", () => {
  const definition = (name: string) => ({
    type: "function" as const,
    function: { name, parameters: { type: "object" } },
  });
  const [a, b, c] = [definition("a"), definition("b"), definition("c")];
  const previous = [c, a];
  const names = (list: { type: string; function?: { name: string } }[]) =>
    list.map((item) => item.function?.name);
  expect(names(loadedTools(previous, [b, a, b]))).toEqual(["c", "a", "b"]);
  expect(names(previous)).toEqual(["c", "a"]);
});

test("orderTools sorts by name, keeps the definitions themselves, and obeys a comparator", () => {
  const definition = (name: string) => ({
    type: "function" as const,
    function: { name, parameters: { type: "object" } },
  });
  const [a, b, c] = [definition("a"), definition("b"), definition("c")];
  const names = (list: { type: string; function?: { name: string } }[]) =>
    list.map((item) => item.function?.name);
  const given = [c, a, b];
  expect(names(orderTools(given))).toEqual(["a", "b", "c"]);
  // By identity, so `sanitizeTools` still answers from its cache rather than rebuilding.
  expect(orderTools(given)[0]).toBe(a);
  expect(names(given)).toEqual(["c", "a", "b"]);
  expect(orderTools(given, false)).toBe(given);
  // Already in order, so nothing is copied.
  const sorted = [a, b, c];
  expect(orderTools(sorted)).toBe(sorted);
  expect(names(orderTools(given, (x, y) => y.localeCompare(x)))).toEqual(["c", "b", "a"]);
});

test("a preselection is resolved against the catalogue and capped", () => {
  expect(preselection(["gmail__send_email", "invented"], catalog)).toEqual(["gmail__send_email"]);
  expect(preselection({ tools: ["gmail__send_email", "invented"] }, catalog)).toEqual([
    "gmail__send_email",
  ]);
  // A model that answers with prose instead of an array selects nothing at all.
  expect(preselection("gmail__send_email", catalog)).toEqual([]);
});

test("load_tools arguments are read defensively", () => {
  expect(requestedNames({ names: ["a", "b"] })).toEqual(["a", "b"]);
  expect(requestedNames({ tools: "a" })).toEqual(["a"]);
  expect(requestedNames({ name: ["a", 2] })).toEqual(["a"]);
  expect(requestedNames({})).toEqual([]);
});

test("inCatalog knows a tool the model called without loading", () => {
  expect(inCatalog(catalog, "files__write_file")).toBe(true);
  expect(inCatalog(catalog, "files__delete_file")).toBe(false);
});

// `requestedNames` is also given a bare string where the schema says array — models do this.
test("load_tools accepts a single name where an array was asked for", () => {
  expect(requestedNames({ names: "a" })).toEqual(["a"]);
  expect(requestedNames({ names: [1, "a"] })).toEqual(["a"]);
});

test("the preselect prompt carries the catalogue and the task, and not the meta-tool", () => {
  const input = preselectInput(catalog, "read my notes file");
  expect(input).toContain("files__read_file");
  expect(input).toContain("read my notes file");
  // Preselection happens before `load_tools` exists to the model; naming it here would invite
  // an answer that asks for it.
  expect(input).not.toContain("load_tools");
});

test("carry-over keeps what was used, newly used last", () => {
  expect(carryOver(["a", "b"], new Set(["b", "c"]))).toEqual(["a", "b", "c"]);
});

test("carry-over leaves a carried tool where it was when it is used again", () => {
  // Moving it to the end reorders the tool array between turns, and loses the prompt cache.
  expect(carryOver(["a", "b", "c"], new Set(["a"]))).toEqual(["a", "b", "c"]);
});

test("carry-over drops the earliest unused before anything used this turn", () => {
  expect(carryOver(["a", "b", "c"], new Set(["a", "d"]), 3)).toEqual(["a", "c", "d"]);
});

test("carry-over drops the least recently used past the cap", () => {
  const previous = Array.from({ length: MAX_CARRIED }, (_, i) => `old_${i}`);
  const out = carryOver(previous, new Set(["fresh"]));
  expect(out).toHaveLength(MAX_CARRIED);
  expect(out.at(-1)).toBe("fresh");
  expect(out).not.toContain("old_0");
});

test("an empty catalogue produces no prompt at all", () => {
  // Not a heading with nothing under it: a run with no servers must not be told about a
  // mechanism it has nothing to use it on.
  expect(catalogPrompt([])).toBe("");
});

test("a name that matches nothing is reported, and a match is never counted twice", () => {
  const { matched, unknown } = expandNames(["gmail__send_email", "gmail__*", "nope"], catalog);
  expect(matched).toHaveLength(3);
  expect(unknown).toEqual(["nope"]);
});

test("loading says which names it could not place", () => {
  expect(
    loadResult(
      { matched: [], unknown: ["nope"], overBroad: [], deferred: [], maxPerLoad: MAX_PER_LOAD },
      catalog,
    ),
  ).toContain("Not in the catalogue: nope");
});

test("an over-broad wildcard comes back with the names it would have loaded", () => {
  const wide: CatalogServer[] = [
    {
      id: "3",
      label: "Mail",
      tools: Array.from({ length: MAX_PER_LOAD + 5 }, (_, i) => tool(`mail__tool_${i}`)),
    },
  ];
  const text = loadResult(expandNames(["mail__*"], wide), wide);
  expect(text).toContain(`more than the ${MAX_PER_LOAD} one call may load`);
  expect(text).toContain("mail__tool_3");
});

test("a malformed preselection reply means no preselection, not a failure", () => {
  expect(preselection(undefined, catalog)).toEqual([]);
  expect(preselection({ names: ["gmail__send_email"] }, catalog)).toEqual([]);
  expect(preselection({ tools: "gmail__send_email" }, catalog)).toEqual([]);
  expect(preselection(["", 7, null], catalog)).toEqual([]);
});

test("a server with no tools is not given a heading with nothing under it", () => {
  const empty: CatalogServer[] = [{ id: "1", label: "Gmail", tools: [] }];
  expect(catalogPrompt(empty)).toBe("");

  const mixed: CatalogServer[] = [{ id: "1", label: "Gmail", tools: [] }, ...catalog];
  const prompt = catalogPrompt(mixed);
  expect(prompt).not.toContain("Gmail:\n\n");
  expect(prompt).toContain("Files:");
  // The one Gmail heading present is the real server's, not the empty one's.
  expect(prompt.match(/^Gmail:$/gm)).toHaveLength(1);
});

test("the load cap is what one call may load, not what one name may match", () => {
  const dozen = (prefix: string) =>
    Array.from({ length: MAX_PER_LOAD }, (_, i) => tool(`${prefix}__t${i}`));
  const wide: CatalogServer[] = [
    { id: "1", label: "A", tools: dozen("a") },
    { id: "2", label: "B", tools: dozen("b") },
    { id: "3", label: "C", tools: dozen("c") },
  ];

  const resolved = expandNames(["a__*", "b__*", "c__*"], wide);
  expect(resolved.matched).toHaveLength(MAX_PER_LOAD);
  // A dozen apiece is exactly what one call may hold, so neither is too broad to ask for —
  // they just cannot have this call. The budget is still what stops them.
  expect(resolved.deferred).toEqual(["b__*", "c__*"]);
  expect(resolved.overBroad).toEqual([]);
  expect(loadResult(resolved, wide)).toContain("Ask for them on your next step");
});

test("a precise name that only misses the budget is not called over-broad", () => {
  const wide: CatalogServer[] = [
    {
      id: "4",
      label: "Many",
      tools: Array.from({ length: MAX_PER_LOAD + 1 }, (_, i) => tool(`many__t${i}`)),
    },
  ];
  const asked = wide[0].tools.map((t) => t.name);
  const resolved = expandNames(asked, wide);

  expect(resolved.matched).toHaveLength(MAX_PER_LOAD);
  expect(resolved.deferred).toEqual([`many__t${MAX_PER_LOAD}`]);
  expect(resolved.overBroad).toEqual([]);

  // The old message told it this one exact name matched one tool, "more than the twelve one
  // call may load", and to pick from a list holding only that name — nothing it could act on
  // but sending the same call again.
  const text = loadResult(resolved, wide);
  expect(text).not.toContain("Name the ones you need from:");
  expect(text).toContain(`This call is full at ${MAX_PER_LOAD} tools`);
  expect(text).toContain(`many__t${MAX_PER_LOAD}`);
});

test("a name that only repeats an earlier match does not spend budget", () => {
  const resolved = expandNames(["gmail__send_email", "send_email", "gmail__*"], catalog);
  expect(resolved.matched.sort()).toEqual([
    "gmail__list_labels",
    "gmail__read_email",
    "gmail__send_email",
  ]);
  expect(resolved.overBroad).toEqual([]);
});

test("a bare wildcard is answered with the names rather than the whole catalogue", () => {
  const resolved = expandNames(["*"], catalog);
  expect(resolved.matched).toEqual([]);
  expect(resolved.overBroad).toHaveLength(1);
  expect(resolved.overBroad[0].hits).toHaveLength(5);
  expect(loadResult(resolved, catalog)).toContain("Name the ones you need from:");
});

test("a caller's own cap is what the resolution is held to and what it reports", () => {
  const resolved = expandNames(["gmail__*"], catalog, 2);
  expect(resolved.matched).toEqual([]);
  expect(resolved.overBroad[0].name).toBe("gmail__*");
  expect(resolved.maxPerLoad).toBe(2);
  // Carried on the resolution rather than read again from the module, so the number the model is
  // told about is the number it was actually held to.
  expect(loadResult(resolved, catalog)).toContain("more than the 2 one call may load");
});

test("a caller's own cap defers what does not fit it", () => {
  const resolved = expandNames(["gmail__send_email", "files__read_file"], catalog, 1);
  expect(resolved.matched).toEqual(["gmail__send_email"]);
  expect(resolved.deferred).toEqual(["files__read_file"]);
  expect(loadResult(resolved, catalog)).toContain("This call is full at 1 tools");
});

test("carry-over carries as many as it was asked to", () => {
  expect(carryOver(["a", "b", "c"], new Set(["d"]), 2)).toEqual(["c", "d"]);
  // A cap of nobody's is not a cap of none: `slice(-0)` is the whole array, which is the one
  // answer a caller asking for zero cannot have meant.
  expect(carryOver(["a", "b", "c"], new Set(["d"]), 0)).toEqual(["d"]);
});

test("the preselector is told the cap it will be held to", () => {
  expect(preselectSystem(3)).toContain("at most 3");
  expect(PRESELECT_SYSTEM).toContain(`at most ${MAX_PER_LOAD}`);
  expect(preselection(["gmail__send_email", "gmail__read_email"], catalog, 1)).toEqual([
    "gmail__send_email",
  ]);
});

test("the preselect prompt is cut where the caller says", () => {
  const input = preselectInput(catalog, "read my notes file", 7);
  expect(input).toContain("read my");
  expect(input).not.toContain("notes");
});

/**
 * A catalogue the size of a real one, with the descriptions a pool actually hands over — the
 * shared vocabulary ("list", "get", "file", "the repository") is the point, since that is what
 * a plain overlap count drowns in.
 */
const desks: CatalogServer[] = [
  {
    id: "git",
    label: "Git",
    tools: [
      { name: "git__commit", description: "Record staged changes in the repository as a commit" },
      { name: "git__status", description: "Show the working tree status of the repository" },
      { name: "git__diff", description: "Show changes between commits in the repository" },
      { name: "git__log", description: "List the commit history of the repository" },
      { name: "git__branch", description: "List or create branches in the repository" },
      { name: "git__push", description: "Send local commits to the remote repository" },
    ],
  },
  {
    id: "fs",
    label: "Files",
    tools: [
      { name: "fs__read_file", description: "Read the contents of a file from disk" },
      { name: "fs__write_file", description: "Write contents to a file on disk" },
      { name: "fs__list_directory", description: "List the files in a directory on disk" },
      { name: "fs__move_file", description: "Move or rename a file on disk" },
      { name: "fs__search_files", description: "Search for files on disk matching a pattern" },
    ],
  },
  {
    id: "web",
    label: "Web",
    tools: [
      { name: "web__fetch_url", description: "Fetch the contents of a URL over HTTP" },
      { name: "web__search", description: "Search the web and get a list of result pages" },
      { name: "web__screenshot", description: "Take a screenshot of a page in a browser" },
    ],
  },
  {
    id: "db",
    label: "Database",
    tools: [
      { name: "db__query", description: "Run a read-only SQL query against the database" },
      { name: "db__execute", description: "Run a statement that writes to the database" },
      { name: "db__list_tables", description: "List the tables in the database" },
      { name: "db__describe_table", description: "Show the columns of a table in the database" },
    ],
  },
  {
    id: "cal",
    label: "Calendar",
    tools: [
      { name: "cal__list_events", description: "List events on the calendar for a date range" },
      { name: "cal__create_event", description: "Add an event to the calendar" },
      { name: "cal__delete_event", description: "Remove an event from the calendar" },
    ],
  },
];

/** Requests, and the one tool each is really asking for. */
const asked: [string, string][] = [
  ["Commit the staged changes with a short message", "git__commit"],
  ["What branches exist in this repo?", "git__branch"],
  ["Push my work to the remote", "git__push"],
  ["Read the file at src/index.ts and tell me what it exports", "fs__read_file"],
  ["Rename that file to something clearer", "fs__move_file"],
  ["Which directory are the fixtures in? List it.", "fs__list_directory"],
  ["Take a screenshot of the landing page", "web__screenshot"],
  ["Fetch https://example.com and summarise it", "web__fetch_url"],
  ["What columns does the users table have?", "db__describe_table"],
  ["Put a dentist appointment on my calendar for Tuesday", "cal__create_event"],
];

test("the words alone find the tool a request is asking for", () => {
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

test("a word the whole catalogue uses is worth less than one that names a tool", () => {
  const shared: CatalogServer[] = [
    {
      id: "1",
      label: "Desk",
      tools: [
        { name: "desk__alpha", description: "Get the thing and hand the thing back" },
        { name: "desk__beta", description: "Put the thing somewhere and say so" },
        { name: "desk__gamma", description: "Count the thing, then count the thing again" },
        { name: "desk__zebra", description: "Get the zebra" },
      ],
    },
  ];
  // "thing" is in three of four descriptions and twice in two of them, so on a shared-word count
  // it decides the ranking. What the request is actually about is the word only one tool uses.
  const ranked = preselectByKeywords(shared, "the thing zebra").ranked;
  expect(ranked[0].name).toBe("desk__zebra");
});

test("words the catalogue does not use pick nothing, and say so", () => {
  // The words cannot tell a request that needs no tools from one whose words are not in the
  // catalogue, so neither is a confident answer and both go to the model.
  for (const prompt of ["Sing me a song about autumn", "Could you have a look at that for me"]) {
    const none = preselectByKeywords(desks, prompt);
    expect(none.names).toEqual([]);
    expect(none.confident).toBe(false);
  }
});

test("a request that names a whole server is not confident about which of its tools", () => {
  // Every database tool scores nearly the same on "database", so the cut between them is
  // arbitrary — which is the case the model is worth spending on.
  const broad = preselectByKeywords(desks, "Do something with the database", { maxPerLoad: 2 });
  expect(broad.names.length).toBe(2);
  expect(broad.confident).toBe(false);
});

test("the ranking does not depend on the order servers connected in", () => {
  const prompt = "read the file and commit it";
  const forwards = preselectByKeywords(desks, prompt);
  const backwards = preselectByKeywords([...desks].reverse(), prompt);
  expect(backwards.names).toEqual(forwards.names);
});

test("plurals and camelCase meet the names they are asking for", () => {
  // "files" against `fs__read_file`, and a camelCase catalogue split the same way as a snake one.
  expect(preselectByKeywords(desks, "list the files in src").names).toContain("fs__list_directory");
  const camel: CatalogServer[] = [
    { id: "1", label: "Notes", tools: [{ name: "notes__createNote", description: "Add a note" }] },
  ];
  expect(preselectByKeywords(camel, "create a note").names).toEqual(["notes__createNote"]);
});

test("the request is read only as far as the preselector reads it", () => {
  const buried = `${"filler words ".repeat(300)}commit the changes`;
  expect(preselectByKeywords(desks, buried).names).not.toContain("git__commit");
  expect(preselectByKeywords(desks, buried, { maxPromptChars: 10_000 }).names).toContain(
    "git__commit",
  );
});
