// Measures retrieval on real docs with real embeddings, which CI cannot do without a key: indexes
// the three docs folders scripts/corpus.mjs pins (docusaurus.io's, Astro's and Vitest's) with
// OpenAI's text-embedding-3-small at 512 dimensions, runs `ondocs eval` on each one's question
// files at a sweep of the relevance gate's `minSimilarity` (0.25 is the default), and writes
// report.json and report.md. The files: test/eval/docusaurus.io.yaml, the 2026-10-10 audit's
// questions, and test/eval/<corpus>-title.yaml, Stack Overflow's (test/eval/README.md).
// .github/workflows/retrieval-eval.yml runs it on demand, with the OPENAI_API_KEY secret.
//
//   pnpm build && node scripts/corpus.mjs
//   OPENAI_API_KEY=… node scripts/retrieval-eval.mjs [--out dir] [--max-chunks n]
//   node scripts/retrieval-eval.mjs --stub    # the same run against scripts/openai-stub.mjs
//
// It runs the CLI as a site would: `ondocs index` and `ondocs eval`, from dist. Before anything is
// embedded, a keyword-only build of each docs folder counts its chunks, and the run stops if one
// has more than --max-chunks (default 5,000; the pinned docs are 1,070, 4,805 and 2,233), so it
// cannot embed more than that of any of them.
//
// --stub answers every embedding call from a local stand-in for OpenAI's API, whose vectors come
// from a hash of the text: no key, no cost, and numbers that only check the pipeline. Requests
// to any other host fail, as the CLI runs behind a proxy that does not exist.
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { CORPORA, indexArgs } from './corpus.mjs';
import { startOpenAIStub } from './openai-stub.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const thousands = (value) => value.toLocaleString('en-US');
const MODEL = 'text-embedding-3-small';
const DIMENSIONS = 512;
/** The gate's `minSimilarity` values to score; 0.25 is the default for OpenAI's models. */
const SWEEP = [0.15, 0.2, 0.25, 0.3, 0.35, 0.4];
const DEFAULT_GATE = 0.25;
/** The question files, each with the docs it asks about. */
const SETS = [
  { corpus: 'docusaurus', file: 'test/eval/docusaurus.io.yaml', name: 'docusaurus.io' },
  { corpus: 'docusaurus', file: 'test/eval/docusaurus-title.yaml', name: 'docusaurus-title' },
  { corpus: 'astro', file: 'test/eval/astro-title.yaml', name: 'astro-title' },
  { corpus: 'vitest', file: 'test/eval/vitest-title.yaml', name: 'vitest-title' },
];

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    corpus: { type: 'string' },
    'max-chunks': { type: 'string' },
    stub: { type: 'boolean' },
  },
});

/** Stops the run with `message`, before or instead of anything else. */
function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(2);
}

const maxChunks = Number(values['max-chunks'] ?? 5000);
if (!Number.isInteger(maxChunks) || maxChunks < 1) fail('--max-chunks must be a positive integer.');
const cli = join(root, 'dist/cli.js');
if (!existsSync(cli)) fail('No dist/cli.js: run pnpm build first.');
const corpusDir = resolve(values.corpus ?? process.env.ONDOCS_CORPUS ?? join(root, '.corpus'));
for (const corpus of CORPORA) {
  const docs = join(corpusDir, corpus.name, corpus.docs);
  if (!existsSync(docs)) fail(`No docs at ${docs}: run node scripts/corpus.mjs first.`);
}
const out = resolve(values.out ?? join(root, '.corpus/retrieval-eval'));
mkdirSync(out, { recursive: true });
// A previous run's files go first: `ondocs index` would reuse the vectors of an ask-index.json it
// finds, and a stub run's are not OpenAI's.
for (const corpus of CORPORA) rmSync(join(out, corpus.name), { recursive: true, force: true });
for (const file of ['report.json', 'report.md']) rmSync(join(out, file), { force: true });

