/**
 * ondocs/docusaurus: a Docusaurus plugin. After `docusaurus build` it indexes the pages the
 * site actually serves into `ask-index.json` in the build output, and it renders the ask dialog,
 * opened from a floating button (or, with `dialog.navbar`, a button in the navbar) or a shortcut,
 * from the site's `Root`.
 *
 * The answers come from an endpoint you deploy next to the site (a Vercel, Netlify or Cloudflare
 * function running `createAskHandler` from `ondocs/server`); see the README.
 */

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildEmbedding,
  checkIndexOptions,
  checkOptions,
  consoleLogger,
  dialogEndpoint,
  excluder,
  hintDevEndpoint,
  indexCache,
  llmsOutputs,
  loadBuiltPage,
  optionRules,
  readBuiltHtml,
  resolveMcp,
  warnMissingDialogPeers,
  writeLlmsFiles,
  writeSiteIndex,
  type IndexOptions,
  type LlmsOutput,
  type LlmsPage,
  type LlmsTxtOption,
  type LocaleDialogOptions,
  type Logger,
  type McpOption,
  type OndocsDialogOptions as DialogOptions,
  type SourceDocument,
} from '../integration';

/** What the dialog shows in one locale, over the dialog's own options. */
export type OndocsLocaleDialogOptions = LocaleDialogOptions;

/** What the dialog shows; passed to `AskDialog`. */
export interface OndocsDialogOptions extends DialogOptions {
  /** The dialog's accessible name. Default "Ask {site title}", or `labels.title`. */
  title?: string;
  /**
   * An "Ask AI" button in the navbar, after the search box (or where it would be): `true`, or
   * the button's label, by default `labels.launcher` ("Ask AI"). It shows the shortcut, and on
   * a phone it is an icon that stays in the navbar. With it, the floating button is off unless
   * `launcher` is set. Off by default.
   */
  navbar?: boolean | string;
  /**
   * Options for each locale of the site, by its Docusaurus locale (`fr`, `pt-BR`), over these:
   * the labels, the title and the suggestions in that language. The build for a locale uses its
   * own, and the dialog sends the locale with each question, so an endpoint with an index per
   * locale answers from that one.
   */
  locales?: Record<string, OndocsLocaleDialogOptions>;
}

// A type, not an interface, so it fits Docusaurus's `PluginOptions` index signature in a
// `docusaurus.config.ts` plugins entry.
export type OndocsOptions = IndexOptions & {
  /** The plugin instance's id, set by Docusaurus. Default `"default"`. */
  id?: string;
  /**
   * URL the dialog posts questions to. Default `/api/ask`. The `ASK_ENDPOINT` environment
   * variable, when it is set as the site builds or starts, takes precedence over it:
   * `ASK_ENDPOINT=http://localhost:8787/api/ask` points the dialog at `ondocs dev`.
   */
  endpoint?: string;
  /** Where the index is written in the build output, and served from. Default `ask-index.json`. */
  indexFile?: string;
  /**
   * Paths to leave out, relative to the site's base URL and locale, e.g. `['/changelog']` (a
   * prefix matches its subpages too). With `baseUrl: '/docs/'`, `/changelog` leaves out
   * `/docs/changelog` and, in French, `/docs/fr/changelog`.
   */
  exclude?: string[];
  /**
   * Which docs versions to index on a site with versioned docs. `'last'`, the default, indexes
   * each docs plugin's last version, the one at the docs' own path (`/docs`, not `/docs/next` or
   * `/docs/1.0`), so answers cite the version readers land on; `'all'` indexes every version.
   * llms.txt and the `.md` copies follow it. Pages outside the docs, such as the blog, are always
   * indexed.
   */
  versions?: 'last' | 'all';
  dialog?: OndocsDialogOptions;
  /**
   * The site's MCP endpoint (`createMcpHandler` from `ondocs/server`), as an absolute URL or a
   * path on the site such as `/api/mcp`, and optionally the name clients list it under (default:
   * from the site title). `<OndocsMcp />` from `@theme/OndocsMcp` then shows how to add it
   * to Cursor, VS Code, Claude and ChatGPT.
   */
  mcp?: McpOption;
  /**
   * After the build, also write `llms.txt`, `llms-full.txt` and a Markdown copy of each indexed
   * page at its URL plus `.md` (`/docs/intro.md`), into the build output, and link each page to
   * its copy with `<link rel="alternate" type="text/markdown">`. On by default; `false`
   * turns all three off, and `{ index: false }`, `{ full: false }` or `{ markdown: false }` one
   * of them. A file the build already has (from `static/` or another plugin) is left as it is,
   * and what docusaurus-plugin-llms or docusaurus-plugin-llms-txt writes is left to them.
   */
  llmsTxt?: LlmsTxtOption;
};

