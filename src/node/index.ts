/**
 * ondocs/node: file-system helpers for build scripts and the CLI. Node.js only.
 */

import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, posix, resolve, sep } from 'node:path';

import type { EmbeddingModel } from 'ai';
import { slug } from 'github-slugger';

import type { EmbeddingProviderOptions } from '../build';
import { parseIndexFile, serializeIndexFile, type AskIndexFile } from '../index-file';
import { fromHtml } from '../loaders/html';
import { fromMarkdown, parseFrontmatter } from '../loaders/markdown';
import { dropHeadingFootnotes } from '../text/markdown';
import type { ChunkingOptions, SourceDocument } from '../types';
import type { EmbeddingSpec } from './embedding';
import { matchesGlob } from './glob';
import {
  NEXT_CONFIG,
  nextHeadingIds,
  nextPath,
  nextSite,
  type NextRouting,
  type NextSite,
} from './next';

export type { NextRouting } from './next';

export const DEFAULT_EXTENSIONS = ['.md', '.mdx', '.markdown', '.html', '.htm'] as const;

/**
 * How a docs framework turns content files into URLs:
 *
 * - `docusaurus` (docs plugin): frontmatter `slug` (absolute, or resolved against the page's
 *   folder) and `id`, number prefixes dropped (`01-intro.md` → `intro`, but not `2024-12-recap.md`
 *   or `1.0-release.md`), `index`, `README` or a file named like its folder as the folder's page,
 *   and `_`-prefixed files and folders as partials. A heading's footnote references (`[^1]`) are
 *   left out of its anchor, as Docusaurus leaves them out of its id.
 * - `starlight`: frontmatter `slug` replaces the path, segments are slugified, `index` is the
 *   folder's page, and `_`-prefixed files are skipped.
 * - `next`: a Next.js site, by the rules of the folder read: in an App Router folder (`app` or
 *   `src/app`), `page.mdx` files are the pages, `(group)` folders are not part of the URL and
 *   `_private` folders are not routed; in a content folder, `index.mdx` is its folder's page, and
 *   `(group)` folders are not part of the URL for Fumadocs but are for Nextra. Headings take
 *   custom ids as `## Title [#id]`, which Nextra slugs, and Fumadocs and Nextra leave footnote
 *   references (`[^1]`) out of a heading's id.
 * - `none`: the path as it is.
 */
export type Framework = 'docusaurus' | 'starlight' | 'next' | 'none';

const FRAMEWORK_CONFIGS: [Framework, RegExp][] = [
  ['docusaurus', /^docusaurus\.config\.[cm]?[jt]s$/],
  ['starlight', /^astro\.config\.[cm]?[jt]s$/],
  ['next', NEXT_CONFIG],
];

/**
 * The framework whose config sits in `directory` or a folder above it, up to the nearest
 * `package.json`. An Astro project counts as Starlight only when it depends on `@astrojs/starlight`.
 */
export async function detectFramework(directory: string): Promise<Framework> {
  // Through links, so content linked in from a site still finds that site's config.
  const start = await realpath(directory).catch(() => resolve(directory));
  for (let dir = start; ; dir = dirname(dir)) {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const [framework, pattern] of FRAMEWORK_CONFIGS) {
      if (!names.some((name) => pattern.test(name))) continue;
      if (framework !== 'starlight') return framework;
      const manifest = await readFile(join(dir, 'package.json'), 'utf8').catch(() => '');
      return manifest.includes('"@astrojs/starlight"') ? 'starlight' : 'none';
    }
    if (names.includes('package.json') || dir === dirname(dir)) return 'none';
  }
}

export interface LoadDirectoryOptions {
  /** Prefix for every page URL, e.g. `/docs` or `https://example.com`. Default `/`. */
  baseUrl?: string;
  /**
   * How file paths become URLs; see {@link Framework}. `'auto'` detects it from the framework
   * config in or above the directory, as the CLI does. Default `'none'`: the path as it is.
   */
  framework?: Framework | 'auto';
  /** File extensions to read. Default Markdown, MDX and HTML. */
  extensions?: readonly string[];
  /**
   * Glob patterns, relative to the directory, of files to skip: `*`, `**`, `?`, `[...]` and
   * `{a,b}`, matched case-sensitively.
   */
  ignore?: readonly string[];
  /**
   * Drop `.html` from the URLs of HTML files, for a host that serves `guides/setup.html` at
   * `/guides/setup`. Default `false`: the URL keeps the file's name, which every server serves.
   * The frameworks' rules always drop it.
   */
  cleanUrls?: boolean;
  /**
   * Keep each page's content as Markdown to read (links, images, tables and quotes), for its
   * `.md` copy and `llms-full.txt`, rather than the text an index holds.
   */
  markdown?: boolean;
}