const stub = values.stub ? await startOpenAIStub() : null;
if (!stub && !process.env.OPENAI_API_KEY) {
  fail(
    'OPENAI_API_KEY is not set. This run embeds with OpenAI; set the key, or pass --stub to run ' +
      'it against the local stand-in.',
  );
}

/**
 * The CLI's environment: the key, and with --stub, the stub's URL, a key that is not one, and a
 * proxy that does not exist for every other host. No AI Gateway key, so nothing goes that way.
 */
const env = { ...process.env };
delete env.AI_GATEWAY_API_KEY;
if (stub) {
  Object.assign(env, {
    OPENAI_API_KEY: 'stub-key-not-a-real-key',
    OPENAI_BASE_URL: stub.url,
    NODE_USE_ENV_PROXY: '1',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    HTTP_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost',
  });
} else {
  delete env.OPENAI_BASE_URL;
}

/**
 * Runs the CLI in `cwd`, which has no .env file for it to load, and returns what it printed.
 * Asynchronously, so that the stub, in this process, can answer it. With `report`, it is
 * `ondocs eval --json`, whose exit 1 with a report is a score under a threshold: a result here.
 * Any other failure stops the run.
 */
async function ondocs(args, cwd, { show = false, report = false } = {}) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd,
    env,
    stdio: ['ignore', show ? 'inherit' : 'pipe', show ? 'inherit' : 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8').on('data', (text) => (stdout += text));
  child.stderr?.setEncoding('utf8').on('data', (text) => (stderr += text));
  const [code] = await once(child, 'close');
  if (report && (code === 0 || code === 1)) {
    try {
      return JSON.parse(stdout);
    } catch {
      // No report: the eval failed before it scored anything, as when embedding failed.
    }
  }
  if (code !== 0 || report) {
    console.error(`${stdout}${stderr}`);
    fail(`ondocs ${args[0] ?? ''} exited with ${String(code)}.`);
  }
  return stdout;
}

const readIndex = (dir, file) => JSON.parse(readFileSync(join(dir, file), 'utf8'));
const index = (corpus, embedding, file) =>
  ondocs(
    ['index', ...indexArgs(corpusDir, corpus), '-o', file, ...embedding],
    join(out, corpus.name),
    {
      show: embedding[1] !== 'none',
    },
  );

// 1. Count each docs folder's chunks with a keyword-only build, which embeds nothing, and stop
//    before any is embedded if one has more than the cap.
const counts = new Map();
for (const corpus of CORPORA) {
  mkdirSync(join(out, corpus.name), { recursive: true });
  await index(corpus, ['-e', 'none'], 'keyword-index.json');
  const keywordIndex = readIndex(join(out, corpus.name), 'keyword-index.json');
  counts.set(corpus.name, {
    pages: keywordIndex.documents.length,
    chunks: keywordIndex.chunks.length,
  });
}
const over = CORPORA.filter((corpus) => counts.get(corpus.name).chunks > maxChunks);
if (over.length > 0) {
  fail(
    `${over.map((corpus) => `${corpus.title} are ${thousands(counts.get(corpus.name).chunks)} chunks`).join(', ')}, over --max-chunks ${thousands(maxChunks)}: nothing was embedded.`,
  );
}
for (const corpus of CORPORA) {
  const { pages, chunks } = counts.get(corpus.name);
  console.log(
    `✓ ${corpus.title}: ${thousands(pages)} pages, ${thousands(chunks)} chunks, under the cap of ${thousands(maxChunks)}`,
  );
}

// 2. Embed them, as `ondocs index -e openai:text-embedding-3-small --dimensions 512` does for a site.
for (const corpus of CORPORA) {
  const dir = join(out, corpus.name);
  const { chunks } = counts.get(corpus.name);
  await index(
    corpus,
    ['-e', `openai:${MODEL}`, '--dimensions', String(DIMENSIONS)],
    'ask-index.json',
  );
  const embedded = readIndex(dir, 'ask-index.json');
  if (
    embedded.embedding?.model !== MODEL ||
    embedded.embedding.dimensions !== DIMENSIONS ||
    embedded.chunks.length !== chunks
  ) {
    fail(
      `${corpus.name}/ask-index.json is not ${thousands(chunks)} chunks of ${MODEL} at ${String(DIMENSIONS)} dimensions.`,
    );
  }
}