/** What the theme reads with `useAllPluginInstancesData('ondocs')`. */
export interface OndocsGlobalData {
  endpoint: string;
  dialog: Omit<OndocsDialogOptions, 'locales' | 'navbar'> & { title: string };
  /** The navbar button's label, when `dialog.navbar` asks for one. */
  navbar?: string;
  /** The locale this build is for, when it is not the default one. */
  locale?: string;
  /** The MCP endpoint, absolute, when the plugin's `mcp` option names one. */
  mcp?: { url: string; name: string };
}

/** @deprecated Use `OndocsOptions`. Its name from before ask-my-site became ondocs. */
export type AskMySiteOptions = OndocsOptions;
/** @deprecated Use `OndocsDialogOptions`. Its name from before ask-my-site became ondocs. */
export type AskMySiteDialogOptions = OndocsDialogOptions;
/** @deprecated Use `OndocsGlobalData`. Its name from before ask-my-site became ondocs. */
export type AskMySiteGlobalData = OndocsGlobalData;

interface LoadContext {
  siteDir: string;
  siteConfig: { title: string; titleDelimiter?: string; url?: string; tagline?: string };
  /** The base URL with the locale's path, e.g. `/docs/fr/`. */
  baseUrl: string;
  i18n: { currentLocale: string; defaultLocale?: string };
}

interface PostBuildProps {
  outDir: string;
  routesPaths: string[];
  /** Every plugin of the site, with its options and the content it loaded. */
  plugins?: readonly { name: string; options?: unknown; content?: unknown }[];
}

const here = dirname(fileURLToPath(import.meta.url));

const { anything, boolean, oneOf, shape, string } = optionRules;

/** The options, checked as the config gives them: a plugin tuple's are not type-checked. */
const OPTION_RULES = shape<OndocsOptions>({
  ...optionRules.index,
  id: string,
  endpoint: string,
  indexFile: string,
  exclude: optionRules.exclude,
  // Checked in the plugin, with its own message.
  versions: anything,
  dialog: shape<OndocsDialogOptions>(
    {
      ...optionRules.dialog,
      title: string,
      navbar: oneOf(boolean, string),
      locales: optionRules.locales,
    },
    { renamed: optionRules.dialogRenamed },
  ),
  mcp: optionRules.mcp,
  llmsTxt: optionRules.llmsTxt,
});

/**
 * Checks the plugin's options before Docusaurus loads the plugin, as Docusaurus runs a plugin's
 * `validateOptions`: an option that is misspelled, or not one in this version of ondocs, fails
 * the build with what to change. Returns the options as they are.
 */
export function validateOptions({ options }: { options: OndocsOptions }): OndocsOptions {
  checkOptions('ondocs/docusaurus', OPTION_RULES, options);
  return options;
}

