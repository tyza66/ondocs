// @vitest-environment jsdom
// The Troubleshooting page (examples/nextjs/content/docs/troubleshooting.md) is named after the
// messages a new site shows. Each test here gets a message the way a site does, from the dialog,
// the endpoint, the build or the CLI, and checks that the page quotes it as it is, so a reworded
// message fails here rather than leaving the page out of date.
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createOpenAI } from '@ai-sdk/openai';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildIndex, parseFrontmatter } from '../src';
import { main } from '../src/cli/main';
import { buildEmbedding } from '../src/integration/build';
import { mockEmbeddingModel } from '../src/mock';
import { useAsk } from '../src/react';
import { errorText } from '../src/react/dialog-panel';
import { resolveLabels } from '../src/react/labels';
import { createAskHandler, type AskHandlerOptions } from '../src/server';
import { BUDGET_EXCEEDED_MESSAGE } from '../src/server/budget';
import { corpus } from './helpers';

const root = join(import.meta.dirname, '..');
const doc = (slug: string) =>
  readFileSync(join(root, 'examples/nextjs/content/docs', `${slug}.md`), 'utf8');
const page = () => doc('troubleshooting');

afterEach(() => {
  vi.unstubAllEnvs();
});

/** OpenAI as the endpoints `init` writes use it, with no key set: it never reaches the network. */
function openaiWithoutKey() {
  vi.stubEnv('OPENAI_API_KEY', undefined);
  return createOpenAI({ fetch: () => Promise.reject(new Error('no network in this test')) });
}

/** A handler as `init` writes it, over `index`, with its errors collected. */
function initEndpoint(index: AskHandlerOptions['index']) {
  const openai = openaiWithoutKey();
  const onError = vi.fn();
  const handler = createAskHandler({
    index,
    model: openai('gpt-5.4-mini'),
    embeddingModel: openai.embedding('text-embedding-3-small'),
    onError,
  });
  const ask = (question: string) =>
    handler(
      new Request('http://localhost/api/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
        body: JSON.stringify({ question }),
      }),
    );
  const logged = (): Error[] => onError.mock.calls.map(([error]) => error as Error);
  return { ask, logged };
}

type Part = Record<string, unknown> & { type: string };

async function parts(response: Response): Promise<Part[]> {
  return (await response.text())
    .split('\n\n')
    .map((event) => event.replace(/^data: /, '').trim())
    .filter((event) => event && event !== '[DONE]')
    .map((event) => JSON.parse(event) as Part);
}

/** What the dialog shows for a response from its endpoint, and what it warns in the console. */
async function dialogShows(response: () => Promise<Response>) {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const { result } = renderHook(() => useAsk({ fetch: response }));
    await act(() => result.current.ask('How do I install it?'));
    return {
      text: errorText(result.current.error, resolveLabels(undefined)),
      warnings: warn.mock.calls.map(([message]) => String(message)),
    };
  } finally {
    warn.mockRestore();
  }
}

const html = (status: number) => () =>
  Promise.resolve(
    new Response('<h1>No</h1>', { status, headers: { 'content-type': 'text/html' } }),
  );

const { index: keywordOnly } = await buildIndex({ documents: corpus, embeddingModel: null });

