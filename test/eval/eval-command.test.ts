// `ondocs eval` with an index embedded through a config module's model, which `ondocs dev`
// cannot load, and the ranks past the top three: hit@5, MRR and the pages that ranked fourth and
// fifth, and the words of a refused question that no page has.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildIndex } from '../../src';
import { main } from '../../src/cli/main';
import { writeIndexFile } from '../../src/node';

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'ondocs-eval-command-'));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function run(...args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(args, {
    cwd,
    env: {},
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

/**
 * A config module whose embedding model is a local one of its own, as a self-hosted or another
 * provider's would be: `modelId` names it, and each text it embeds is counted on `globalThis`.
 */
const config = (modelId: string) => `
import { hashEmbedding } from ${JSON.stringify(new URL('../../src/mock/index.ts', import.meta.url).href)};
export default {
  embeddingModel: {
    specificationVersion: 'v4',
    provider: 'local',
    modelId: ${JSON.stringify(modelId)},
    maxEmbeddingsPerCall: 64,
    supportsParallelCalls: true,
    async doEmbed({ values }) {
      globalThis.ondocsEvalEmbedded = (globalThis.ondocsEvalEmbedded ?? 0) + values.length;
      return { embeddings: values.map((value) => hashEmbedding(value, 256)), warnings: [] };
    },
  },
};
`;

describe('ondocs eval -c', () => {
  beforeEach(async () => {
    await mkdir(join(cwd, 'content'));
    await writeFile(
      join(cwd, 'content/deploy.md'),
      '# Deploying\n\nShip the site to the edge with one command, and roll back from the dashboard.\n',
    );
    await writeFile(
      join(cwd, 'content/search.md'),
      '# Search\n\nThe search box ranks pages by keywords and by meaning.\n',
    );
    await writeFile(
      join(cwd, 'questions.yaml'),
      'questions:\n  - question: How do I deploy the site to the edge?\n    expect: /deploy\n',
    );
    await writeFile(join(cwd, 'ask.config.mjs'), config('nomic-embed-text'));
    await writeFile(join(cwd, 'other.config.mjs'), config('all-minilm'));
    const built = await run('index', 'content', '-c', 'ask.config.mjs', '--framework', 'none');
    expect(built.code).toBe(0);
  });

  it('embeds the questions with the config module’s model, as the index was built', async () => {
    const before = (globalThis as { ondocsEvalEmbedded?: number }).ondocsEvalEmbedded ?? 0;
    const result = await run('eval', 'questions.yaml', '-c', 'ask.config.mjs', '--json');
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      retrieval: string;
      results: { rank: number | null; best: { similarity: number | null } }[];
    };
    expect(report.retrieval).toBe('hybrid');
    expect(report.results[0]?.rank).toBe(1);
    expect(report.results[0]?.best.similarity).toBeGreaterThan(0);
    const after = (globalThis as { ondocsEvalEmbedded?: number }).ondocsEvalEmbedded ?? 0;
    expect(after - before).toBe(1);
  });

  it('says to pass -c when the index’s model is not one it can load by name', async () => {
    const result = await run('eval', 'questions.yaml');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('nomic-embed-text, which ondocs dev cannot load');
    expect(result.stderr).toContain('Or pass -c with the config module that embeds with it');
  });

  it('refuses a config whose model is not the index’s, and a config that is not there', async () => {
    const other = await run('eval', 'questions.yaml', '--config', 'other.config.mjs');
    expect(other.code).toBe(2);
    expect(other.stderr).toContain(
      'The index was embedded with nomic-embed-text, but other.config.mjs embeds with all-minilm.',
    );
    const missing = await run('eval', 'questions.yaml', '-c', 'missing.mjs');
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('Config file not found: missing.mjs');
  });

  it('searches by keywords alone with --keyword-only, whatever the config', async () => {
    const result = await run(
      'eval',
      'questions.yaml',
      '-c',
      'other.config.mjs',
      '--keyword-only',
      '--json',
    );
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as { retrieval: string }).retrieval).toBe('keyword');
  });
});

