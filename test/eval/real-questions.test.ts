// The real-question evals: Stack Overflow's questions about Docusaurus, Astro and Vitest, with the
// pages the accepted answers link (README.md in this folder), on each project's docs at the
// commit scripts/corpus.mjs pins. CI fetches the docs and scores each file with the CLI, under
// its thresholds; locally, run `node scripts/corpus.mjs` first, or the part that needs them is
// skipped. Here: every question is linked and credited, every expected page is a page of the
// pinned docs, and the scores are the ones the docs and each file's header quote.
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { CORPORA, indexArgs } from '../../scripts/corpus.mjs';
import { parseIndexFile } from '../../src';
import { main } from '../../src/cli/main';

const root = join(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const readme = read('test/eval/README.md');
const quality = read('examples/nextjs/content/docs/quality.md');

const corpusDir = process.env.ONDOCS_CORPUS ?? join(root, '.corpus');
const present = CORPORA.every((corpus) => existsSync(join(corpusDir, corpus.name, corpus.docs)));
if (!present && process.env.CI)
  throw new Error(`No corpus at ${corpusDir}: run node scripts/corpus.mjs`);

interface EvalFile {
  questions: ({ question: string; expect: string | string[] } | { question: string })[];
}
const files = CORPORA.map((corpus) => {
  const path = `test/eval/${corpus.name}-title.yaml`;
  const text = read(path);
  return { corpus, path, text, file: parse(text) as EvalFile };
});

/** `args` as a shell command line writes them, with a glob quoted. */
const shell = (args: string[]) =>
  args.map((arg) => (/[*?]/.test(arg) ? `'${arg}'` : arg)).join(' ');

/** The cells of the Markdown table row of `text` whose first cell starts with `label`. */
const row = (text: string, label: string) =>
  text
    .split('\n')
    .find((line) => line.startsWith(`| ${label}`))
    ?.split('|')
    .slice(2, -1)
    .map((cell) => cell.trim());

describe('the Stack Overflow question files', () => {
  it('link every question to its page on Stack Overflow, which the README credits', () => {
    for (const { path, text, file } of files) {
      const lines = text.split('\n');
      const links = lines.flatMap((line, i) =>
        /^ {2}- question:/.test(line)
          ? [/^ {2}# (https:\/\/stackoverflow\.com\/q\/\d+)\b/.exec(lines[i - 1] ?? '')?.[1]]
          : [],
      );
      expect([path, links.length]).toEqual([path, file.questions.length]);
      expect([path, links.filter((link) => link === undefined)]).toEqual([path, []]);
      for (const link of links)
        expect([path, readme.includes(`](${String(link)})`)]).toEqual([path, true]);
      expect(new Set(links).size).toBe(links.length);
    }
    expect(readme).toContain('[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)');
  });

  it('are what the README’s best-case count points to', () => {
    // The 22 of 22 is the project's own queries, in the docs' words: the line links these too.
    const line = read('README.md')
      .split('\n')
      .find((text) => text.startsWith('- **Quality.**'));
    expect(line).toContain('a best case');
    expect(line).toContain(
      '(https://ondocs.vercel.app/docs/quality#real-questions-from-stack-overflow)',
    );
    expect(quality).toContain('## Real questions from Stack Overflow');
  });

  it('give the counts the README gives, with 15 off-topic questions each', () => {
    for (const { corpus, path, file } of files) {
      const answerable = file.questions.filter((question) => 'expect' in question).length;
      const offTopic = file.questions.length - answerable;
      expect([path, offTopic]).toEqual([path, 15]);
      const cells = row(readme, `\`${corpus.name}-title.yaml\``);
      expect([path, cells?.slice(1)]).toEqual([path, [String(answerable), String(offTopic)]]);
    }
  });

  it('give the index command scripts/corpus.mjs gives, as CI runs it', () => {
    const ci = read('.github/workflows/ci.yml');
    for (const { corpus, path, text } of files) {
      const args = shell(indexArgs('.corpus', corpus));
      expect([
        path,
        text.includes(`#   ondocs index ${args} -e none -o ${corpus.name}.json\n`),
      ]).toEqual([path, true]);
      expect([
        path,
        ci.includes(
          `node dist/cli.js index ${args} -e none -o "$RUNNER_TEMP/${corpus.name}.json" -q\n`,
        ),
      ]).toEqual([path, true]);
      expect([
        path,
        ci.includes(`node dist/cli.js eval ${path} --index "$RUNNER_TEMP/${corpus.name}.json"\n`),
      ]).toEqual([path, true]);
    }
  });
});

describe.skipIf(!present)('the Stack Overflow questions on the pinned docs, keyword-only', () => {
  it.each(files)(
    '$path: expects only pages of the docs, and scores what the docs quote',
    async ({ corpus, path, text, file }) => {
      const dir = await mkdtemp(join(tmpdir(), 'ondocs-real-questions-'));
      try {
        const io = { cwd: dir, env: {}, stdout: () => undefined, stderr: () => undefined };
        const built = await main(
          ['index', ...indexArgs(corpusDir, corpus), '-e', 'none', '-o', 'index.json', '-q'],
          io,
        );
        expect(built).toBe(0);
        const index = parseIndexFile(readFileSync(join(dir, 'index.json'), 'utf8'));
        expect(row(readme, `\`${corpus.name}-title.yaml\``)?.[0]).toContain(
          `${String(index.documents.length)} pages`,
        );

        const pages = new Set(
          index.documents.map((document) => document.url.replace(/(.)\/$/, '$1')),
        );
        const expected = file.questions.flatMap((question) =>
          'expect' in question ? [question.expect].flat() : [],
        );
        expect(expected.filter((url) => !pages.has(url))).toEqual([]);

        const out: string[] = [];
        const code = await main(['eval', join(root, path), '--index', 'index.json', '--json'], {
          ...io,
          stdout: (line) => out.push(line),
        });
        // At or over every threshold the file sets, as CI's run of the CLI checks.
        expect(code).toBe(0);
        const { scores } = JSON.parse(out.join('\n')) as {
          scores: Record<string, { value: number; count: number; of: number }>;
        };
        const score = (name: string) => scores[name] ?? { value: NaN, count: -1, of: -1 };
        const fraction = (name: string) =>
          `${String(score(name).count)} of ${String(score(name).of)}`;
        const answerable = score('hit@1').of;
        const offTopic = score('refusalRecall');
        const refused = score('refusalPrecision');
        expect(row(quality, corpus.title)).toEqual([
          fraction('hit@1'),
          fraction('hit@3'),
          fraction('hit@5'),
          score('mrr').value.toFixed(2),
          `${String(offTopic.of - offTopic.count)} of ${String(offTopic.of)}`,
          `${String(refused.of - refused.count)} of ${String(answerable)}`,
        ]);
        const slash = (name: string) => `${String(score(name).count)}/${String(score(name).of)}`;
        expect(text).toContain(
          `# Keyword-only, these docs score hit@1 ${slash('hit@1')}, hit@3 ${slash('hit@3')}, hit@5 ${slash('hit@5')} and MRR ${score('mrr').value.toFixed(2)},\n# refuse ${String(refused.of - refused.count)} of the ${String(answerable)} answerable questions, and answer ${String(offTopic.of - offTopic.count)} of the 15 off-topic ones.`,
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
