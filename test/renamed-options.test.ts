// The options renamed before 1.0 so that one name means one thing: the selectors, `init --out`
// and `rateLimitFailure`; and the CLI's config module, which takes `embedding` and `dimensions`
// as the plugins do. Each old name still works, does what its new name does, and says once what
// it is called now.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { AstroIntegration } from 'astro';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { version } from '../package.json' with { type: 'json' };
import { buildIndex } from '../src';
import astroOndocs from '../src/astro';
import { main } from '../src/cli/main';
import { REMOVED_IN, resetDeprecationWarnings } from '../src/deprecation';
import { parseIndexFile } from '../src/index-file';
import { loadBuiltPage } from '../src/integration';
import { mockEmbeddingModel, mockLanguageModel } from '../src/mock';
import { createAskHandler, createMcpHandler, type RateLimiter } from '../src/server';
import { withOndocs, type VitePressSiteConfig } from '../src/vitepress';
import { corpus } from './helpers';

const { index } = await buildIndex({ documents: corpus });

let root: string;
let warn: MockInstance<typeof console.warn>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ondocs-renamed-'));
  resetDeprecationWarnings();
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('AI_GATEWAY_API_KEY', '');
  vi.stubEnv('ASK_ENDPOINT', '');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

/** The warning an old name gives. */
const warning = (old: string, current: string): string =>
  `[ondocs] ${old} is now ${current}. The old name still works until ${REMOVED_IN}.`;

const PAGE = `<html><head><title>Setup | Acme</title></head><body>
<nav>Site nav</nav>
<main><div class="toc">On this page</div><div class="prose"><h1>Setup</h1><p>Install it.</p></div><p>Not prose.</p></main>
</body></html>`;

describe('loadBuiltPage: contentSelector and ignoreSelector', () => {
  it('reads what contentSelector selects, without what ignoreSelector does', () => {
    const page = loadBuiltPage(PAGE, {
      url: '/setup',
      contentSelector: 'main',
      ignoreSelector: '.toc',
    });
    expect(page?.document.content).toContain('Not prose.');
    expect(page?.document.content).not.toContain('On this page');
    expect(
      loadBuiltPage(PAGE, { url: '/setup', contentSelector: '.prose' })?.document.content,
    ).not.toContain('Not prose.');
    expect(warn).not.toHaveBeenCalled();
  });

  it('still takes root and ignore, with a warning', () => {
    const current = loadBuiltPage(PAGE, {
      url: '/setup',
      contentSelector: '.prose',
      ignoreSelector: 'h1',
    });
    const old = loadBuiltPage(PAGE, { url: '/setup', root: '.prose', ignore: 'h1' });
    expect(old).toEqual(current);
    expect(warn.mock.calls).toEqual([
      [warning("loadBuiltPage's root", 'contentSelector')],
      [warning("loadBuiltPage's ignore", 'ignoreSelector')],
    ]);
  });
});

/** Builds `pages` with the Astro integration and returns the index's chunks' text. */
async function astroBuild(integration: AstroIntegration): Promise<string> {
  const outDir = join(root, 'dist');
  await mkdir(join(outDir, 'setup'), { recursive: true });
  await writeFile(join(outDir, 'setup', 'index.html'), PAGE);
  const logger = { info: vi.fn(), warn: vi.fn() };
  const hooks = integration.hooks as Record<string, (options: unknown) => unknown>;
  await hooks['astro:config:setup']?.({
    config: {},
    injectScript: vi.fn(),
    injectRoute: vi.fn(),
    updateConfig: vi.fn(),
    logger,
  });
  await hooks['astro:config:done']?.({
    config: {
      root: pathToFileURL(`${root}/`),
      integrations: [{ name: 'ondocs' }],
      base: '/',
      trailingSlash: 'ignore',
      build: { format: 'directory' },
    },
    logger,
  });
  await hooks['astro:build:done']?.({
    dir: pathToFileURL(`${outDir}/`),
    pages: [{ pathname: 'setup/' }],
    assets: new Map(),
    logger,
  });
  const index = parseIndexFile(await readFile(join(outDir, 'ask-index.json'), 'utf8'));
  return index.chunks.map((chunk) => chunk.text).join('\n');
}

