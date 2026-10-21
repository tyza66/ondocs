// Reading the pages a framework built: what the plugins share between their build output and the
// index. Node.js only.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { warnDeprecated } from '../deprecation';
import type { LlmsPage } from '../llms';
import { fromHtml } from '../loaders/html';
import type { SourceDocument } from '../types';

/**
 * The HTML a build wrote for `path` (relative to the output folder, with or without slashes):
 * `guides/setup/index.html` or `guides/setup.html`, whichever exists, trying the `layout` the
 * framework uses first. The site's root is `index.html`. `undefined` when there is neither.
 */
export async function readBuiltHtml(
  outDir: string,
  path: string,
  layout: 'directory' | 'file' = 'directory',
): Promise<string | undefined> {
  const clean = path.replace(/^\/+|\/+$/g, '');
  const files =
    clean === ''
      ? ['index.html']
      : layout === 'file'
        ? [`${clean}.html`, `${clean}/index.html`]
        : [`${clean}/index.html`, `${clean}.html`];
  for (const file of files) {
    try {
      return await readFile(join(outDir, ...file.split('/')), 'utf8');
    } catch {
      // Try the other layout.
    }
  }
  return undefined;
}

export interface BuiltPageOptions {
  /** The URL the site serves the page at, with its base path: what answers cite. */
  url: string;
  /** The document's id in the index. Default: `url`. */
  id?: string;
  /**
   * The part of the page to read: `main` (the default, then the page's `<article>`s, then its
   * `<body>`), `article`, or a selector such as `[data-pagefind-body]` or `.vp-doc`, as the
   * plugins' `contentSelector` takes it. With a selector, a page where it matches nothing has no
   * content.
   */
  contentSelector?: string;
  /** What to leave out of `contentSelector`, as a selector, such as `.header-anchor, .toc`. */
  ignoreSelector?: string;
  /**
   * @deprecated Use `contentSelector`, which takes the same selector. `root` still works, with a
   * warning, until 1.0.
   */
  root?: string;
  /**
   * @deprecated Use `ignoreSelector`, which takes the same selector. `ignore` still works, with a
   * warning, until 1.0.
   */
  ignore?: string;
  /**
   * What the framework's `<title>` adds after the page's own title, such as ` | Acme Docs`,
   * taken off a title read from it. A title from the page's `<h1>` has none.
   */
  titleSuffix?: string;
  /** Also read the page as Markdown, for its `.md` copy and `llms-full.txt`. Default `false`. */
  markdown?: boolean;
}

/** A built page: the document to index, and with `markdown`, the page for the llms files. */
export interface BuiltPage {
  document: SourceDocument;
  /** The page as Markdown, for `writeLlmsFiles`, when `markdown` is set. */
  page?: LlmsPage;
}

/**
 * Reads a page a framework built into what the index and the llms files are made of: its
 * content as text to index and, with `markdown`, as Markdown to read. `null` for a page with no
 * content (nothing in `contentSelector`, or `<meta name="robots" content="noindex">`), which is not
 * indexed.
 */
export function loadBuiltPage(html: string, options: BuiltPageOptions): BuiltPage | null {
  const { url, id = url, titleSuffix, markdown = false } = options;
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- their names before 0.14, still read
  const { root: oldRoot, ignore: oldIgnore } = options;
  if (oldRoot !== undefined) warnDeprecated("loadBuiltPage's root", 'contentSelector');
  if (oldIgnore !== undefined) warnDeprecated("loadBuiltPage's ignore", 'ignoreSelector');
  const root = options.contentSelector ?? oldRoot;
  const ignore = options.ignoreSelector ?? oldIgnore;
  const meta = { id, url, ...(root ? { root } : {}), ...(ignore ? { ignore } : {}) };
  const read = fromHtml(html, meta);
  if (!read?.content.trim()) return null;
  // A title read from <title> ends with the site's: "Setup | Acme Docs".
  const document =
    titleSuffix && read.title.endsWith(titleSuffix) && read.title.length > titleSuffix.length
      ? { ...read, title: read.title.slice(0, -titleSuffix.length) }
      : read;
  if (!markdown) return { document };
  const copy = fromHtml(html, { ...meta, markdown: true });
  return {
    document,
    page: {
      url,
      title: document.title,
      ...(document.description ? { description: document.description } : {}),
      content: copy?.content ?? document.content,
    },
  };
}