export default function ondocs(context: LoadContext, options: OndocsOptions = {}) {
  // Also here, for a plugin loaded as a function, which Docusaurus does not validate.
  checkOptions('ondocs/docusaurus', OPTION_RULES, options);
  checkIndexOptions(options);
  // Checked as the config gives it, which TypeScript may not have seen.
  const versions: unknown = options.versions;
  if (versions !== undefined && versions !== 'last' && versions !== 'all') {
    throw new Error(
      `ondocs: versions is 'last' (the default) or 'all', not ${JSON.stringify(versions)}.`,
    );
  }
  warnMissingDialogPeers(consoleLogger());
  warnOldSwizzle(context.siteDir, consoleLogger());
  const { title: siteTitle, titleDelimiter = '|' } = context.siteConfig;
  const indexFile = (options.indexFile ?? 'ask-index.json').replace(/^\/+/, '');
  const mcp = resolveMcp(options.mcp, context.siteConfig.url, siteTitle, 'the site config');
  // This build's locale: its own options over the dialog's, and sent with each question.
  const { currentLocale, defaultLocale } = context.i18n;
  const { locales: perLocale, ...base } = withLauncher(options.dialog ?? {}, 'dialog.');
  const own = withLauncher(perLocale?.[currentLocale] ?? {}, `dialog.locales.${currentLocale}.`);
  const labels = { ...base.labels, ...own.labels };
  const dialog = { ...base, ...own, ...(Object.keys(labels).length > 0 ? { labels } : {}) };
  // With a button in the navbar, the floating one is off unless `launcher` says otherwise.
  const { navbar, ...rest } = dialog;
  const launcher = navbar && rest.launcher === undefined ? { launcher: false } : {};
  const data: OndocsGlobalData = {
    endpoint: dialogEndpoint(options.endpoint),
    dialog: { ...rest, ...launcher, title: dialog.title ?? labels.title ?? `Ask ${siteTitle}` },
    ...(navbar
      ? { navbar: typeof navbar === 'string' ? navbar : (labels.launcher ?? 'Ask AI') }
      : {}),
    ...(defaultLocale !== undefined && currentLocale !== defaultLocale
      ? { locale: currentLocale }
      : {}),
    ...(mcp ? { mcp } : {}),
  };

  return {
    name: 'ondocs',

    getThemePath() {
      // Root, which renders Ondocs: both can be swizzled.
      return join(here, 'theme');
    },

    getClientModules() {
      // The dialog's stylesheet (dist/styles.css, `ondocs/react/styles.css`) and the launcher's.
      return [join(here, '..', 'styles.css'), join(here, 'launcher.css')];
    },

    injectHtmlTags() {
      // The navbar button's shortcut reads ⌘ on Apple devices and Ctrl elsewhere, from an
      // attribute set before the page renders, so the server's HTML is right as it is.
      if (!data.navbar) return {};
      return {
        headTags: [
          {
            tagName: 'script',
            innerHTML:
              "document.documentElement.toggleAttribute('data-ondocs-mac',/Mac|iPhone|iPad/.test(navigator.platform))",
          },
        ],
      };
    },

    contentLoaded({ actions }: { actions: { setGlobalData: (data: unknown) => void } }) {
      actions.setGlobalData(data);
      // `docusaurus start`; `build` sets production.
      if (process.env.NODE_ENV === 'development') {
        hintDevEndpoint(data.endpoint, 'docusaurus start', consoleLogger());
      }
    },

    async postBuild({ outDir, routesPaths, plugins }: PostBuildProps) {
      const log = consoleLogger();
      const outputs = llmsOutputs(options.llmsTxt);
      const llms = outputs.index || outputs.full || outputs.markdown;
      const versions = options.versions === 'all' ? [] : docsVersions(plugins ?? []);
      const left = versions.filter((version) => !version.indexed).map((version) => version.path);
      if (left.length > 0) {
        log.info(
          `Indexing the last docs version, without ${left.join(', ')}. Set versions: 'all' to ` +
            'index every version.',
        );
      }
      const { documents, pages } = await loadBuiltPages(outDir, routesPaths, context.baseUrl, {
        exclude: options.exclude ?? [],
        leftOut: (route) => !versionOf(route, versions).indexed,
        titleSuffix: ` ${titleDelimiter} ${siteTitle}`,
        markdown: llms,
      });
      const embedding = await buildEmbedding(options, log);
      await writeSiteIndex({
        documents,
        embeddingModel: embedding.model,
        embeddingProviderOptions: embedding.providerOptions,
        options,
        file: join(outDir, indexFile),
        // One file per locale and plugin instance (.docusaurus is not kept between builds).
        cache: indexCache(
          context.siteDir,
          `${context.i18n.currentLocale}-${options.id ?? 'default'}.json`,
        ),
        name: indexFile,
        log,
      });
      if (llms) {
        const named = typeof options.llmsTxt === 'object' ? options.llmsTxt : {};
        const description = named.description ?? context.siteConfig.tagline;
        await writeLlmsFiles({
          pages,
          site: {
            title: named.title ?? siteTitle,
            ...(description ? { description } : {}),
            ...(context.siteConfig.url ? { url: context.siteConfig.url } : {}),
            base: context.baseUrl,
            ...(mcp ? { mcp: mcp.url } : {}),
          },
          outputs,
          owners: llmsOwners(plugins ?? []),
          dir: outDir,
          label: 'the build',
          log,
          // Docusaurus writes /guides/setup to guides/setup/index.html, or with trailingSlash:
          // false, guides/setup.html, which is tried next.
          linkPages: 'directory',
        });
      }
    },
  };
}

