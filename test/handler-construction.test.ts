// Misconfiguration that used to surface only on the first question, as a 500 'The ask endpoint is
// misconfigured.' with the cause in the log: the handlers now fail as they are made, so the build
// or the deploy fails, with what to change. And what a question still cannot know before it is
// asked: an index with vectors but no embeddingModel, and a provider that rejects the model.
import { MockLanguageModelV4 } from 'ai/test';
import { APICallError } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { version } from '../package.json' with { type: 'json' };
import { buildIndex, serializeIndexFile } from '../src';
import { mockEmbeddingModel, mockLanguageModel } from '../src/mock';
import {
  createAskHandler,
  createMcpHandler,
  createOndocs,
  type AskHandlerOptions,
} from '../src/server';
import { corpus } from './helpers';

const { index: keyword } = await buildIndex({ documents: corpus });
const { index: embedded } = await buildIndex({
  documents: corpus,
  embeddingModel: mockEmbeddingModel(),
});
const model = mockLanguageModel({ initialDelayMs: 0, wordDelayMs: 0 });

afterEach(() => {
  vi.restoreAllMocks();
});

const ask = (question = 'How are int8 vectors stored?') =>
  new Request('https://acme.dev/api/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
    body: JSON.stringify({ question }),
  });

/** Options as a JavaScript config, or a cast, gives them. */
const untyped = (options: Record<string, unknown>) => options as unknown as AskHandlerOptions;

describe('an index that is not one, at construction', () => {
  const PATH =
    "index takes the index's JSON, not a path: import index from './ask-index.json', or read it with readFileSync('./ask-index.json', 'utf8').";

  it('a path', () => {
    expect(() => createAskHandler({ index: './ask-index.json', model })).toThrow(
      `createAskHandler: ${PATH}`,
    );
    expect(() => createMcpHandler({ index: './ask-index.json' })).toThrow(
      `createMcpHandler: ${PATH}`,
    );
    expect(() =>
      createAskHandler({ index: keyword, indexes: { fr: 'fr/ask-index.json' }, model }),
    ).toThrow(
      "createAskHandler: indexes.fr takes the index's JSON, not a path: import index from './fr/ask-index.json'",
    );
    expect(() => createOndocs({ index: '/srv/ask-index.json', ask: { model } })).toThrow(
      "createAskHandler: index takes the index's JSON, not a path: import index from '/srv/ask-index.json'",
    );
  });

  it('JSON that is not an ondocs index', () => {
    const notOurs = 'createAskHandler: index is not an ondocs index: it has no format.';
    expect(() => createAskHandler({ index: { documents: [] }, model })).toThrow(notOurs);
    expect(() => createAskHandler({ index: { default: { chunks: [] } }, model })).toThrow(notOurs);
  });

  it('an index this version does not read, naming both ways out', () => {
    const newer = { ...keyword, format: 'ondocs/index@2' };
    expect(() => createAskHandler({ index: newer, model })).toThrow(
      `createAskHandler: index has format "ondocs/index@2", which ondocs ${version} does not read (it reads "ask-my-site/index@1"). If a newer ondocs built it, upgrade the endpoint's (npm i ondocs@latest); if an older one did, rebuild the index.`,
    );
    expect(() => createMcpHandler({ index: { ...keyword, chunks: 'none' } })).toThrow(
      'createMcpHandler: index is not a valid ondocs index:',
    );
  });

  it('still loads a function, its JSON text and a remote index on first use', async () => {
    const lazy = createAskHandler({ index: () => serializeIndexFile(keyword), model });
    expect((await lazy(ask())).status).toBe(200);
    const text = createAskHandler({ index: serializeIndexFile(keyword), model });
    expect((await text(ask())).status).toBe(200);
  });
});

describe('a Promise of the index', () => {
  it('is awaited, as import() and fetch(…).then(r => r.json()) give one', async () => {
    for (const index of [
      Promise.resolve(keyword),
      // import('./ask-index.json') resolves to the module, with the JSON as its default.
      Promise.resolve({ default: keyword }),
    ]) {
      const handler = createAskHandler({ index, model });
      const response = await handler(ask());
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('"type":"source-url"');
      const mcp = createMcpHandler({ index });
      const listed = await mcp(
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
            params: { name: 'list_pages', arguments: {} },
          }),
        }),
      );
      expect(listed.status).toBe(200);
    }
  });

  it('that rejects fails the request, not the process', async () => {
    const onError = vi.fn();
    const failing = Promise.reject(new Error('the import failed'));
    const handler = createAskHandler({ index: failing, model, onError });
    // Nothing awaits the Promise until the first question: no unhandled rejection meanwhile.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await handler(ask())).status).toBe(500);
    expect(String(onError.mock.calls[0]?.[0])).toContain('the import failed');
  });
});

describe('no model, at construction', () => {
  it('says what to pass', () => {
    expect(() => createAskHandler(untyped({ index: keyword }))).toThrow(
      new TypeError(
        "createAskHandler: model is missing: pass the language model that answers, such as openai('gpt-5.4-mini') from @ai-sdk/openai, or an AI Gateway id such as 'openai/gpt-5.4-mini'.",
      ),
    );
    expect(() => createOndocs(untyped({ index: keyword, ask: {} }) as never)).toThrow(
      'createAskHandler: model is missing',
    );
  });
});

describe('an index with vectors, and no embeddingModel', () => {
  it('answers on keywords, and says so once', async () => {
    const onError = vi.fn();
    const handler = createAskHandler({ index: embedded, model, onError });
    expect((await handler(ask())).status).toBe(200);
    expect((await handler(ask())).status).toBe(200);
    expect(onError).toHaveBeenCalledOnce();
    expect(String(onError.mock.calls[0]?.[0])).toBe(
      'Error: The index was embedded with "mock-hash-512", but createAskHandler has no embeddingModel, so questions are matched on keywords only. Pass embeddingModel, the model the index was built with, for semantic search.',
    );
  });

  it('is not worth a word on the MCP endpoint, which may search by keywords to cost nothing', async () => {
    const onError = vi.fn();
    const mcp = createMcpHandler({ index: embedded, onError });
    await mcp(
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
          params: { name: 'search', arguments: { query: 'int8 vectors' } },
        }),
      }),
    );
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('a provider that rejects the model or the account', () => {
  const rejecting = (error: Error) =>
    new MockLanguageModelV4({ doStream: () => Promise.reject(error) });
  const apiError = (statusCode: number, body?: unknown) =>
    new APICallError({
      message: `status ${String(statusCode)}`,
      url: 'https://api.openai.com/v1/responses',
      requestBodyValues: {},
      statusCode,
      ...(body ? { data: body, responseBody: JSON.stringify(body) } : {}),
    });

  it.each([
    ['an unknown model (404)', apiError(404)],
    [
      'an account out of quota (429 insufficient_quota)',
      apiError(429, {
        error: {
          message: 'You exceeded your current quota',
          type: 'insufficient_quota',
          code: 'insufficient_quota',
        },
      }),
    ],
  ])('says it is misconfigured, without "try again": %s', async (_, error) => {
    const onError = vi.fn();
    const handler = createAskHandler({
      index: keyword,
      model: rejecting(error),
      onError,
      generation: { maxRetries: 0 },
    });
    const text = await (await handler(ask())).text();
    expect(text).toContain('"errorText":"The ask endpoint is misconfigured."');
    expect(text).toContain('"misconfigured":true');
    expect(text).not.toContain('Please try again');
    expect(onError).toHaveBeenCalledOnce();
  });
});