/** The numbers each table row gives, from an `ondocs eval --json` report. */
function summary(report) {
  const { refusalPrecision, refusalRecall } = report.scores;
  const hit = (name) => ({ count: report.scores[name].count, of: report.scores[name].of });
  return {
    hit1: hit('hit@1'),
    hit3: hit('hit@3'),
    hit5: hit('hit@5'),
    mrr: report.scores.mrr.value,
    offTopicAnswered: { count: refusalRecall.of - refusalRecall.count, of: refusalRecall.of },
    answerableRefused: {
      count: refusalPrecision.of - refusalPrecision.count,
      of: report.scores['hit@1'].of,
    },
    pass: report.pass,
  };
}

/** The lowest, middle and highest of `numbers`. */
function spread(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  const median =
    sorted.length % 2 === 1
      ? sorted[Math.floor(middle)]
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  return { min: sorted[0] ?? null, median: median ?? null, max: sorted.at(-1) ?? null };
}

// 3. Score each question file: keyword-only, then with embeddings at each gate. Each run embeds
//    the questions.
const sets = [];
for (const set of SETS) {
  const dir = join(out, set.corpus);
  const path = join(root, set.file);
  const questions = parseYaml(readFileSync(path, 'utf8'));
  const evaluate = async (indexFile, minSimilarity) => {
    let file = path;
    if (minSimilarity !== undefined) {
      file = join(dir, `questions-${set.name}-${minSimilarity.toFixed(2)}.yaml`);
      const { index: _index, retrieval, ...rest } = questions;
      writeFileSync(file, stringifyYaml({ ...rest, retrieval: { ...retrieval, minSimilarity } }));
    }
    return ondocs(['eval', file, '--index', indexFile, '--json'], dir, { report: true });
  };
  const keywordOnly = await evaluate('keyword-index.json');
  const sweep = [];
  for (const minSimilarity of SWEEP) {
    sweep.push({
      minSimilarity,
      default: minSimilarity === DEFAULT_GATE,
      report: await evaluate('ask-index.json', minSimilarity),
    });
  }
  const atDefault = sweep.find((row) => row.default)?.report;
  const similarity = (unanswerable) =>
    spread(
      (atDefault?.results ?? [])
        .filter((result) => result.unanswerable === unanswerable)
        .map((result) => result.best.similarity)
        .filter((value) => value !== null),
    );
  sets.push({
    file: set.file,
    corpus: set.corpus,
    answerable: summary(keywordOnly).hit1.of,
    unanswerable: summary(keywordOnly).offTopicAnswered.of,
    keywordOnly: summary(keywordOnly),
    sweep: sweep.map(({ minSimilarity, default: isDefault, report: scored }) => ({
      minSimilarity,
      default: isDefault,
      ...summary(scored),
    })),
    // The closest chunk's similarity to each question, which the gate compares with minSimilarity.
    bestSimilarity: { answerable: similarity(false), unanswerable: similarity(true) },
    results: atDefault?.results ?? [],
  });
}

