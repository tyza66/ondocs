// An index fetched over HTTP, such as the live site's /ask-index.json, and fetched again when the
// site is redeployed. Web APIs only, so it runs in a Worker beside a static site.
import { loadIndex, type LoadedIndex } from '../search/retrieve';

/** Marks a source the handlers ask for the index on every request, as it can change. */
export const LIVE_INDEX = Symbol.for('ondocs.liveIndex');

/** The longest `timeoutSeconds`: `setTimeout` waits at most 2 ** 31 - 1 ms. */
const MAX_TIMEOUT_SECONDS = 2_147_483;

export interface RemoteIndexOptions {
  /**
   * How long a fetched index is used before it is checked again, in seconds. The request that
   * finds the index due waits for the check, at most `timeoutSeconds`, and requests that arrive
   * during it are answered from the index in memory. The check is a conditional request
   * (`If-None-Match`, `If-Modified-Since`): a `304` keeps the index, and only a changed file is
   * downloaded and loaded again. Default 300.
   */
  revalidateSeconds?: number;
  /**
   * How long one fetch of the index may take, response and file, in seconds, before it is given
   * up. Raise it for a very large index on a slow link. Default 10, at most 2147483 (the longest a
   * timer can wait, about 24 days).
   */
  timeoutSeconds?: number;
  /**
   * The `fetch` to use: on Cloudflare, `env.ASSETS.fetch` reads the site's own static files
   * without leaving the Worker. Default: the global `fetch`.
   */
  fetch?: (request: Request) => Promise<Response>;
  /** Extra request headers, such as a token for a protected preview deployment. */
  headers?: Record<string, string>;
  /**
   * Called when a check of the site fails and the index in hand keeps answering: the site is
   * down, answers with an error such as a 404, or sends a file that does not load (one from a
   * newer ondocs, or half deployed). Once per failure, until the file or the status changes or a
   * check succeeds. Default: the `onError` of the handlers given this index, else `console.error`.
   * The first fetch's failure is not passed here: it fails the request, which the handler reports.
   */
  onError?: (error: unknown) => void;
  /** Clock, for tests. */
  now?: () => number;
}

/** What {@link remoteIndex} returns: pass it as `index` to `createAskHandler` or `createMcpHandler`. */
export interface RemoteIndex {
  (): Promise<LoadedIndex>;
  readonly [LIVE_INDEX]: true;
  /** The URL it fetches. */
  readonly url: string;
}

interface Fetched {
  index: LoadedIndex;
  etag: string | null;
  lastModified: string | null;
  checkedAt: number;
}

/** The most handlers' reporters one index keeps: they are made once, so more is a leak. */
const MAX_REPORTERS = 16;

/** The `onError`s of the handlers given each remote index, which hear of its failed checks. */
const reporters = new WeakMap<RemoteIndex, Set<(error: unknown) => void>>();

/**
 * Passes `source`'s failed checks to `report`, a handler's `onError`, when `source` is a
 * {@link remoteIndex} without an `onError` of its own. The same function given by two handlers,
 * as `createOndocs` gives it, hears of each failure once.
 */
export function reportRemoteIndexErrors(source: unknown, report: (error: unknown) => void): void {
  if (!isLiveIndex(source)) return;
  const set = reporters.get(source);
  if (!set) return;
  set.add(report);
  if (set.size > MAX_REPORTERS) {
    const [oldest] = set;
    if (oldest) set.delete(oldest);
  }
}

/**
 * The index at `url`, fetched on first use and kept in memory, then checked again at most every
 * `revalidateSeconds`, so an endpoint that is deployed apart from the site, such as a Cloudflare
 * Worker answering for a GitHub Pages site, follows the site's deploys:
 *
 * ```ts
 * const index = remoteIndex('https://acme.github.io/docs/ask-index.json');
 * export default { fetch: createAskHandler({ index, model }) };
 * ```
 *
 * Only the first fetch's failure fails a request; the next request tries again. The request that
 * finds the index due for a check waits for it, at most `timeoutSeconds`, and requests that arrive
 * during the check are answered from the index in hand. A check that fails (the site is down,
 * answers with an error, sends a file that does not load, or takes more than `timeoutSeconds`)
 * keeps the index it has for another `revalidateSeconds`. Both handlers given the same
 * `remoteIndex` share one copy.
 */