/**
 * Maps a content path to a URL: `index`/`_index`/`README` files stand for their folder, Markdown
 * extensions are dropped, and an HTML file keeps its `.html`, as a server without clean URLs
 * serves it, unless `cleanUrls` drops it too. `guides/setup.md` → `/guides/setup`,
 * `guides/setup.html` → `/guides/setup.html`, `guides/index.html` → `/guides`.
 */
export function pathToUrl(
  relativePath: string,
  baseUrl = '/',
  { cleanUrls = false }: { cleanUrls?: boolean } = {},
): string {
  const file = relativePath.split(sep).join('/');
  const withoutExt = file.replace(/\.(?:mdx?|markdown|html?)$/i, '');
  // `_index` is Hugo's section page.
  const folder = /(?:^|\/)(?:_?index|readme)$/i;
  const path = folder.test(withoutExt)
    ? withoutExt.replace(folder, '')
    : cleanUrls || !/\.html?$/i.test(file)
      ? withoutExt
      : file;
  const base = baseUrl.replace(/\/+$/, '');
  if (!path) return base || '/';
  return `${base}/${path}`;
}

/** Whether a framework treats this path as a partial rather than a page. */
function isHidden(path: string, framework: Framework, routing: NextRouting): boolean {
  if (framework === 'docusaurus') return path.split('/').some((segment) => segment.startsWith('_'));
  // Astro skips `_` files, not `_` folders.
  if (framework === 'starlight') return basename(path).startsWith('_');
  // Fumadocs and Nextra serve `_` files; in an App Router folder, only `page.mdx` files are pages.
  if (framework === 'next') return nextPath(path, routing) === null;
  return false;
}

/**
 * `path` under `baseUrl`, without the slashes around it: `/docs` and `guides/setup/` give
 * `/docs/guides/setup`.
 */
function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const clean = path.replace(/^\/+|\/+$/g, '');
  return clean ? `${base}/${clean}` : base || '/';
}

// Docusaurus's DefaultNumberPrefixParser: `01-intro` → `intro`, but dates and versions stay.
const NUMBER_PREFIX = /^\d+\s*[-_.]+\s*(?=[^-_.\s])/;
const NOT_A_NUMBER_PREFIX = /^\d+[-_.]\d+/;
const stripNumberPrefix = (name: string) =>
  NOT_A_NUMBER_PREFIX.test(name) ? name : name.replace(NUMBER_PREFIX, '');

/** Options for {@link frameworkUrl}. */
export interface FrameworkUrlOptions {
  /**
   * For `next`, the rules of the folder the path is in, as `loadDirectory` reads them from the
   * site: `app` (an App Router folder), `fumadocs`, `nextra`, or `content` (any other content
   * folder, read as Fumadocs reads it).
   */
  routing?: NextRouting;
}

/**
 * The URL a framework serves a content file at, before `url`/`permalink` frontmatter, which
 * always wins. `relativePath` uses `/`.
 *
 * For `next`, whose rules depend on the folder, pass the folder's `routing` to follow its rules,
 * as `loadDirectory` does: `getting-started/page.mdx` in a Fumadocs content folder is
 * `/getting-started/page`. Without it, or for a file that is not a page by those rules (in an App
 * Router folder, anything but `page.mdx`), a path is read as an App Router path and a Fumadocs
 * path at once: `(group)` folders are left out, and `index` and `page` are the folder's page.
 */