const git = (cwd) => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const report = {
  date: new Date().toISOString(),
  ondocs: { version, commit: process.env.GITHUB_SHA ?? git(root) },
  stub: Boolean(stub),
  embedding: { model: MODEL, dimensions: DIMENSIONS },
  corpora: CORPORA.map((corpus) => ({
    name: corpus.name,
    repository: corpus.repository,
    path: corpus.docs,
    commit: git(join(corpusDir, corpus.name)),
    ...counts.get(corpus.name),
  })),
  sets,
  // With --stub, every request the CLI made: all of them embedding calls, to the stub.
  stubRequests: stub ? stub.requests.length : undefined,
};
writeFileSync(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

const fraction = ({ count, of }) => `${String(count)} of ${String(of)}`;
const two = (value) => (value === null ? 'n/a' : value.toFixed(2));
const row = (label, s) =>
  `| ${label} | ${fraction(s.hit1)} | ${fraction(s.hit3)} | ${fraction(s.hit5)} | ${two(s.mrr)} | ${fraction(s.offTopicAnswered)} | ${fraction(s.answerableRefused)} |`;
const header = (first) => [
  `| ${first} | Right page first | In the top 3 | In the top 5 | MRR | Off-topic questions answered | Answerable questions refused |`,
  '| --- | --- | --- | --- | --- | --- | --- |',
];
const markdown = [
  `## Retrieval eval: ${MODEL} at ${String(DIMENSIONS)} dimensions`,
  '',
  ...(stub
    ? [
        `> **Stub run.** Embeddings came from scripts/openai-stub.mjs (${String(stub.requests.length)} requests), whose vectors are a hash of the text, not its meaning. These numbers check the pipeline, not retrieval.`,
        '',
      ]
    : []),
  `ondocs ${version}${report.ondocs.commit ? ` (${report.ondocs.commit.slice(0, 7)})` : ''}, ${report.date.slice(0, 10)}. The docs:`,
  '',
  ...report.corpora.map(
    (corpus) =>
      `- ${corpus.repository}@${(corpus.commit ?? 'unknown').slice(0, 7)}, ${corpus.path}: ${thousands(corpus.pages)} pages, ${thousands(corpus.chunks)} chunks`,
  ),
  '',
  ...header('Questions'),
  ...report.sets.flatMap((set) => [
    row(`${set.file}, keywords only`, set.keywordOnly),
    row(
      `${set.file}, keywords and ${MODEL} at ${DEFAULT_GATE.toFixed(2)}`,
      set.sweep.find((entry) => entry.default) ?? set.keywordOnly,
    ),
  ]),
  '',
  ...report.sets.flatMap((set) => {
    const { answerable, unanswerable } = set.bestSimilarity;
    return [
      `### ${set.file}`,
      '',
      `${String(set.answerable)} answerable questions and ${String(set.unanswerable)} off-topic ones, about ${CORPORA.find((corpus) => corpus.name === set.corpus)?.title ?? set.corpus}. The similarity gate:`,
      '',
      ...header('minSimilarity'),
      ...set.sweep.map((entry) =>
        row(`${entry.minSimilarity.toFixed(2)}${entry.default ? ' (default)' : ''}`, entry),
      ),
      '',
      `The closest chunk's similarity to each question: ${two(answerable.min)} to ${two(answerable.max)} (median ${two(answerable.median)}) for the answerable ones, ${two(unanswerable.min)} to ${two(unanswerable.max)} (median ${two(unanswerable.median)}) for the off-topic ones. A question is refused when no chunk clears the gate on similarity or on keyword coverage.`,
      '',
      `Question by question, at ${DEFAULT_GATE.toFixed(2)}:`,
      '',
      '| Question | Result | Best similarity | Best keyword coverage |',
      '| --- | --- | --- | --- |',
      ...set.results.map((result) => {
        const outcome = result.unanswerable
          ? result.refused
            ? 'refused, as it should be'
            : `answered from ${result.found.join(', ')}`
          : result.refused
            ? `refused; expected ${result.expect.join(' or ')}`
            : result.rank === null
              ? `missed; found ${result.found.join(', ')}`
              : `rank ${String(result.rank)}`;
        return `| ${result.question.replace(/\|/g, '\\|')} | ${outcome} | ${two(result.best.similarity)} | ${result.best.keywordCoverage.toFixed(2)} |`;
      }),
      '',
    ];
  }),
].join('\n');
writeFileSync(join(out, 'report.md'), markdown);
console.log(`\n${markdown}`);

if (stub) {
  await stub.close();
  const other = stub.requests.filter((request) => request !== 'POST /v1/embeddings');
  if (other.length > 0)
    fail(`The CLI asked the stub for more than embeddings: ${other.join(', ')}`);
}
console.log(`✓ Wrote report.json and report.md to ${out}`);