const warnedRenames = new Set<string>();

/**
 * `options` with `buttonLabel`, the launcher's name before 0.9, moved to `launcher` (which wins
 * when both are set). Says once, while the site builds, that `buttonLabel` under `where` (such as
 * `dialog.`) is now `launcher`.
 */
function withLauncher<
  Options extends { launcher?: boolean | string; buttonLabel?: string | false },
>(options: Options, where: string): Omit<Options, 'buttonLabel'> {
  const { buttonLabel, ...rest } = options;
  if (buttonLabel === undefined) return rest;
  if (!warnedRenames.has(where)) {
    warnedRenames.add(where);
    consoleLogger().warn(
      `${where}buttonLabel is now ${where}launcher. The old name still works until 1.0.`,
    );
  }
  return rest.launcher === undefined ? { ...rest, launcher: buttonLabel } : rest;
}

/**
 * Warns about a swizzled copy of the dialog under its name from before ask-my-site became ondocs,
 * `src/theme/AskMySite`, which the plugin's `Root` no longer renders: it renders `@theme/Ondocs`.
 */
export function warnOldSwizzle(siteDir: string, log: Logger): void {
  let entries: string[];
  try {
    entries = readdirSync(join(siteDir, 'src', 'theme'));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!/^AskMySite(?:\.[jt]sx?)?$/.test(entry)) continue;
    const renamed = entry.replace('AskMySite', 'Ondocs');
    log.warn(
      `src/theme/${entry} swizzles @theme/AskMySite, which is now @theme/Ondocs, so the dialog ` +
        `no longer uses it. Rename it: git mv src/theme/${entry} src/theme/${renamed}, and ` +
        'change any @theme-original/AskMySite import in it to @theme-original/Ondocs.',
    );
  }
}

/** A plugin option, read without trusting its type. */
function option(options: unknown, ...path: string[]): unknown {
  let value = options;
  for (const key of path) {
    value =
      typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)[key]
        : undefined;
  }
  return value;
}

/**
 * The llms outputs another plugin of the site writes, by its name, as its options configure it:
 * docusaurus-plugin-llms (llms.txt and llms-full.txt, and .md copies with
 * `generateMarkdownFiles`), docusaurus-plugin-llms-txt, @signalwire's or the unscoped one
 * (llms.txt, .md copies unless turned off, and llms-full.txt when turned on), and
 * docusaurus-plugin-copy-page-button (.md copies with `generateMarkdownRoutes`).
 */
export function llmsOwners(
  plugins: readonly { name: string; options?: unknown }[],
): Map<LlmsOutput, string> {
  const owners = new Map<LlmsOutput, string>();
  const claim = (output: LlmsOutput, name: string): void => {
    if (!owners.has(output)) owners.set(output, name);
  };
  for (const { name, options } of plugins) {
    if (name === 'docusaurus-plugin-llms') {
      if (option(options, 'generateLLMsTxt') !== false) claim('index', name);
      if (option(options, 'generateLLMsFullTxt') !== false) claim('full', name);
      if (option(options, 'generateMarkdownFiles') === true) claim('markdown', name);
    } else if (name === 'docusaurus-plugin-llms-txt') {
      claim('index', name);
      if (
        option(options, 'content', 'enableMarkdownFiles') !== false &&
        option(options, 'markdown', 'enableFiles') !== false
      ) {
        claim('markdown', name);
      }
      if (
        option(options, 'content', 'enableLlmsFullTxt') === true ||
        option(options, 'llmsTxt', 'enableLlmsFullTxt') === true
      ) {
        claim('full', name);
      }
    } else if (name === 'copy-page-button-plugin') {
      if (option(options, 'generateMarkdownRoutes') === true) claim('markdown', name);
    }
  }
  return owners;
}

/** A docs version, as the docs plugin loaded it: its route path, and whether it is indexed. */
interface DocsVersion {
  path: string;
  indexed: boolean;
}

/**
 * The versions of each docs plugin instance (`loadedVersions` in the content the docs plugin
 * loaded, each with its route `path` and whether it `isLast`), with only the last of each
 * instance indexed. An instance whose content has another shape, or none, is left out, so all of
 * its versions are indexed, as is everything when reading the content throws.
 */
