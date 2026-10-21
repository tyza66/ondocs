// @vitest-environment jsdom
// ondocs/integration: the build helpers the framework plugins share, public so an integration with
// another framework needs nothing else. The plugins themselves are held to it: their build code
// imports ondocs only through it.
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as integration from '../src/integration';
import {
  buildEmbedding,
  indexCache,
  launcherScript,
  llmsOutputs,
  loadBuiltPage,
  readBuiltHtml,
  writeLlmsFiles,
  writeSiteIndex,
  type LlmsPage,
  type Logger,
  type SourceDocument,
} from '../src/integration';
import { parseIndexFile } from '../src/index-file';

const root = join(import.meta.dirname, '..');
const src = join(root, 'src');

/**
 * Each integration's build code, the part that runs in Node.js as the site builds, and the
 * modules besides `ondocs/integration` it may import: its own folder's, and for a plugin built on
 * another integration (Starlight on Astro's), that integration.
 */
const INTEGRATIONS = [
  { name: 'Docusaurus', files: ['docusaurus/index.ts'], own: ['docusaurus'] },
  { name: 'Astro', files: ['astro/index.ts', 'astro/integration.ts'], own: ['astro'] },
  { name: 'Starlight', files: ['starlight/index.ts'], own: ['starlight', 'astro/integration.ts'] },
  { name: 'VitePress', files: ['vitepress/index.ts'], own: ['vitepress'] },
];

/** Every module specifier a file imports or re-exports, statically or dynamically. */
function specifiers(source: string): string[] {
  const found = [
    ...source.matchAll(/^\s*(?:import|export)\s(?:[^'"`;]*?\sfrom\s*)?['"]([^'"]+)['"]/gm),
    ...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
  ];
  return found.map((match) => match[1] ?? '');
}

/** The source file a relative specifier from `file` names. */
function resolveSource(file: string, specifier: string): string {
  const base = resolve(dirname(file), specifier);
  const candidate = [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find((path) =>
    existsSync(path),
  );
  return relative(src, candidate ?? base)
    .split('\\')
    .join('/');
}

describe('the framework integrations', () => {
  it.each(INTEGRATIONS)('$name builds with ondocs/integration only', ({ files, own }) => {
    for (const file of files) {
      const path = join(src, file);
      const internal = specifiers(readFileSync(path, 'utf8'))
        .filter((specifier) => specifier.startsWith('.'))
        .map((specifier) => [specifier, resolveSource(path, specifier)] as const)
        .filter(
          ([, target]) =>
            target !== 'integration/index.ts' &&
            !own.some((allowed) => target === allowed || target.startsWith(`${allowed}/`)),
        );
      expect([file, internal]).toEqual([file, []]);
      // ondocs's own entries are imported as the source they are built from, not by name.
      expect(specifiers(readFileSync(path, 'utf8')).filter((s) => /^ondocs(\/|$)/.test(s))).toEqual(
        [],
      );
    }
  });
});

describe('ondocs/integration', () => {
  it('is an entry of the package, built and typed', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    };
    expect(manifest.exports['./integration']).toEqual({
      types: './dist/integration.d.ts',
      default: './dist/integration.js',
    });
    expect(readFileSync(join(root, 'tsdown.config.ts'), 'utf8')).toContain(
      "integration: 'src/integration/index.ts'",
    );
  });

  it('exports what an integration needs, and nothing else', () => {
    // A deliberate list: adding to it is adding public API.
    expect(Object.keys(integration).sort()).toEqual([
      'LAUNCHER_STYLESHEETS',
      'buildEmbedding',
      'checkIndexOptions',
      'checkOptions',
      'consoleLogger',
      'dialogEndpoint',
      'excluder',
      'hintDevEndpoint',
      'indexCache',
      'launcherScript',
      'llmsOutputs',
      'loadBuiltPage',
      'optionRules',
      'quietUseClient',
      'readBuiltHtml',
      'resolveMcp',
      'warnMissingDialogPeers',
      'writeLlmsFiles',
      'writeSiteIndex',
    ]);
  });

  it('is documented in the package API and in its own guide', () => {
    const docs = join(root, 'examples/nextjs/content/docs');
    expect(readFileSync(join(docs, 'api.md'), 'utf8')).toContain('`ondocs/integration`');
    const guide = readFileSync(join(docs, 'writing-an-integration.md'), 'utf8');
    for (const name of Object.keys(integration)) expect(guide).toContain(`\`${name}`);
  });
});

describe('readBuiltHtml', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ondocs-integration-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const put = async (file: string, html: string) => {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await writeFile(join(dir, file), html);
  };

  it('reads a page from either layout, trying the framework’s first', async () => {
    await put('index.html', 'root');
    await put('guide/index.html', 'guide as a folder');
    await put('guide.html', 'guide as a file');
    await put('only-file.html', 'only a file');
    expect(await readBuiltHtml(dir, '')).toBe('root');
    expect(await readBuiltHtml(dir, '/')).toBe('root');
    expect(await readBuiltHtml(dir, '/guide/')).toBe('guide as a folder');
    expect(await readBuiltHtml(dir, 'guide', 'file')).toBe('guide as a file');
    expect(await readBuiltHtml(dir, '/only-file')).toBe('only a file');
    expect(await readBuiltHtml(dir, 'missing')).toBeUndefined();
  });
});

