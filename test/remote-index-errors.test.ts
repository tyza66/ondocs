// remoteIndex keeps answering from the index it has when a check of the site fails: the site is
// down, the file moved, or the new file does not load (a newer format, a half-deployed site). It
// used to say nothing, so a warm Worker could answer from old docs unnoticed. Each failed check is
// now reported, once until something changes, to remoteIndex's onError or the handlers'.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { buildIndex, serializeIndexFile } from '../src';
import { mockLanguageModel } from '../src/mock';
import { createAskHandler, createOndocs, remoteIndex } from '../src/server';
import { corpus } from './helpers';

const URL_ = 'https://acme.github.io/docs/ask-index.json';
const { index } = await buildIndex({ documents: corpus });
const GOOD = serializeIndexFile(index);
const NEWER = GOOD.replace('"ask-my-site/index@1"', '"ondocs/index@2"');
const model = mockLanguageModel({ initialDelayMs: 0, wordDelayMs: 0 });

let errors: MockInstance<typeof console.error>;
beforeEach(() => {
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** A site whose index file is `serve()`: a body with its ETag, a status, or a failed fetch. */
function site() {
  let serve: () => Response | Error = () => response(GOOD);
  return {
    fetch: (): Promise<Response> => {
      const served = serve();
      return served instanceof Error ? Promise.reject(served) : Promise.resolve(served);
    },
    set: (next: () => Response | Error) => {
      serve = next;
    },
  };
}
const response = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { etag: `"${String(body.length)}${body.slice(0, 20).replace(/\W/g, '')}"` },
  });

const ask = () =>
  new Request('https://acme.dev/api/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
    body: JSON.stringify({ question: 'How are int8 vectors stored?' }),
  });

describe('remoteIndex: onError', () => {
  it('reports each failed check once, with the URL and the cause, until it changes', async () => {
    const host = site();
    const onError = vi.fn();
    let now = 0;
    const remote = remoteIndex(URL_, {
      fetch: host.fetch,
      now: () => now,
      revalidateSeconds: 1,
      onError,
    });
    const first = await remote();
    const check = async () => {
      now += 2000;
      return remote();
    };

    // A newer format: the old index keeps answering, and the failure is reported once.
    host.set(() => response(NEWER));
    expect(await check()).toBe(first);
    expect(await check()).toBe(first);
    expect(onError).toHaveBeenCalledOnce();
    const newer = onError.mock.calls[0]?.[0] as Error;
    expect(newer.message).toContain(
      `The index at ${URL_} could not be loaded, so the endpoint keeps answering from the index it fetched before:`,
    );
    expect(newer.message).toContain('Unsupported index format "ondocs/index@2"');

    // The file moved: a new failure, reported once.
    host.set(() => response('Not found', 404));
    expect(await check()).toBe(first);
    expect(await check()).toBe(first);
    expect(onError).toHaveBeenCalledTimes(2);
    expect((onError.mock.calls[1]?.[0] as Error).message).toBe(
      `Could not fetch the index at ${URL_}: HTTP 404, so the endpoint keeps answering from the index it fetched before.`,
    );

    // The site is down.
    host.set(() => new TypeError('fetch failed'));
    expect(await check()).toBe(first);
    expect(await check()).toBe(first);
    expect(onError).toHaveBeenCalledTimes(3);
    expect((onError.mock.calls[2]?.[0] as Error).message).toContain('fetch failed');

    // The site is back: no report, and the next failure is reported again.
    host.set(() => response(GOOD.replace('"title"', '"title" ')));
    expect(await check()).not.toBe(first);
    host.set(() => response('Not found', 404));
    await check();
    expect(onError).toHaveBeenCalledTimes(4);
    expect(errors).not.toHaveBeenCalled();
  });

  it('logs to the console without an onError anywhere', async () => {
    const host = site();
    let now = 0;
    const remote = remoteIndex(URL_, { fetch: host.fetch, now: () => now, revalidateSeconds: 1 });
    await remote();
    host.set(() => response('Not found', 404));
    now += 2000;
    await remote();
    expect(errors).toHaveBeenCalledOnce();
    expect(errors.mock.calls[0]?.[0]).toBe('[ondocs]');
  });
});

describe('the handlers given a remoteIndex', () => {
  it('report its failed checks to their onError, once for both endpoints', async () => {
    const host = site();
    const onError = vi.fn();
    let now = 0;
    const remote = remoteIndex(URL_, { fetch: host.fetch, now: () => now, revalidateSeconds: 1 });
    const { ask: handler } = createOndocs({ index: remote, onError, ask: { model } });
    expect((await handler(ask())).status).toBe(200);
    host.set(() => response(NEWER));
    now += 2000;
    // Still answered, from the index it had.
    expect((await handler(ask())).status).toBe(200);
    expect(onError).toHaveBeenCalledOnce();
    expect(String(onError.mock.calls[0]?.[0])).toContain('Unsupported index format');
    expect(errors).not.toHaveBeenCalled();
  });

  it('leave them to remoteIndex’s own onError when it has one', async () => {
    const host = site();
    const own = vi.fn();
    const handlers = vi.fn();
    let now = 0;
    const remote = remoteIndex(URL_, {
      fetch: host.fetch,
      now: () => now,
      revalidateSeconds: 1,
      onError: own,
    });
    const handler = createAskHandler({ index: remote, model, onError: handlers });
    await handler(ask());
    host.set(() => response('Not found', 404));
    now += 2000;
    await handler(ask());
    expect(own).toHaveBeenCalledOnce();
    expect(handlers).not.toHaveBeenCalled();
  });
});