describe('ondocs eval past the top three', () => {
  // Six pages of the same length, the first with "zebra" six times and each next one once less,
  // so a search for it ranks them in order.
  beforeEach(async () => {
    const documents = [1, 2, 3, 4, 5, 6].map((n) => ({
      id: `p${String(n)}.md`,
      url: `/docs/p${String(n)}`,
      title: `Page ${String(n)}`,
      content: `${'zebra '.repeat(7 - n)}${'lorem '.repeat(n + 3)}`.trim(),
    }));
    const { index } = await buildIndex({ documents });
    await writeIndexFile(join(cwd, 'ask-index.json'), index);
    await writeFile(
      join(cwd, 'questions.yaml'),
      `questions:
  - question: zebra
    expect: /docs/p1
  - question: zebra
    expect: /docs/p4
  - question: zebra
    expect: /docs/elsewhere
  - question: quokka habitat
    expect: /docs/p1
  - question: Where do quokkas live?
    unanswerable: true
`,
    );
  });

  it('scores hit@5 and MRR, with thresholds of their own', async () => {
    const json = await run('eval', 'questions.yaml', '--json');
    const report = JSON.parse(json.stdout) as {
      scores: Record<string, { value: number; count: number; of: number }>;
      results: { rank: number | null; found: string[]; absent: string[] }[];
    };
    expect(report.results.map((result) => result.rank)).toEqual([1, 4, null, null, null]);
    expect(report.scores['hit@3']).toMatchObject({ count: 1, of: 4 });
    expect(report.scores['hit@5']).toMatchObject({ count: 2, of: 4, value: 0.5 });
    // (1/1 + 1/4) over the four answerable questions; one not found and one refused add 0.
    expect(report.scores.mrr).toMatchObject({ count: 1.25, of: 4, value: 0.3125 });
    expect(report.results[1]?.found).toEqual([
      '/docs/p1',
      '/docs/p2',
      '/docs/p3',
      '/docs/p4',
      '/docs/p5',
    ]);

    const text = await run('eval', 'questions.yaml', '--min-hit-at-5', '0.6', '--min-mrr', '0.3');
    expect(text.code).toBe(1);
    expect(text.stdout).toContain('  hit@5              0.50  (2/4)  threshold 0.6 ✗');
    expect(text.stdout).toContain('  MRR                0.31  (1.25/4)  threshold 0.3 ✓');
    expect(text.stderr).toBe('✗ hit@5 is 0.50, under its threshold of 0.6.');

    await writeFile(
      join(cwd, 'thresholds.yaml'),
      'thresholds: { hit@5: 0.5, mrr: 0.31 }\nquestions:\n  - question: zebra\n    expect: /docs/p4\n',
    );
    const fromFile = await run('eval', 'thresholds.yaml', '--json');
    expect(fromFile.code).toBe(1);
    expect(JSON.parse(fromFile.stdout)).toMatchObject({
      scores: { 'hit@5': { value: 1, pass: true }, mrr: { value: 0.25, pass: false } },
    });
  });

  it('prints what ranked fourth and fifth, and the words of a refused question no page has', async () => {
    const { stdout } = await run('eval', 'questions.yaml');
    expect(stdout).toMatch(
      /✗ -\s+zebra\s+cov 1\.00 {2}→ \/docs\/p1, \/docs\/p2, \/docs\/p3, \/docs\/p4, \/docs\/p5/,
    );
    expect(stdout).toMatch(
      /✗ refused\s+quokka habitat\s+cov 0\.00 {2}expected \/docs\/p1; not in the docs: quokka, habitat/,
    );
    const json = JSON.parse((await run('eval', 'questions.yaml', '--json')).stdout) as {
      results: { absent: string[] }[];
    };
    expect(json.results.map((result) => result.absent)).toEqual([
      [],
      [],
      [],
      ['quokka', 'habitat'],
      ['quokka', 'live'],
    ]);
  });
});