function docsVersions(plugins: readonly { content?: unknown }[]): DocsVersion[] {
  try {
    return plugins.flatMap((plugin) => {
      const loaded = option(plugin.content, 'loadedVersions');
      if (!Array.isArray(loaded)) return [];
      const versions = loaded.map((version: unknown) => ({
        path: option(version, 'path'),
        isLast: option(version, 'isLast'),
      }));
      if (!versions.some(({ isLast }) => isLast === true)) return [];
      return versions.flatMap(({ path, isLast }) =>
        typeof path === 'string'
          ? [{ path: path.replace(/\/+$/, '') || '/', indexed: isLast === true }]
          : [],
      );
    });
  } catch {
    return [];
  }
}

/**
 * The docs version a route is in: the one whose path holds it most closely (`/docs/next/intro`
 * is in `/docs/next`, not `/docs`). A route in none, such as a blog post, counts as indexed.
 */
function versionOf(route: string, versions: readonly DocsVersion[]): DocsVersion {
  let found: DocsVersion = { path: '', indexed: true };
  for (const version of versions) {
    const holds =
      version.path === '/' || route === version.path || route.startsWith(`${version.path}/`);
    if (holds && version.path.length > found.path.length) found = version;
  }
  return found;
}

/**
 * Docusaurus's page types, from the classes it puts on `<html>`. Docs, blog posts and MDX pages
 * are content; blog lists, tag and author pages list content that is indexed on its own page.
 */
const CONTENT_PAGES = ['docs-doc-page', 'blog-post-page', 'mdx-page'];
const LISTING_PAGES = [
  'blog-list-page',
  'blog-tags-list-page',
  'blog-tags-post-list-page',
  'blog-authors-list-page',
  'blog-authors-posts-page',
  'docs-tags-list-page',
  'docs-tags-doc-list-page',
];

/** Whether a built page is content to index, from its page type. */
function isContentPage(html: string): boolean {
  const tag = /<html(?=[\s>])[^<>]*>/i.exec(html)?.[0] ?? '';
  const quoted = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
  const classes = (quoted?.[1] ?? quoted?.[2] ?? quoted?.[3] ?? '').split(/\s+/);
  if (classes.includes('docs-doc-page')) {
    // A generated-index category page is a docs page too, but without the doc's id: its cards
    // repeat the pages they link to.
    return classes.some((name) => name.startsWith('docs-doc-id-'));
  }
  if (CONTENT_PAGES.some((name) => classes.includes(name))) return true;
  if (LISTING_PAGES.some((name) => classes.includes(name))) return false;
  // No page type (an older or custom theme): a page with an article is content.
  return /<article[\s>]/i.test(html);
}

/** `route` relative to the (localized) base URL, with a leading slash: `/docs/fr/intro` → `/intro`. */
function sitePath(route: string, baseUrl: string): string {
  if (route.startsWith(baseUrl)) return `/${route.slice(baseUrl.length)}`;
  return `${route}/` === baseUrl ? '/' : route;
}

/**
 * The pages Docusaurus wrote, as documents: each content page's HTML, read from its `<article>`
 * (the doc or post itself, without the table of contents or pagination, and from Docusaurus's
 * Markdown container when there is one, without breadcrumbs or a post's byline), at the URL it is
 * served from. Listing pages, the 404 page and pages without an article are skipped.
 */
async function loadBuiltPages(
  outDir: string,
  routesPaths: readonly string[],
  baseUrl: string,
  {
    exclude,
    leftOut,
    titleSuffix,
    markdown,
  }: {
    exclude: readonly string[];
    leftOut: (route: string) => boolean;
    titleSuffix: string;
    markdown: boolean;
  },
): Promise<{ documents: SourceDocument[]; pages: LlmsPage[] }> {
  const excluded = excluder(exclude);
  const documents: SourceDocument[] = [];
  const pages: LlmsPage[] = [];
  for (const route of [...new Set(routesPaths)].sort()) {
    const path = sitePath(route, baseUrl);
    if (route.endsWith('404.html') || excluded(path) || leftOut(route)) continue;
    const html = await readBuiltHtml(outDir, path);
    if (html === undefined || !isContentPage(html)) continue;
    const built = loadBuiltPage(html, {
      url: route,
      contentSelector: 'article',
      titleSuffix,
      markdown,
    });
    if (!built) continue;
    documents.push(built.document);
    if (built.page) pages.push(built.page);
  }
  return { documents, pages };
}
