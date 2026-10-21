// Indexes written by a released ondocs, read by this one. An endpoint and the site it answers for
// are often built apart (the GitHub Pages Worker fetches the live site's index and is upgraded on
// its own), so a reader change must not break a deployed index. The files in
// test/fixtures/index-0.10 were written by ondocs 0.10.0 from the Markdown beside them:
//
//   npx ondocs@0.10.0 index docs --framework none --base-url /docs -e none -o keyword.json.golden
//   npx ondocs@0.10.0 index docs --framework none --base-url /docs -e mock:512 -o mock-512.json.golden
//
// The policy they hold this version to is on the index file page, under "Compatibility".
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { INDEX_FORMAT, loadIndex, parseIndexFile, retrieve } from '../src';
import { mockEmbeddingModel, mockLanguageModel } from '../src/mock';
import { createAskHandler, createMcpHandler } from '../src/server';

const root = join(import.meta.dirname, '..');
const fixture = (name: string) =>
  readFileSync(join(root, 'test/fixtures/index-0.10', name), 'utf8');
const KEYWORD = fixture('keyword.json.golden');
const MOCK = fixture('mock-512.json.golden');

const ask = (question: string) =>
  new Request('https://acme.dev/api/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
    body: JSON.stringify({ question }),
  });

/** The cited pages and the retrieval mode of an answer. */
async function answer(response: Response) {
  const text = await response.text();
  const urls = [...text.matchAll(/"type":"source-url","sourceId":"\d+","url":"([^"]+)"/g)].map(
    (match) => match[1],
  );
  return { urls, mode: /"retrieval":"(\w+)"/.exec(text)?.[1] };
}

describe('an index written by ondocs 0.10.0', () => {
  it('has the format this version reads', () => {
    expect(parseIndexFile(KEYWORD).format).toBe(INDEX_FORMAT);
    expect(parseIndexFile(MOCK).format).toBe(INDEX_FORMAT);
  });

  it('is searched by keywords', () => {
    const index = loadIndex(KEYWORD);
    const { hits, answerable } = retrieve(index, { text: 'install the CLI with npm' });
    expect(answerable).toBe(true);
    expect(hits[0]?.chunk.url).toBe('/docs/getting-started#install');
    expect(retrieve(index, { text: 'gh-pages branch' }).hits[0]?.chunk.url).toBe(
      '/docs/deploying#github-pages',
    );
  });

  it('is answered from, by keywords and with its vectors', async () => {
    const model = mockLanguageModel({ initialDelayMs: 0, wordDelayMs: 0 });
    const keyword = createAskHandler({ index: JSON.parse(KEYWORD) as object, model });
    expect(await answer(await keyword(ask('How do I install the CLI?')))).toMatchObject({
      urls: expect.arrayContaining(['/docs/getting-started#install']) as unknown,
      mode: 'keyword',
    });

    // The mock model of this version embeds the questions as 0.10's embedded the pages.
    const hybrid = createAskHandler({
      index: MOCK,
      embeddingModel: mockEmbeddingModel({ dimensions: 512 }),
      model,
      onError: (error) => {
        throw error;
      },
    });
    expect(await answer(await hybrid(ask('How do I install the CLI?')))).toMatchObject({
      urls: expect.arrayContaining(['/docs/getting-started#install']) as unknown,
      mode: 'hybrid',
    });
  });

  it('is searched by agents', async () => {
    const mcp = createMcpHandler({ index: KEYWORD });
    const response = await mcp(
      new Request('https://acme.dev/api/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'x-forwarded-for': '203.0.113.7',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'search', arguments: { query: 'cache hashed assets' } },
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('/docs/deploying#caching');
  });

  it('still loads with fields a later version adds, which readers ignore', () => {
    const index = JSON.parse(MOCK) as {
      chunks: Record<string, unknown>[];
      [key: string]: unknown;
    };
    const added = {
      ...index,
      generator: 'ondocs@9.9.9',
      chunks: index.chunks.map((chunk) => ({ ...chunk, tokens: 12 })),
    };
    expect(loadIndex(JSON.stringify(added)).chunks.length).toBe(index.chunks.length);
  });
});

describe('the index file page', () => {
  it('states the compatibility policy these tests hold the reader to', () => {
    const page = readFileSync(join(root, 'examples/nextjs/content/docs/index-format.md'), 'utf8');
    expect(page).toContain('\n## Compatibility\n');
    expect(page).toContain(`\`${INDEX_FORMAT}\``);
    expect(page).toContain('test/fixtures/index-0.10');
  });
});
