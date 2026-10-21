---
# Generated from examples/nextjs/content/docs/writing-an-integration.md by scripts/sync-example-docs.mjs. Edit that file instead.
title: 'Writing an integration'
description: 'Build a plugin for another docs framework from ondocs/integration, the helpers the Docusaurus, Astro, Starlight and VitePress plugins are made of.'
---

The Docusaurus plugin, the Astro integration, and the Starlight and VitePress plugins are built from one import, `ondocs/integration`, and use nothing else of ondocs's to build. A plugin for another framework imports the same helpers: it reads the pages the framework built, writes the index and the llms files next to them, and adds the launcher to every page. It runs in Node.js, as the site builds.

## What an integration does

An integration has two jobs, at two moments of the framework's build:

1. **While the framework loads its config**, check the options, so a mistake fails before anything is built, and add the launcher and its stylesheets to every page, pointed at the endpoint.
2. **After the framework has written the site**, read each page it built, at the URL it is served from, and write `ask-index.json`, `llms.txt`, `llms-full.txt` and the pages' `.md` copies into the build output, linking each page to its copy.

Indexing the built pages, rather than the Markdown sources, means the index has what readers see: the URLs the site serves, with its base path, its rewrites and its trailing slashes, and the pages' text after components and includes have rendered.

## A minimal integration

Here is the whole integration for an imaginary framework whose plugins get a `clientModule` that every page imports and a `buildEnd` hook with the output folder and the routes it built:

```ts
import {
  buildEmbedding,
  checkIndexOptions,
  checkOptions,
  consoleLogger,
  dialogEndpoint,
  excluder,
  indexCache,
  LAUNCHER_STYLESHEETS,
  launcherScript,
  llmsOutputs,
  loadBuiltPage,
  optionRules,
  readBuiltHtml,
  writeLlmsFiles,
  writeSiteIndex,
  type IndexOptions,
  type LlmsPage,
  type LlmsTxtOption,
  type SourceDocument,
} from 'ondocs/integration';

export type OndocsOptions = IndexOptions & {
  endpoint?: string;
  exclude?: string[];
  llmsTxt?: LlmsTxtOption;
};

const OPTIONS = optionRules.shape<OndocsOptions>({
  ...optionRules.index,
  endpoint: optionRules.string,
  exclude: optionRules.exclude,
  llmsTxt: optionRules.llmsTxt,
});

export default function ondocs(options: OndocsOptions = {}) {
  checkOptions('ondocs-acme', OPTIONS, options);
  checkIndexOptions(options);
  const log = consoleLogger();
  return {
    name: 'ondocs',
    clientModule: [
      ...LAUNCHER_STYLESHEETS.map((stylesheet) => `import '${stylesheet}';`),
      launcherScript({ endpoint: dialogEndpoint(options.endpoint), title: 'Ask Acme Docs' }),
    ].join('\n'),
    async buildEnd({ root, outDir, routes }: { root: string; outDir: string; routes: string[] }) {
      const excluded = excluder(options.exclude ?? []);
      const outputs = llmsOutputs(options.llmsTxt);
      const documents: SourceDocument[] = [];
      const pages: LlmsPage[] = [];
      for (const route of routes) {
        if (excluded(route)) continue;
        const html = await readBuiltHtml(outDir, route);
        if (html === undefined) continue;
        const built = loadBuiltPage(html, { url: route, contentSelector: 'main', markdown: true });
        if (!built) continue;
        documents.push(built.document);
        if (built.page) pages.push(built.page);
      }
      const embedding = await buildEmbedding(options, log);
      await writeSiteIndex({
        documents,
        embeddingModel: embedding.model,
        embeddingProviderOptions: embedding.providerOptions,
        options,
        file: `${outDir}/ask-index.json`,
        cache: indexCache(root, 'acme.json'),
        name: 'ask-index.json',
        log,
      });
      await writeLlmsFiles({
        pages,
        site: { title: 'Acme Docs', url: 'https://docs.acme.dev' },
        outputs,
        dir: outDir,
        label: 'dist',
        log,
        // Link each page to its .md copy, in the HTML the framework wrote as guide/index.html.
        linkPages: 'directory',
      });
    },
  };
}
```