describe('the Troubleshooting page', () => {
  it('is in Get started, and Getting started and Deploying link to it', () => {
    expect(parseFrontmatter(page()).data.section).toBe('Get started');
    expect(doc('getting-started')).toContain('](/docs/troubleshooting)');
    expect(doc('deployment')).toContain('](/docs/troubleshooting#');
  });

  it('quotes what the dialog shows, and the console says, when no endpoint answers', async () => {
    const missing = await dialogShows(html(404));
    expect(missing.text).toBe('Answers aren’t available here right now.');
    expect(page()).toContain(`\`${missing.text}\``);
    // The console names the URL it posted to (jsdom's page is http://localhost:3000/).
    const warning = missing.warnings.find((line) => line.includes('returned 404'));
    expect(warning).toMatch(/^\[ondocs\] POST http:\/\/localhost:3000\/api\/ask returned 404: /);
    expect(page()).toContain(warning?.slice(0, warning.indexOf('there.') + 'there.'.length));

    const refused = await dialogShows(html(405));
    expect(page()).toContain(`\`${refused.text}\``);
  });

  it('quotes the dialog’s message for an endpoint without its model key, and the logged cause', async () => {
    // A plugin build without a key writes a keyword-only index; the function init writes then
    // finds the sources and fails at the model.
    const { ask, logged } = initEndpoint(keywordOnly);
    const response = await ask('How do I install with pnpm?');
    expect(response.status).toBe(200);
    const stream = await parts(response);
    const types = stream.map((part) => part.type);
    expect(types).toContain('source-url');
    expect(types.indexOf('source-url')).toBeLessThan(types.indexOf('error'));
    const error = stream.find((part) => part.type === 'error');
    expect(page()).toContain(`\`${String(error?.errorText)}\``);
    expect(logged().some((cause) => cause.name === 'AI_LoadAPIKeyError')).toBe(true);
    expect(logged().some((cause) => cause.message.includes('OpenAI API key is missing'))).toBe(
      true,
    );
    expect(page()).toContain('`AI_LoadAPIKeyError`: `OpenAI API key is missing`');

    // A question the docs don't cover is refused before the model, so it works without a key.
    const offTopic = await parts(await ask('What is the capital of France?'));
    const refusal = offTopic
      .filter((part) => part.type === 'text-delta')
      .map((part) => String(part.delta))
      .join('');
    expect(refusal).toMatch(/^I don't know\. /);
    expect(page()).toContain(`\`${refusal}\``);
  });

  it('quotes the 500 and the logged causes of a misconfigured endpoint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ondocs-troubleshooting-'));
    try {
      const { index: mockIndex } = await buildIndex({
        documents: corpus,
        embeddingModel: mockEmbeddingModel(),
      });
      const cases = [
        // Built with `embedding: 'mock'`, deployed with the function init writes.
        { index: mockIndex, quoted: (message: string) => message },
        // The index left out of the function's bundle.
        {
          index: () => readFile(join(dir, 'build/ask-index.json'), 'utf8'),
          quoted: () => 'ENOENT: no such file or directory',
        },
        // A path where the index goes, from a function: given as it is, it fails as the handler
        // is made.
        { index: () => './ask-index.json', quoted: () => 'Index is not valid JSON' },
      ];
      for (const { index, quoted } of cases) {
        const { ask, logged } = initEndpoint(index);
        const response = await ask('How do I install with pnpm?');
        expect(response.status).toBe(500);
        const body = (await response.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe('internal_error');
        expect(page()).toContain(`\`${body.error.message}\``);
        const [cause] = logged();
        expect(cause?.message).toContain(quoted(cause?.message ?? ''));
        expect(page()).toContain(`\`${quoted(cause?.message ?? '')}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('quotes the rate limit’s and the daily budget’s messages', async () => {
    const handler = createAskHandler({
      index: keywordOnly,
      model: openaiWithoutKey()('gpt-5.4-mini'),
      rateLimit: () => ({ success: false }),
    });
    const limited = await dialogShows(() =>
      handler(
        new Request('http://localhost/api/ask', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ question: 'How do I install with pnpm?' }),
        }),
      ),
    );
    expect(page()).toContain(`\`${limited.text}\``);
    expect(page()).toContain(`\`${BUDGET_EXCEEDED_MESSAGE}\``);
  });

  it('quotes what the dialog shows when the request fails in the browser, as CORS does', async () => {
    const blocked = await dialogShows(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(page()).toContain(`\`${blocked.text}\``);
  });

  it('quotes the plugins’ keyword-only warning, which `embedding: none` leaves out', async () => {
    vi.stubEnv('OPENAI_API_KEY', undefined);
    vi.stubEnv('AI_GATEWAY_API_KEY', undefined);
    const warn = vi.fn();
    expect(await buildEmbedding({}, { info: vi.fn(), warn })).toEqual({ model: null });
    const [[warning]] = warn.mock.calls as [[string]];
    expect(page()).toContain(`\n${warning}\n`);

    const quiet = vi.fn();
    expect(await buildEmbedding({ embedding: 'none' }, { info: vi.fn(), warn: quiet })).toEqual({
      model: null,
    });
    expect(quiet).not.toHaveBeenCalled();
  });

  it('quotes the CLI’s error for an index built without a key', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ondocs-troubleshooting-'));
    try {
      await mkdir(join(cwd, 'docs'));
      await writeFile(join(cwd, 'docs/index.md'), '# Home\n\nWelcome.\n');
      const stderr: string[] = [];
      const code = await main(['index', 'docs'], {
        cwd,
        env: {},
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
      });
      expect(code).toBe(2);
      const first = /No embedding model\.[^.]*\./.exec(stderr.join('\n'))?.[0];
      expect(first).toBe('No embedding model. Set OPENAI_API_KEY or pass --embedding <spec>.');
      expect(page()).toContain(`\`${String(first)}\``);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('exempts every package released with ondocs from the release-age gates', () => {
    const config = JSON.parse(readFileSync(join(root, '.changeset/config.json'), 'utf8')) as {
      fixed: string[][];
    };
    const released = config.fixed.find((group) => group.includes('ondocs'));
    expect(released).toBeDefined();
    for (const setting of ['minimumReleaseAgeExclude', 'npmPreapprovedPackages']) {
      const list = new RegExp(`^${setting}:\\n((?:  - .+\\n)+)`, 'm').exec(page())?.[1];
      const names = list?.match(/(?<=- ).+/g) ?? [];
      expect([setting, names.sort()]).toEqual([setting, [...(released ?? [])].sort()]);
    }
  });
});