export function remoteIndex(url: string | URL, options: RemoteIndexOptions = {}): RemoteIndex {
  const href = String(url);
  const revalidateMs = (options.revalidateSeconds ?? 300) * 1000;
  if (!Number.isFinite(revalidateMs) || revalidateMs < 0) {
    throw new RangeError(
      `remoteIndex: revalidateSeconds must be 0 or more (got ${String(options.revalidateSeconds)}).`,
    );
  }
  const timeoutSeconds = options.timeoutSeconds ?? 10;
  // A longer delay overflows `setTimeout`, which then fires at once and fails every fetch.
  if (!(timeoutSeconds > 0 && timeoutSeconds <= MAX_TIMEOUT_SECONDS)) {
    throw new RangeError(
      `remoteIndex: timeoutSeconds must be more than 0 and at most ${String(MAX_TIMEOUT_SECONDS)}, the longest a timer can wait (got ${String(options.timeoutSeconds)}).`,
    );
  }
  const timeoutMs = timeoutSeconds * 1000;
  const now = options.now ?? Date.now;
  const fetcher = options.fetch ?? ((request: Request) => fetch(request));
  let current: Fetched | null = null;
  let pending: Promise<LoadedIndex> | null = null;
  let pendingSince = 0;
  const listeners = new Set<(error: unknown) => void>();
  // The failure last reported, so that each is reported once until something changes.
  let reported: string | null = null;

  /** Reports a failed check, once per failure, to `onError`, the handlers' or the console. */
  const report = (key: string, error: Error): void => {
    if (key === reported) return;
    reported = key;
    if (options.onError) {
      options.onError(error);
      return;
    }
    if (listeners.size === 0) {
      console.error('[ondocs]', error);
      return;
    }
    for (const listener of listeners) listener(error);
  };
  const KEEPS = 'so the endpoint keeps answering from the index it fetched before';

  const download = async (
    signal: AbortSignal,
    inTime: <T>(step: Promise<T>) => Promise<T>,
  ): Promise<LoadedIndex> => {
    const headers = new Headers(options.headers);
    headers.set('accept', 'application/json');
    if (current?.etag) headers.set('if-none-match', current.etag);
    else if (current?.lastModified) headers.set('if-modified-since', current.lastModified);
    let response: Response;
    try {
      response = await inTime(fetcher(new Request(href, { headers, signal })));
    } catch (error) {
      return failed(error);
    }
    if (response.status === 304 && current) {
      await response.body?.cancel();
      reported = null;
      return keep(current);
    }
    if (!response.ok) {
      await response.body?.cancel();
      const status = `Could not fetch the index at ${href}: HTTP ${String(response.status)}`;
      if (!current) throw new Error(`${status}.`);
      report(`status ${String(response.status)}`, new Error(`${status}, ${KEEPS}.`));
      return keep(current);
    }
    let text: string;
    try {
      text = await inTime(response.text());
    } catch (error) {
      // The connection dropped, or stalled, part-way through the file.
      return failed(error);
    }
    let index: LoadedIndex;
    try {
      index = loadIndex(text);
    } catch (error) {
      // A half-deployed site, or an index from a newer ondocs: keep answering from the index
      // that worked, and say why, once for this file.
      if (!current) throw error;
      const file =
        response.headers.get('etag') ?? response.headers.get('last-modified') ?? String(error);
      report(
        `file ${file}`,
        new Error(
          `The index at ${href} could not be loaded, ${KEEPS}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        ),
      );
      return keep(current);
    }
    reported = null;
    current = {
      index,
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
      checkedAt: now(),
    };
    return index;
  };

  /**
   * {@link download}, given up after `timeoutSeconds`: a site that hangs, or stops part-way
   * through the file, also when `fetch` ignores the signal.
   */
  const downloadInTime = async (): Promise<LoadedIndex> => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new DOMException(
          `The index took more than ${String(timeoutSeconds)} s to download. Raise timeoutSeconds for a large index on a slow link.`,
          'TimeoutError',
        );
        abort.abort(error);
        reject(error);
      }, timeoutMs);
    });
    try {
      return await download(abort.signal, (step) => Promise.race([step, timedOut]));
    } finally {
      clearTimeout(timer);
    }
  };

  /** Keeps the index in hand for another `revalidateSeconds`. */
  const keep = (fetched: Fetched): LoadedIndex => {
    fetched.checkedAt = now();
    return fetched.index;
  };

  /** A fetch that failed: a check keeps the index in hand, and the first fetch fails. */
  const failed = (error: unknown): LoadedIndex => {
    const message = `Could not fetch the index at ${href}: ${String(error)}`;
    if (!current) throw new Error(message, { cause: error });
    report(`fetch ${String(error)}`, new Error(`${message}, ${KEEPS}.`, { cause: error }));
    return keep(current);
  };

  /**
   * Downloads the index, or joins the download under way. One that has not settled in twice
   * `timeoutSeconds` is left behind for a new one: on a Worker, a fetch and its timer end with
   * the request that started them, which is cancelled if its client goes away.
   */
  const refresh = (): Promise<LoadedIndex> => {
    if (pending && now() - pendingSince < 2 * timeoutMs) return pending;
    const started = downloadInTime().finally(() => {
      if (pending === started) pending = null;
    });
    pending = started;
    pendingSince = now();
    return started;
  };

  const get = (): Promise<LoadedIndex> => {
    if (!current) return refresh();
    const held = current;
    if (now() - held.checkedAt < revalidateMs) return Promise.resolve(held.index);
    // A check under way does not hold up anyone else: they are answered from the index in hand.
    if (pending && now() - pendingSince < 2 * timeoutMs) return Promise.resolve(held.index);
    // The request that finds the index due waits for the check rather than leave it running after
    // the answer: a Worker cancels what a request started once it has answered, and a serverless
    // function can be frozen. The wait is at most timeoutSeconds, and a failed check keeps the
    // index in hand.
    return refresh().catch(() => held.index);
  };

  const remote: RemoteIndex = Object.assign(get, { [LIVE_INDEX]: true as const, url: href });
  reporters.set(remote, listeners);
  return remote;
}

/** Whether `source` is a {@link remoteIndex}, which the handlers call on every request. */
export function isLiveIndex(source: unknown): source is RemoteIndex {
  return typeof source === 'function' && LIVE_INDEX in source;
}