describe('ondocs/astro: contentSelector and ignoreSelector', () => {
  it('indexes what they select', async () => {
    const text = await astroBuild(
      astroOndocs({
        embeddingModel: mockEmbeddingModel(),
        contentSelector: 'main',
        ignoreSelector: '.toc',
      }),
    );
    expect(text).toContain('Not prose.');
    expect(text).not.toContain('On this page');
    expect(warn).not.toHaveBeenCalled();
  });

  it('still takes content and ignore, with a warning, and the new names win', async () => {
    const old = await astroBuild(
      astroOndocs({ embeddingModel: mockEmbeddingModel(), content: '.prose', ignore: 'h1' }),
    );
    expect(old).toBe('Install it.');
    expect(warn.mock.calls).toEqual([
      [warning('content', 'contentSelector')],
      [warning('ignore', 'ignoreSelector')],
    ]);
    const both = await astroBuild(
      astroOndocs({
        embeddingModel: mockEmbeddingModel(),
        contentSelector: 'main',
        content: '.prose',
      }),
    );
    expect(both).toContain('Not prose.');
  });
});

/** Builds one page with the VitePress plugin and returns the index's chunks' text. */
async function vitepressBuild(options: Parameters<typeof withOndocs>[1]): Promise<string> {
  const outDir = join(root, '.vitepress', 'dist');
  await mkdir(outDir, { recursive: true });
  await writeFile(
    join(outDir, 'setup.html'),
    PAGE.replace('<main>', '<main><div class="vp-doc">').replace('</main>', '</div></main>'),
  );
  const config = withOndocs(
    { title: 'Acme' } as { title: string; buildEnd?: (site: VitePressSiteConfig) => unknown },
    { embeddingModel: mockEmbeddingModel(), ...options },
  );
  const site: VitePressSiteConfig = {
    root,
    outDir,
    pages: ['setup.md'],
    rewrites: { map: {} },
    site: { base: '/', title: 'Acme', description: '', locales: {} },
  };
  await (config.buildEnd as (site: VitePressSiteConfig) => Promise<void>)(site);
  const index = parseIndexFile(await readFile(join(outDir, 'ask-index.json'), 'utf8'));
  return index.chunks.map((chunk) => chunk.text).join('\n');
}

describe('ondocs/vitepress: contentSelector and ignoreSelector', () => {
  it('indexes what they select', async () => {
    const text = await vitepressBuild({ contentSelector: '.prose', ignoreSelector: 'h1' });
    expect(text).toBe('Install it.');
    expect(warn).not.toHaveBeenCalled();
  });

  it('still takes content and ignore, with a warning', async () => {
    const text = await vitepressBuild({ content: '.prose', ignore: 'h1' });
    expect(text).toBe('Install it.');
    expect(warn.mock.calls).toEqual([
      [warning('content', 'contentSelector')],
      [warning('ignore', 'ignoreSelector')],
    ]);
  });
});