describe('loadBuiltPage', () => {
  const page = (body: string, title = 'Setup | Acme Docs') =>
    `<!doctype html><html><head><title>${title}</title><meta name="description" content="Set it up."></head><body><nav><a href="/">Home</a></nav><main>${body}</main><footer>© Acme</footer></body></html>`;

  it('reads the page’s content to index, at its URL', () => {
    const built = loadBuiltPage(page('<h1>Setup</h1><p>Install it.</p>'), { url: '/docs/setup' });
    expect(built).toEqual({
      document: {
        id: '/docs/setup',
        url: '/docs/setup',
        title: 'Setup',
        description: 'Set it up.',
        content: '# Setup\n\nInstall it.',
        anchors: 'explicit',
      },
    });
  });

  it('takes the site’s suffix off a title read from <title>', () => {
    const built = loadBuiltPage(page('<p>Install it.</p>'), {
      url: '/setup',
      titleSuffix: ' | Acme Docs',
    });
    expect(built?.document.title).toBe('Setup');
    // A title that is all suffix stays as it is.
    expect(
      loadBuiltPage(page('<p>Hi.</p>', ' | Acme Docs'), { url: '/', titleSuffix: ' | Acme Docs' })
        ?.document.title,
    ).toBe('| Acme Docs');
  });

  it('reads the region `root` selects without what `ignore` selects, and the Markdown copy', () => {
    const html = page(
      '<div class="toc">On this page</div><div class="doc"><h2 id="install">Install <a class="anchor" href="#install">#</a></h2><p>Run <a href="/cli">the CLI</a>.</p></div>',
    );
    const built = loadBuiltPage(html, {
      url: '/setup',
      id: 'setup.md',
      root: '.doc',
      ignore: '.anchor',
      markdown: true,
    });
    expect(built?.document).toMatchObject({
      id: 'setup.md',
      content: '## Install {#install}\n\nRun the CLI.',
    });
    expect(built?.page).toEqual({
      url: '/setup',
      title: 'Setup | Acme Docs',
      description: 'Set it up.',
      content: '## Install\n\nRun [the CLI](/cli).',
    });
  });

  it('skips a page with no content, or marked noindex', () => {
    expect(loadBuiltPage(page('<p>Hi.</p>'), { url: '/', root: '.doc' })).toBeNull();
    expect(loadBuiltPage(page('  '), { url: '/' })).toBeNull();
    expect(
      loadBuiltPage(page('<p>Hi.</p>', 'Hi</title><meta name="robots" content="noindex"><title>'), {
        url: '/',
      }),
    ).toBeNull();
  });
});

describe('launcherScript', () => {
  it('mounts the launcher with the dialog’s options', () => {
    expect(
      launcherScript({
        endpoint: '/api/ask',
        dialog: { suggestions: ['Why?'] },
        title: 'Ask Acme',
      }),
    ).toBe(
      [
        "import { mountAskDialog } from 'ondocs/embed/standalone';",
        'mountAskDialog({"endpoint":"/api/ask","suggestions":["Why?"],"title":"Ask Acme"});',
      ].join('\n'),
    );
  });

  it('leaves the floating button off for a navbar button, unless launcher asks for it', () => {
    const mount = (dialog: Parameters<typeof launcherScript>[0]['dialog']) =>
      launcherScript({ endpoint: '/api/ask', dialog }).split('\n')[1];
    expect(mount({ navbar: true })).toBe(
      'mountAskDialog({"endpoint":"/api/ask","launcher":false});',
    );
    expect(mount({ navbar: 'Ask the docs', launcher: 'Ask' })).toBe(
      'mountAskDialog({"endpoint":"/api/ask","launcher":"Ask"});',
    );
    expect(mount({ navbar: false })).toBe('mountAskDialog({"endpoint":"/api/ask"});');
  });

  it('picks each locale’s options from the page’s path under base', () => {
    const script = launcherScript({
      endpoint: '/api/ask',
      dialog: {
        labels: { launcher: 'Ask' },
        locales: { fr: { labels: { launcher: 'Demander' } } },
      },
      title: 'Ask Acme',
      locales: ['fr'],
      localeTitles: { fr: 'Demander à Acme' },
      base: '/docs/',
    });
    const mounted: unknown[] = [];
    const run = (pathname: string) => {
      const body = script.replace(/^import .*\n/, '');
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const page = new Function('mountAskDialog', 'location', body) as (
        mount: (options: unknown) => void,
        location: { pathname: string },
      ) => void;
      page((options) => mounted.push(options), { pathname });
      return mounted.at(-1);
    };
    expect(run('/docs/guide/')).toEqual({
      endpoint: '/api/ask',
      labels: { launcher: 'Ask' },
      title: 'Ask Acme',
    });
    expect(run('/docs/fr/guide/')).toEqual({
      endpoint: '/api/ask',
      labels: { launcher: 'Demander' },
      title: 'Demander à Acme',
      locale: 'fr',
    });
  });
});