The plugin's options are `IndexOptions` (`embedding`, `dimensions`, `embeddingModel`, `embeddingProviderOptions` and `chunking`, as every plugin takes them) and whatever else it needs. The sections below go through each step.

## Read the pages the framework built

`readBuiltHtml(outDir, path)` reads the HTML the build wrote for a path, as `guide/index.html` or `guide.html`, whichever exists; pass `'file'` as the third argument when the framework writes `guide.html` first.

`loadBuiltPage(html, options)` turns it into the document to index and, with `markdown: true`, the page for the llms files. Give it:

- `url`: the URL the site serves the page at, with the base path, as citations will link to it.
- `contentSelector`: the part of the page that is its content. The default, `main`, reads `<main>`, then the page's `<article>`s, then `<body>`. A selector such as `.vp-doc` or `[data-pagefind-body]` reads only what it matches, and a page where it matches nothing is skipped. Before 0.14 it was `root`, which still works until 1.0.
- `ignoreSelector`: what to leave out of `contentSelector`, such as `.header-anchor, .toc`. Navigation, buttons, forms and footers are left out anyway. Before 0.14 it was `ignore`.
- `titleSuffix`: what the framework adds to each `<title>`, such as `' | Acme Docs'`, taken off a title read from it. A title from the page's `<h1>` has none.

It returns `null` for a page with no content, or with `<meta name="robots" content="noindex">`, and such a page is not indexed. Skip the framework's 404 page yourself. `excluder(options.exclude)` gives the plugins' `exclude` option: path prefixes, each with the paths under it.

## Write the index

`buildEmbedding(options, log)` gives the embedding model the options name, as the other plugins choose it: `embeddingModel` or `embedding` when set, else OpenAI's `text-embedding-3-small` at 512 dimensions when `OPENAI_API_KEY` is set at build time, the same model through AI Gateway when only `AI_GATEWAY_API_KEY` is, and else a keyword-only index, with a warning. A key that is set but cannot be used fails the build. `checkIndexOptions(options)` throws on options that contradict each other; call it where the framework first hands you the options.

Before it, `checkOptions(name, rules, options)` fails on an option that is misspelled, or not one of yours, and names the nearest that is (`embeding is not an option. Did you mean embedding?`), and on a value of the wrong kind. Make the rules with `optionRules.shape`, one rule per option, from `optionRules.index` for the options every plugin takes and the others `optionRules` has, as the minimal integration above does. Both are experimental: they may still change in a minor version before 1.0.

`writeSiteIndex` builds the index and writes it to `file`. `cache` is where it keeps a copy for the next build, so unchanged pages reuse their vectors instead of being embedded again: `indexCache(root, name)` puts it in `node_modules/.cache/ondocs`, which Vercel and Netlify keep between builds. Give each index its own cache file, one per locale or plugin instance. The log line says how many pages and chunks it indexed, and how many it embedded and reused.

A site with locales gets an index per locale: group the pages by their locale's path prefix, and write each group to `<outDir>/<locale>/ask-index.json`, as the Astro integration does. The dialog sends the page's locale with each question, and the endpoint answers from that locale's index.

## Write llms.txt and the Markdown pages

`llmsOutputs(options.llmsTxt)` reads the plugins' `llmsTxt` option: all three files by default, none for `false`, and `{ full: false }` to turn one off. `writeLlmsFiles` writes them into `dir`, the build output for `site.base`, from the pages `loadBuiltPage` returned. It never replaces a file the build already has, from the site's static files or another plugin, and says so. Pass `owners` to leave a file to another plugin that writes it, by name: the Docusaurus plugin leaves `llms.txt` to docusaurus-plugin-llms when the site has it.

With `linkPages`, it also links each page to its copy, with `<link rel="alternate" type="text/markdown">` in the `<head>` of the page's HTML in `dir`. Set it to how the framework writes pages, as `readBuiltHtml` reads them: `'directory'` for `guide/index.html`, `'file'` for `guide.html`. A URL ending in `/` or `.html` names its file itself. The page's HTML is replaced in one step, so another plugin reading it at the same time reads all of it.

## Add the launcher

Every page needs the launcher, the "Ask AI" button and the ⌘I shortcut, which loads the dialog the first time it is wanted. How you add it depends on how the framework builds its pages:

- **A framework that bundles each page's scripts**, with Vite, Rollup or webpack: `launcherScript` returns the source of a module that mounts the launcher with `mountAskDialog` from `ondocs/embed/standalone`, about 1.5 KB gzipped, with the dialog in a chunk of its own. React, Radix and cmdk are built into that chunk, so the site installs none of them. Serve it as a virtual module every page imports, with `LAUNCHER_STYLESHEETS`, the dialog's and the launcher's stylesheets. Give it `locales` and `base`, and each page under a locale's path prefix gets that locale's labels and sends its locale; with `spa: true`, for a site that moves between pages without loading them, it mounts again when a navigation changes `<html lang>`. The Astro integration and the VitePress plugin do this. With Vite, they also add `quietUseClient()` to its plugins, for a site that bundles `ondocs/react` itself: it blanks the `"use client"` directives that Radix and cmdk start with, so the build does not warn about each one.
- **A React framework**: render `AskDialog` from `ondocs/react` with `launcher`, as in the [Next.js guide](./nextjs.md). The Docusaurus plugin's theme does the same.
- **Anything else**: the [script tag](./script-tag.md), which brings the dialog with its own copy of React.

`dialogEndpoint(options.endpoint)` is where the dialog posts: the `ASK_ENDPOINT` environment variable when it is set, so `ASK_ENDPOINT=http://localhost:8787/api/ask` points any site at [`ondocs dev`](./local-development.md), else the option, else `/api/ask`.

While the framework's dev server runs, `hintDevEndpoint(endpoint, 'acme dev', log)` says once how to get answers from `ondocs dev`, when the dialog posts to a path the dev server does not serve. `warnMissingDialogPeers(log)` is for a dialog that renders with the site's React, as the Docusaurus plugin's does: it warns, naming what to install, when the site lacks a package the dialog renders with, before the bundler fails on it. A launcher from `launcherScript` needs none of them.

## Point agents at the MCP endpoint

The plugins take an `mcp` option, the site's [MCP endpoint](./mcp.md), as a URL or a path on the site. `resolveMcp(options.mcp, siteUrl, siteTitle, where)` makes it absolute and names it, and its URL goes into `llms.txt` as `site.mcp`, so agents that read the file find it. `mcpInstallLinks` from `ondocs` gives the "Add to Cursor / VS Code / Claude" links for a page that shows them.

The endpoint itself is a function next to the site, as for any other static site: [`ondocs init`](./deployment.md) writes it for the host, and it reads the index the build wrote.

## What ondocs/integration exports

| Export                                       | What it does                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `readBuiltHtml`, `loadBuiltPage`             | Read a built page, and turn it into a document to index and a page for the llms files |
| `excluder`                                   | The `exclude` option: whether a path is under one of its prefixes                     |
| `checkIndexOptions`, `buildEmbedding`        | Check the index options, and build the embedding model they name                      |
| `checkOptions`, `optionRules`                | Check the options as the config gives them (experimental)                             |
| `writeSiteIndex`, `indexCache`               | Write the index, reusing the vectors cached from the previous build                   |
| `llmsOutputs`, `writeLlmsFiles`              | Read the `llmsTxt` option, and write `llms.txt`, `llms-full.txt` and the `.md` pages  |
| `launcherScript`, `LAUNCHER_STYLESHEETS`     | The module and the stylesheets that add the launcher to every page                    |
| `quietUseClient`                             | A Vite plugin that keeps the dialog's dependencies from warning about `"use client"`  |
| `dialogEndpoint`, `hintDevEndpoint`          | Where the dialog posts, and how to get answers in development                         |
| `warnMissingDialogPeers`                     | Name the dialog's missing packages                                                    |
| `resolveMcp`                                 | The `mcp` option as an absolute URL and a name                                        |
| `consoleLogger`                              | A logger with the `[ondocs]` prefix, for a framework that gives plugins none          |
| `IndexOptions`, `LlmsTxtOption`, `McpOption` | The options every plugin takes, as types                                              |

It also exports the types its functions take and return, such as `SourceDocument`, `LlmsPage` and `OndocsDialogOptions`, so an integration needs no other import.