export function frameworkUrl(
  relativePath: string,
  frontmatter: Record<string, unknown>,
  framework: Framework,
  baseUrl = '/',
  { routing }: FrameworkUrlOptions = {},
): string {
  const toUrl = (path: string) => joinUrl(baseUrl, path);
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : undefined);
  const dirs = relativePath.split('/');
  const name = (dirs.pop() ?? '').replace(/\.(?:mdx?|markdown|html?)$/i, '');

  if (framework === 'docusaurus') {
    // As Docusaurus's getSlug: the index test uses the names as written, case-insensitively.
    const isIndex =
      /^(?:index|readme)$/i.test(name) || name.toLowerCase() === dirs.at(-1)?.toLowerCase();
    const strip = frontmatter.parse_number_prefixes !== false;
    const folder = `/${(strip ? dirs.map(stripNumberPrefix) : dirs).join('/')}/`.replace(
      /\/+/g,
      '/',
    );
    const slugValue = text(frontmatter.slug);
    if (slugValue !== undefined) return toUrl(posix.resolve(folder, slugValue));
    if (isIndex) return toUrl(folder);
    const id = text(frontmatter.id);
    const page = id && !id.includes('/') ? id : name;
    return toUrl(posix.resolve(folder, strip ? stripNumberPrefix(page) : page));
  }
  if (framework === 'starlight') {
    const slugValue = text(frontmatter.slug);
    if (slugValue) return toUrl(slugValue);
    const page = name.toLowerCase() === 'index' ? '' : slug(name);
    return toUrl([...dirs.map((d) => slug(d)), page].filter(Boolean).join('/'));
  }
  if (framework === 'next') {
    const path = routing === undefined ? null : nextPath(relativePath, routing);
    if (path !== null) return toUrl(path);
    const page = /^(?:index|page)$/i.test(name) ? '' : name;
    return toUrl([...dirs.filter((d) => !/^\(.+\)$/.test(d)), page].filter(Boolean).join('/'));
  }
  return pathToUrl(relativePath, baseUrl);
}

function titleFromPath(relativePath: string): string {
  const name = basename(relativePath, extname(relativePath));
  const base = /^(?:_?index|readme|page)$/i.test(name) ? basename(dirname(relativePath)) : name;
  const words = base.replace(/[-_]+/g, ' ').trim() || 'Home';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The files under `directory` with one of `extensions`, as `/`-separated paths relative to it:
 * `file` as named on disk, `path` in NFC. Symlinks are followed, except one that leads back into
 * a directory being walked (a cycle); broken links, dot-entries and `node_modules` are skipped.
 */
async function listFiles(
  directory: string,
  extensions: ReadonlySet<string>,
): Promise<{ file: string; path: string }[]> {
  const files: { file: string; path: string }[] = [];
  const walk = async (relativeDir: string, ancestors: ReadonlySet<string>): Promise<void> => {
    const absolute = join(directory, relativeDir);
    const real = await realpath(absolute);
    if (ancestors.has(real)) return;
    const within = new Set(ancestors).add(real);
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const file = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        const target = await stat(join(directory, file)).catch(() => null);
        isDirectory = target?.isDirectory() ?? false;
        isFile = target?.isFile() ?? false;
      }
      if (isDirectory) await walk(file, within);
      else if (isFile && extensions.has(extname(entry.name).toLowerCase())) {
        // macOS can hand back decomposed names (`e` + U+0301) where Linux has composed ones (`é`).
        // Ids and URLs use NFC, so an index checks out the same everywhere.
        files.push({ file, path: file.normalize('NFC') });
      }
    }
  };
  await walk('', new Set());
  return files;
}

/**
 * Reads every Markdown, MDX and HTML file under `directory` (recursively, in a stable order) and
 * returns them as documents. Dot-directories and `node_modules` are skipped, as are pages that
 * opt out (`draft: true`, `ask: false`, `noindex`). Symlinked files and directories are followed;
 * a link back into a directory that is already being read is skipped. Ids and URLs are the
 * relative path in Unicode NFC.
 */
