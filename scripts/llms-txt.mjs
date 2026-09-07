/**
 * Writes `llms.txt` from what `src/index.ts` actually exports.
 *
 * Generated rather than written because the hand-maintained alternative is a second copy of the
 * API surface that drifts from the first, which is the failure this repo has already had to fix
 * once. Anything wrong here should be fixed in the doc comment it came from.
 *
 * The parse is deliberately small and hand-rolled. TypeScript 7 is the native compiler and no
 * longer ships the JS API this would otherwise have used; its replacement is published under
 * `typescript/unstable/*`, and `build` is what `prepare` runs, so an unstable API breaking under
 * a caret range would break publishing. The shape being read is our own and regular, so reading
 * it directly costs less than that risk — and every assumption below throws rather than guessing,
 * so a source file that stops matching fails the build instead of quietly emitting less.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

/**
 * Every doc comment in a file, with the line that follows it.
 *
 * Both spellings are read: the one-line `/** text *\/` these files use for a short note, and the
 * block form. What follows the closing delimiter is what says who the comment belongs to — a
 * declaration means the comment documents it, a blank line means it documents the file.
 */
function docBlocks(source) {
  const blocks = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].indexOf("/**");
    if (open === -1) continue;
    const sameLineClose = lines[i].indexOf("*/", open + 3);
    if (sameLineClose !== -1) {
      blocks.push({
        body: [lines[i].slice(open + 3, sameLineClose).trim()],
        next: lines[i + 1] ?? "",
      });
      continue;
    }
    const body = [];
    let j = i + 1;
    for (; j < lines.length && !lines[j].includes("*/"); j++)
      body.push(lines[j].replace(/^\s*\* ?/, ""));
    if (j === lines.length) throw new Error("unterminated doc comment");
    const tail = lines[j]
      .slice(0, lines[j].indexOf("*/"))
      .replace(/^\s*\* ?/, "")
      .trim();
    if (tail !== "") body.push(tail);
    blocks.push({ body, next: lines[j + 1] ?? "" });
    i = j;
  }
  return blocks;
}

/** The paragraphs of a doc comment body, each collapsed to a single line. */
function paragraphs(body) {
  const out = [];
  let current = [];
  for (const line of body) {
    if (line.trim() === "") {
      if (current.length > 0) out.push(current.join(" ").trim());
      current = [];
    } else current.push(line.trim());
  }
  if (current.length > 0) out.push(current.join(" ").trim());
  return out.filter((entry) => entry !== "");
}

/** The declared name on a line, for the declaration forms this source actually uses. */
function declaredName(line) {
  const match = line.match(
    /^export\s+(?:declare\s+)?(?:async\s+)?(?:function\s*\*?|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  );
  return match?.[1] ?? null;
}

/** First sentence of a doc comment, as one line. Abbreviations are not sentence ends. */
function summarize(body) {
  const text = paragraphs(body)[0] ?? "";
  if (text === "") return "";
  const match = text.match(/^(.*?[.!?])(?:\s|$)/s);
  if (!match) return text;
  // `e.g.`/`i.e.`/`vs.` end a clause, not a sentence: keep reading past them.
  let end = match[1];
  let rest = text.slice(end.length);
  while (/(?:^|\s)(?:e\.g|i\.e|vs|etc|cf)\.$/.test(end) && rest.trim() !== "") {
    const more = rest.match(/^(\s*.*?[.!?])(?:\s|$)/s);
    if (!more) return text;
    end += more[1];
    rest = rest.slice(more[1].length);
  }
  return end;
}

/** Every `export ... from "./module.ts"` in index order, with the names each one re-exports. */
function reexports(indexSource) {
  const found = [];
  const pattern = /export\s+(type\s+)?\{([^}]*)\}\s*from\s*"\.\/([\w-]+)\.ts";/g;
  for (const [, blanketType, inner, module] of indexSource.matchAll(pattern)) {
    const names = inner
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "")
      .map((entry) => {
        const isType = Boolean(blanketType) || entry.startsWith("type ");
        return { name: entry.replace(/^type\s+/, ""), isType };
      });
    if (names.length === 0) throw new Error(`no names re-exported from ${module}`);
    found.push({ module, names });
  }
  if (found.length === 0) throw new Error("no re-exports found in src/index.ts — parser is stale");
  return found;
}

const pkg = JSON.parse(read("package.json"));
const index = read("src/index.ts");

// The block at the top of index.ts, which describes the package rather than any one symbol.
const intro = docBlocks(index).find((block) => block.next.trim() === "");
if (!intro) throw new Error("src/index.ts has no leading module comment");

const out = [`# ${pkg.name}`, "", `> ${pkg.description}`, ""];
// The opening paragraph restates the description directly above it; the rest is what a reader
// does not already have, so the blockquote takes the first and the body takes what follows.
for (const paragraph of paragraphs(intro.body).slice(1)) out.push(paragraph, "");
out.push(
  `Requires Node ${pkg.engines.node}, with \`openai\` ${pkg.peerDependencies.openai} as a peer dependency. ESM only.`,
  "Full prose, worked examples and the reasoning behind each seam are in README.md; this file is the index.",
  "",
  "## Exports",
  "",
);

let total = 0;
let described = 0;
const undocumented = [];

for (const { module, names } of reexports(index)) {
  const source = read(`src/${module}.ts`);
  const blocks = docBlocks(source);

  const docs = new Map();
  for (const block of blocks) {
    const name = declaredName(block.next);
    if (name) docs.set(name, summarize(block.body));
  }
  // A block trailed by a blank line documents the file, not the declaration further down.
  const moduleDoc = blocks.find((block) => block.next.trim() === "");

  out.push(`### ${module}`, "");
  if (moduleDoc) out.push(summarize(moduleDoc.body), "");
  for (const { name, isType } of names) {
    const summary = docs.get(name);
    const label = isType ? `\`${name}\` (type)` : `\`${name}\``;
    out.push(summary ? `- ${label} — ${summary}` : `- ${label}`);
    total += 1;
    if (summary) described += 1;
    else undocumented.push(`${module}.${name}`);
  }
  out.push("");
}

const rendered = `${out
  .join("\n")
  .replace(/\n{3,}/g, "\n\n")
  .trimEnd()}\n`;
const target = join(root, "llms.txt");

// `--check` is what CI runs. The file is committed, so an export added or a doc comment reworded
// without regenerating leaves a stale index — and not having to notice that by hand is the
// reason this is generated at all.
if (process.argv.includes("--check")) {
  const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (existing !== rendered) {
    console.error("llms.txt is out of date. Run `npm run llms` and commit the result.");
    process.exit(1);
  }
  console.log("llms.txt is up to date");
} else {
  writeFileSync(target, rendered);
  console.log(`llms.txt written: ${described}/${total} exports carry a description`);
  // Named rather than only counted: an undocumented export is a gap in the source, and the
  // generator is the only thing positioned to notice. Not an error — a missing comment is worth
  // knowing about, not worth failing a build over.
  if (undocumented.length > 0) console.log(`no doc comment: ${undocumented.join(", ")}`);
}
