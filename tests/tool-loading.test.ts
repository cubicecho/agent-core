import { expect, test } from "vitest";
import type { CatalogServer } from "../src/catalog.ts";
import {
  carryOver,
  catalogPrompt,
  expandNames,
  inCatalog,
  loadResult,
  MAX_CARRIED,
  MAX_PER_LOAD,
  preselectInput,
  preselection,
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

test("a preselection is resolved against the catalogue and capped", () => {
  expect(preselection(["gmail__send_email", "invented"], catalog)).toEqual(["gmail__send_email"]);
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

test("carry-over keeps what was used, most recent last", () => {
  expect(carryOver(["a", "b"], new Set(["b", "c"]))).toEqual(["a", "b", "c"]);
});

test("carry-over drops the least recently used past the cap", () => {
  const previous = Array.from({ length: MAX_CARRIED }, (_, i) => `old_${i}`);
  const out = carryOver(previous, new Set(["fresh"]));
  expect(out).toHaveLength(MAX_CARRIED);
  expect(out.at(-1)).toBe("fresh");
  expect(out).not.toContain("old_0");
});