describe('failureMode, which was rateLimitFailure', () => {
  const failing: RateLimiter = () => Promise.reject(new Error('Redis is down'));
  const ask = (request: string) =>
    new Request('https://acme.dev/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: request,
    });

  it('lets questions through when the limiter fails, with "open"', async () => {
    const open = createAskHandler({
      index,
      model: mockLanguageModel(),
      rateLimit: failing,
      failureMode: 'open',
      onError: () => undefined,
    });
    expect((await open(ask(JSON.stringify({ question: 'How do I deploy?' })))).status).toBe(200);
    const closed = createAskHandler({
      index,
      model: mockLanguageModel(),
      rateLimit: failing,
      onError: () => undefined,
    });
    expect((await closed(ask(JSON.stringify({ question: 'How do I deploy?' })))).status).toBe(503);
    expect(warn).not.toHaveBeenCalled();
  });

  it('still takes rateLimitFailure, with a warning, on both endpoints', async () => {
    const handler = createAskHandler({
      index,
      model: mockLanguageModel(),
      rateLimit: failing,
      rateLimitFailure: 'open',
      onError: () => undefined,
    });
    expect((await handler(ask(JSON.stringify({ question: 'How do I deploy?' })))).status).toBe(200);
    const mcp = createMcpHandler({
      index,
      rateLimit: failing,
      rateLimitFailure: 'open',
      onError: () => undefined,
    });
    const listed = await mcp(
      new Request('https://acme.dev/api/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
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
    expect(warn.mock.calls).toEqual([[warning('rateLimitFailure', 'failureMode')]]);
  });
});

/** Runs the CLI in `root`. */
async function cli(...args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(args, {
    cwd: root,
    env: {},
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

async function files(contents: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(contents)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
}

describe('ondocs init --build-dir, which was --out', () => {
  const HTML = {
    'package.json': '{"name":"acme"}',
    '_site/index.html': '<title>Acme</title><main>Hi</main>',
  };

  it('names the build folder of a plain HTML site', async () => {
    await files(HTML);
    const result = await cli('init', '--build-dir', '_site', '--host', 'vercel', '--dry-run');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('npx ondocs index _site -o _site/ask-index.json');
    expect(result.stderr).toBe('');
    const help = await cli('init', '--help');
    expect(help.stdout).toMatch(/--build-dir <dir> +A static site's build output folder/);
    // Listed as the old name, for a guide written for an earlier version.
    expect(help.stdout).toMatch(
      /--out <dir> +--build-dir's name before 0\.14, which works until 1\.0/,
    );
  });

  it('says to pass --build-dir', async () => {
    await files({ 'package.json': '{"name":"acme"}' });
    expect((await cli('init')).stderr).toContain(
      'For plain HTML, pass the folder of its HTML files with --build-dir <dir>, as in npx ondocs init --build-dir public.',
    );
    await files(HTML);
    expect((await cli('init')).stderr).toContain(
      '_site/ has HTML files: if it is the folder the site deploys, run npx ondocs init --build-dir _site.',
    );
  });

  it('still takes --out, with a warning', async () => {
    await files(HTML);
    const result = await cli('init', '--out', '_site', '--host', 'vercel', '--dry-run');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('npx ondocs index _site -o _site/ask-index.json');
    expect(result.stderr).toBe(
      `! --out is now --build-dir. The old name still works until ${REMOVED_IN}.`,
    );
  });
});

describe('the CLI config module: embedding and dimensions, as the plugins take them', () => {
  const DOCS = { 'content/setup.md': '# Setup\n\nInstall it with npm.\n' };
  const built = async () => parseIndexFile(await readFile(join(root, 'ask-index.json'), 'utf8'));

  it('builds with embedding, at dimensions', async () => {
    await files({
      ...DOCS,
      'ask.config.mjs': "export default { embedding: 'mock', dimensions: 64 };",
    });
    const result = await cli('index', 'content', '-c', 'ask.config.mjs');
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect((await built()).embedding).toMatchObject({ dimensions: 64 });

    // Another file: Node keeps the module it imported first.
    await files({ 'none.config.mjs': "export default { embedding: 'none' };" });
    expect((await cli('index', 'content', '-c', 'none.config.mjs')).code).toBe(0);
    expect((await built()).embedding).toBeNull();
  });

  it('lets the flags win', async () => {
    await files({
      ...DOCS,
      'ask.config.mjs': "export default { embedding: 'mock', dimensions: 64 };",
    });
    expect((await cli('index', 'content', '-c', 'ask.config.mjs', '--dimensions', '32')).code).toBe(
      0,
    );
    expect((await built()).embedding).toMatchObject({ dimensions: 32 });
    expect((await cli('index', 'content', '-c', 'ask.config.mjs', '-e', 'none')).code).toBe(0);
    expect((await built()).embedding).toBeNull();
  });

  it('refuses what contradicts itself, as the plugins do', async () => {
    await files({
      ...DOCS,
      'ask.config.mjs': "export default { embedding: 'mock', embeddingModel: null };",
    });
    const both = await cli('index', 'content', '-c', 'ask.config.mjs');
    expect(both.code).toBe(2);
    expect(both.stderr).toContain('pass `embedding` or `embeddingModel`, not both.');
    await files({ 'dims.config.mjs': 'export default { embeddingModel: null, dimensions: 64 };' });
    const dims = await cli('index', 'content', '-c', 'dims.config.mjs');
    expect(dims.code).toBe(2);
    expect(dims.stderr).toContain('`dimensions` applies to `embedding` or the default model');
  });

  it('fails on a misspelled option', async () => {
    await files({ ...DOCS, 'ask.config.mjs': "export default { embeding: 'mock' };" });
    const result = await cli('index', 'content', '-c', 'ask.config.mjs');
    expect(result.code).toBe(2);
    expect(result.stderr).toBe(
      `ask.config.mjs (ondocs ${version}): embeding is not an option. Did you mean embedding?`,
    );
  });
});