describe('launcherScript, for a site that moves between pages without loading them', () => {
  it('mounts again, in the new locale, when a navigation changes <html lang>', async () => {
    document.documentElement.lang = 'en';
    const script = launcherScript({
      endpoint: '/api/ask',
      title: 'Ask Acme',
      locales: ['fr'],
      localeTitles: { fr: 'Demander à Acme' },
      spa: true,
    });
    const location = { pathname: '/guide/' };
    const events: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const page = new Function(
      'mountAskDialog',
      'location',
      'document',
      'MutationObserver',
      script.replace(/^import .*\n/, ''),
    ) as (...args: unknown[]) => void;
    page(
      (options: { title: string }) => {
        events.push(`mount ${options.title}`);
        return { unmount: () => events.push('unmount') };
      },
      location,
      document,
      MutationObserver,
    );
    const navigate = async (pathname: string, lang: string) => {
      location.pathname = pathname;
      document.documentElement.lang = lang;
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    await navigate('/fr/guide/', 'fr');
    // Within a locale, nothing changes.
    await navigate('/fr/other/', 'fr-FR');
    await navigate('/guide/', 'en');
    expect(events).toEqual([
      'mount Ask Acme',
      'unmount',
      'mount Demander à Acme',
      'unmount',
      'mount Ask Acme',
    ]);
  });
});

describe('an integration for another framework, from ondocs/integration alone', () => {
  let site: string;
  beforeEach(async () => {
    site = await mkdtemp(join(tmpdir(), 'ondocs-framework-'));
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(site, { recursive: true, force: true });
  });

  /** The plugin's after-build hook, as the guide writes it. */
  async function afterBuild(outDir: string, routes: string[], log: Logger): Promise<void> {
    const documents: SourceDocument[] = [];
    const pages: LlmsPage[] = [];
    for (const route of routes) {
      const html = await readBuiltHtml(outDir, route);
      const built = html && loadBuiltPage(html, { url: route, root: '.content', markdown: true });
      if (!built) continue;
      documents.push(built.document);
      if (built.page) pages.push(built.page);
    }
    const options = { embedding: 'mock:32' as const };
    const embedding = await buildEmbedding(options, log);
    await writeSiteIndex({
      documents,
      embeddingModel: embedding.model,
      embeddingProviderOptions: embedding.providerOptions,
      options,
      file: join(outDir, 'ask-index.json'),
      cache: indexCache(site, 'framework.json'),
      name: 'ask-index.json',
      log,
    });
    await writeLlmsFiles({
      pages,
      site: { title: 'Acme Docs', url: 'https://docs.acme.dev' },
      outputs: llmsOutputs(undefined),
      dir: outDir,
      label: 'dist',
      log,
      linkPages: 'directory',
    });
  }

  it('indexes the built pages and writes the llms files', async () => {
    const outDir = join(site, 'dist');
    const page = (title: string, body: string) =>
      `<html><head><title>${title} | Acme Docs</title></head><body><div class="content"><h1>${title}</h1>${body}</div></body></html>`;
    await mkdir(join(outDir, 'guide'), { recursive: true });
    await writeFile(join(outDir, 'index.html'), page('Acme', '<p>Welcome to Acme.</p>'));
    await writeFile(join(outDir, 'guide', 'index.html'), page('Guide', '<p>Install Acme.</p>'));
    await writeFile(
      join(outDir, 'about.html'),
      '<html><body><p>No content region.</p></body></html>',
    );
    const log = { info: vi.fn(), warn: vi.fn() };

    await afterBuild(outDir, ['/', '/guide/', '/about'], log);

    const index = parseIndexFile(await readFile(join(outDir, 'ask-index.json'), 'utf8'));
    expect(index.documents.map(({ url, title }) => [url, title])).toEqual([
      ['/', 'Acme'],
      ['/guide/', 'Guide'],
    ]);
    expect(index.embedding).toMatchObject({ dimensions: 32 });
    expect(await readFile(join(outDir, 'llms.txt'), 'utf8')).toContain(
      '[Guide](https://docs.acme.dev/guide.md)',
    );
    expect(await readFile(join(outDir, 'guide.md'), 'utf8')).toContain('Install Acme.');
    expect(await readFile(join(outDir, 'guide', 'index.html'), 'utf8')).toContain(
      '<link rel="alternate" type="text/markdown" href="/guide.md"></head>',
    );
    expect(await readFile(join(outDir, 'about.html'), 'utf8')).not.toContain('text/markdown');
    expect(existsSync(join(outDir, 'llms-full.txt'))).toBe(true);
    expect(existsSync(join(site, 'node_modules/.cache/ondocs/framework.json'))).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