export async function loadDirectory(
  directory: string,
  options: LoadDirectoryOptions = {},
): Promise<SourceDocument[]> {
  const extensions = new Set(
    (options.extensions ?? DEFAULT_EXTENSIONS).map((e) => e.toLowerCase()),
  );
  const ignore = options.ignore ?? [];
  const framework =
    options.framework === 'auto' ? await detectFramework(directory) : (options.framework ?? 'none');
  const site = framework === 'next' ? await nextSite(directory) : undefined;
  const routing = site?.routing ?? 'content';
  const files = (await listFiles(directory, extensions))
    .filter(({ path }) => !isHidden(path, framework, routing))
    .filter(({ path }) => !ignore.some((pattern) => matchesGlob(path, pattern)))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const documents: SourceDocument[] = [];
  for (const { file, path } of files) {
    const source = await readFile(join(directory, file), 'utf8');
    const ext = extname(path).toLowerCase();
    const markdown = ext !== '.html' && ext !== '.htm';
    let url = pathToUrl(path, options.baseUrl, { cleanUrls: options.cleanUrls ?? false });
    if (framework === 'next') {
      url = frameworkUrl(path, {}, framework, options.baseUrl, { routing });
    } else if (framework !== 'none') {
      let frontmatter: Record<string, unknown> = {};
      try {
        frontmatter = markdown ? parseFrontmatter(source).data : {};
      } catch {
        // Invalid YAML: fromMarkdown below reports it with the file name.
      }
      url = frameworkUrl(path, frontmatter, framework, options.baseUrl);
    }
    const meta = { id: path, url, fallbackTitle: titleFromPath(path) };
    let document: SourceDocument | null;
    try {
      document =
        ext === '.html' || ext === '.htm'
          ? fromHtml(source, { ...meta, markdown: options.markdown ?? false })
          : fromMarkdown(
              // A page's `.md` copy keeps its headings as written.
              options.markdown ? source : indexedHeadings(source, framework, site),
              {
                ...meta,
                mdx: ext === '.mdx',
                markdown: options.markdown ?? false,
              },
            );
    } catch (error) {
      // Invalid frontmatter YAML, most often: say which file.
      throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    if (document) documents.push(document);
  }
  return documents;
}

/**
 * The source with its headings as the index reads them: a Next.js site's `[#id]` heading ids, and
 * without footnote references where the framework leaves them out of a heading's id (Docusaurus,
 * Fumadocs, Nextra). Astro, and so Starlight, puts the footnote's number in the id instead.
 */
function indexedHeadings(source: string, framework: Framework, site: NextSite | undefined): string {
  const text = site ? nextHeadingIds(source, site) : source;
  const footnotes =
    framework === 'docusaurus' || site?.nextra === true || site?.routing === 'fumadocs';
  return footnotes ? dropHeadingFootnotes(text) : text;
}

/** Reads and validates an index file. Returns `null` if it does not exist. */
export async function readIndexFile(path: string): Promise<AskIndexFile | null> {
  let json: string;
  try {
    json = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return parseIndexFile(json);
}

/** Writes an index file atomically (temp file, then rename), creating directories as needed. */
export async function writeIndexFile(path: string, index: AskIndexFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${String(process.pid)}.tmp`;
  await writeFile(temporary, serializeIndexFile(index), 'utf8');
  await rename(temporary, path);
}

/** The default export of a `--config` module for the CLI. Every field is optional. */
export interface AskConfig {
  /**
   * The embedding model for builds, as `--embedding` names it and the plugins' `embedding` takes
   * it, so the config needs no provider import: `openai:<model>`, `workers-ai:@cf/<model>`,
   * `<provider>/<model>` through AI Gateway, `mock[:<dims>]`, or `none` for a keyword-only index.
   * Instead of `embeddingModel`. `--embedding` wins over it.
   */
  embedding?: EmbeddingSpec;
  /**
   * The vector size for `embedding` or the default model, as `--dimensions`, which wins over it.
   * With `embeddingModel`, set `embeddingProviderOptions` instead.
   */
  dimensions?: number;
  /** Embedding model for builds, as an AI SDK model. `null` builds a keyword-only index. */
  embeddingModel?: EmbeddingModel | null;
  embeddingProviderOptions?: EmbeddingProviderOptions;
  chunking?: ChunkingOptions;
  /** URL prefix for pages loaded from the directory. */
  baseUrl?: string;
  /** Glob patterns of files to skip. */
  ignore?: string[];
  /** How file paths become URLs; see {@link Framework}. The CLI's default is `'auto'`. */
  framework?: Framework | 'auto';
  /** Drop `.html` from HTML files' URLs; see {@link LoadDirectoryOptions.cleanUrls}. */
  cleanUrls?: boolean;
  /** Documents from elsewhere (a CMS, an API), indexed alongside the directory. */
  documents?: SourceDocument[] | (() => SourceDocument[] | Promise<SourceDocument[]>);
  /**
   * What `ondocs index --llms-txt <dir>` writes and how it names the site: `title` and
   * `description` head `llms.txt`, `siteUrl` makes its links absolute, `mcp` points agents at the
   * MCP endpoint, and `index`, `full` and `markdown` set to `false` leave out `llms.txt`,
   * `llms-full.txt` or the pages' `.md` copies. The flags of the same names win.
   */
  llmsTxt?: {
    title?: string;
    description?: string;
    siteUrl?: string;
    mcp?: string;
    index?: boolean;
    full?: boolean;
    markdown?: boolean;
  };
}

/** Identity function that types a config module. */
export function defineConfig(config: AskConfig): AskConfig {
  return config;
}
