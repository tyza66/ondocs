import { existsSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';

import type { EmbeddingModel } from 'ai';

import { version } from '../../package.json' with { type: 'json' };
import { buildIndex, checkIndex, embeddingModelId, type EmbeddingProviderOptions } from '../build';
import { DEFAULT_CHUNKING } from '../chunk';
import type { AskIndexFile } from '../index-file';
import { embeddingFromSpec, EmbeddingSpecError } from '../node/embedding';
import { nextRouting, type NextRouting } from '../node/next';
import { checkIndexOptions, DEFAULT_DIMENSIONS } from '../integration/build';
import { llmsOutputs, writeLlmsFiles } from '../integration/llms';
import { checkOptions, optionRules } from '../integration/options';
import { markdownCopies, resolveMarkdownLinks, rootedPath, type LlmsPage } from '../llms';
import { dev } from './dev';
import { evalCommand } from './eval';
import { init } from './init';
import {
  detectFramework,
  frameworkUrl,
  loadDirectory,
  readIndexFile,
  writeIndexFile,
  type AskConfig,
  type Framework,
} from '../node';
import type { ChunkingOptions, SourceDocument } from '../types';

export interface CliIO {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  cwd: string;
  env: Record<string, string | undefined>;
  /** Stops `ondocs dev`. Default: Ctrl+C. */
  signal?: AbortSignal;
  /** Asks the person at the terminal, for `ondocs init`. Absent when stdin is not a TTY. */
  prompt?: (question: string) => Promise<string>;
}

const USAGE = `Usage: ondocs index [dir] [options]
       ondocs init [options]  Write the endpoint for your host (ondocs init --help)
       ondocs dev [options]   Serve the ask endpoint locally (ondocs dev --help)
       ondocs eval <file>     Score retrieval against known answers (ondocs eval --help)

Builds a static retrieval index from the Markdown, MDX and HTML files in <dir>.

Options:
  -o, --out <file>             Index file (default: ask-index.json)
      --check                  Exit 1 if the index is stale. Never calls a model.
      --base-url <url>         URL prefix for pages (default: /)
  -e, --embedding <spec>       openai:<model>    @ai-sdk/openai, needs OPENAI_API_KEY
                               workers-ai:@cf/<model>  Workers AI, needs CLOUDFLARE_ACCOUNT_ID
                                                 and CLOUDFLARE_API_TOKEN
                               <provider>/<model> AI Gateway, needs AI_GATEWAY_API_KEY
                               mock[:<dims>]     deterministic, offline
                               none              keyword-only index
                               (default: openai:text-embedding-3-small at 512 dimensions,
                               if OPENAI_API_KEY is set)
      --dimensions <n>         Vector size, for models that support it (default: 512 for
                               the default model, the model's own for one you name).
                               With --check, the size the index must have.
      --chunk-size <chars>     Max characters per chunk (default: ${String(DEFAULT_CHUNKING.maxChars)})
      --chunk-overlap <chars>  Characters shared by consecutive chunks (default: ${String(DEFAULT_CHUNKING.overlap)})
      --ignore <glob>          Skip matching files; repeatable
      --framework <name>       How file paths become URLs: docusaurus | starlight | next | none
                               (default: detected from the framework config above <dir>)
      --clean-urls             Drop .html from HTML files' URLs, for hosts that serve
                               page.html at /page (default: keep it)
      --llms-txt <dir>         Also write llms.txt, llms-full.txt and a .md copy of each page
                               into <dir>, the folder your site serves at its root
      --no-llms-index, --no-llms-full, --no-llms-markdown
                               Leave out llms.txt, llms-full.txt or the .md copies
      --llms-title <text>      The site's name, the H1 of llms.txt (default: package.json's name)
      --llms-description <text>  The summary under it
      --site-url <url>         The site's origin, to link pages absolutely in llms.txt
      --mcp-url <url>          The site's MCP endpoint, for llms.txt to point agents at
  -c, --config <file>          Module whose default export is an AskConfig
  -q, --quiet                  Only print errors
  -h, --help                   Show this help
  -v, --version                Show the version

.env and .env.local in the working directory are loaded first, without overriding variables
that are already set.`;

class UsageError extends Error {}

const FRAMEWORKS: readonly (Framework | 'auto')[] = [
  'auto',
  'docusaurus',
  'starlight',
  'next',
  'none',
];
const FRAMEWORK_NAMES: Record<Exclude<Framework, 'none' | 'next'> | NextRouting, string> = {
  docusaurus: 'Docusaurus',
  starlight: 'Starlight',
  app: 'Next.js App Router (page.mdx)',
  fumadocs: 'Fumadocs',
  nextra: 'Nextra',
  content: 'Next.js-style (route groups)',
};

interface Flags {
  llms?: {
    dir: string;
    index?: boolean;
    full?: boolean;
    markdown?: boolean;
    title?: string;
    description?: string;
    siteUrl?: string;
    mcp?: string;
  };
  out: string;
  check: boolean;
  baseUrl?: string;
  embedding?: string;
  dimensions?: number;
  chunking: ChunkingOptions;
  ignore: string[];
  framework?: Framework | 'auto';
  cleanUrls: boolean;
  config?: string;
  quiet: boolean;
}

function integerFlag(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new UsageError(`--${name} must be a non-negative integer.`);
  }
  return parsed;
}

function loadEnvFiles(io: CliIO): void {
  for (const name of ['.env.local', '.env']) {
    const path = resolve(io.cwd, name);
    if (!existsSync(path)) continue;
    for (const [key, value] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
      io.env[key] ??= value;
    }
  }
}

interface EmbeddingChoice {
  /** `undefined`: no opinion (check mode without a flag). `null`: keyword-only. */
  model: EmbeddingModel | null | undefined;
  providerOptions?: EmbeddingProviderOptions;
  dimensions?: number;
}

async function resolveEmbedding(
  flags: Flags,
  config: AskConfig,
  io: CliIO,
  mode: 'build' | 'check',
): Promise<EmbeddingChoice> {
  const choice = await chooseEmbedding(flags, config, io, mode);
  const dims = flags.dimensions;
  if (dims === undefined || choice.dimensions !== undefined) return choice;
  // A check compares the size on its own, whatever the model. A build cannot apply it to a
  // config's model (or none), and silently ignoring it would build the wrong vectors.
  if (mode === 'check') return { ...choice, dimensions: dims };
  throw new UsageError(
    '--dimensions applies to the model given with --embedding. With a config module, set ' +
      'embeddingProviderOptions there instead.',
  );
}

async function chooseEmbedding(
  flags: Flags,
  config: AskConfig,
  io: CliIO,
  mode: 'build' | 'check',
): Promise<EmbeddingChoice> {
  // The flags win over the config module's `embedding` and `dimensions`.
  const dims = flags.dimensions ?? config.dimensions;
  const spec = flags.embedding ?? config.embedding;
  const name =
    flags.embedding === undefined
      ? `the config's embedding: '${String(spec)}'`
      : `--embedding ${String(spec)}`;

  if (spec === undefined) {
    if (config.embeddingModel !== undefined) {
      return {
        model: config.embeddingModel,
        ...(config.embeddingProviderOptions
          ? { providerOptions: config.embeddingProviderOptions }
          : {}),
      };
    }
    if (mode === 'check') return { model: undefined };
    // The default model at the plugins' default size, a third of its own, unless --dimensions
    // gives one. A model named with --embedding keeps its own size, as in the plugins.
    const size = dims ?? DEFAULT_DIMENSIONS;
    if (io.env.OPENAI_API_KEY) {
      const model = 'openai:text-embedding-3-small';
      return resolveSpec(model, size, io, mode, `--embedding ${model}`);
    }
    if (io.env.AI_GATEWAY_API_KEY) {
      const model = 'openai/text-embedding-3-small';
      return resolveSpec(model, size, io, mode, `--embedding ${model}`);
    }
    throw new UsageError(
      'No embedding model. Set OPENAI_API_KEY or pass --embedding <spec>. To try it without a ' +
        'key, use --embedding mock (offline, deterministic); --embedding none builds a ' +
        'keyword-only index.',
    );
  }
  return resolveSpec(spec, dims, io, mode, name);
}

async function resolveSpec(
  spec: string,
  dims: number | undefined,
  io: CliIO,
  mode: 'build' | 'check',
  name: string,
): Promise<EmbeddingChoice> {
  try {
    return await embeddingFromSpec(spec, {
      ...(dims ? { dimensions: dims } : {}),
      env: io.env,
      mode,
      name,
    });
  } catch (error) {
    if (error instanceof EmbeddingSpecError) throw new UsageError(error.message);
    throw error;
  }
}

const { anything, boolean, func, listOf, number, object, oneOf, shape, string } = optionRules;

/** A config module's options, checked as it gives them. */
const CONFIG_RULES = shape<AskConfig>({
  embedding: string,
  dimensions: number,
  embeddingModel: anything,
  embeddingProviderOptions: object,
  chunking: optionRules.chunking,
  baseUrl: string,
  ignore: listOf(string, "a list of globs, such as ['drafts/**']"),
  // Checked with the flag, with its message.
  framework: anything,
  cleanUrls: boolean,
  documents: oneOf(listOf(object, 'a list of documents'), func),
  llmsTxt: shape<NonNullable<AskConfig['llmsTxt']>>({
    title: string,
    description: string,
    siteUrl: string,
    mcp: string,
    index: boolean,
    full: boolean,
    markdown: boolean,
  }),
});

async function loadConfig(path: string | undefined, io: CliIO): Promise<AskConfig> {
  if (!path) return {};
  const absolute = resolve(io.cwd, path);
  if (!existsSync(absolute)) throw new UsageError(`Config file not found: ${path}`);
  const module = (await import(pathToFileURL(absolute).href)) as { default?: unknown };
  const config = module.default;
  if (!config || typeof config !== 'object') {
    throw new UsageError(`${path} must export a config object as its default export.`);
  }
  try {
    checkOptions(path, CONFIG_RULES, config);
    checkIndexOptions(config);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  return config;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function parseFlags(args: string[]): {
  command?: string;
  dir?: string;
  flags: Flags;
  help: boolean;
  version: boolean;
} {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      allowNegative: true,
      strict: true,
      options: {
        out: { type: 'string', short: 'o' },
        check: { type: 'boolean' },
        'base-url': { type: 'string' },
        embedding: { type: 'string', short: 'e' },
        dimensions: { type: 'string' },
        'chunk-size': { type: 'string' },
        'chunk-overlap': { type: 'string' },
        ignore: { type: 'string', multiple: true },
        framework: { type: 'string' },
        'clean-urls': { type: 'boolean' },
        'llms-txt': { type: 'string' },
        'llms-index': { type: 'boolean' },
        'llms-full': { type: 'boolean' },
        'llms-markdown': { type: 'boolean' },
        'llms-title': { type: 'string' },
        'llms-description': { type: 'string' },
        'site-url': { type: 'string' },
        'mcp-url': { type: 'string' },
        config: { type: 'string', short: 'c' },
        quiet: { type: 'boolean', short: 'q' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  if (positionals.length > 2)
    throw new UsageError(`Unexpected argument: ${String(positionals[2])}`);
  const maxChars = integerFlag('chunk-size', values['chunk-size']);
  const overlap = integerFlag('chunk-overlap', values['chunk-overlap']);
  const dimensions = integerFlag('dimensions', values.dimensions);
  const framework = values.framework;
  if (framework !== undefined && !FRAMEWORKS.includes(framework as Framework | 'auto')) {
    throw new UsageError(`--framework must be one of ${FRAMEWORKS.join(', ')}.`);
  }
  for (const name of ['site-url', 'mcp-url'] as const) {
    const value = values[name];
    if (value !== undefined && !/^https?:\/\/[^/]/.test(value)) {
      throw new UsageError(`--${name} must be an absolute http(s) URL (got ${value}).`);
    }
  }
  const llmsOnly = (
    [
      'llms-index',
      'llms-full',
      'llms-markdown',
      'llms-title',
      'llms-description',
      'site-url',
      'mcp-url',
    ] as const
  ).find((name) => values[name] !== undefined);
  if (llmsOnly && values['llms-txt'] === undefined) {
    throw new UsageError(`--${llmsOnly} goes with --llms-txt <dir>.`);
  }
  return {
    ...(positionals[0] ? { command: positionals[0] } : {}),
    ...(positionals[1] ? { dir: positionals[1] } : {}),
    help: values.help ?? false,
    version: values.version ?? false,
    flags: {
      out: values.out ?? 'ask-index.json',
      check: values.check ?? false,
      ...(values['base-url'] ? { baseUrl: values['base-url'] } : {}),
      ...(values.embedding ? { embedding: values.embedding } : {}),
      ...(dimensions ? { dimensions } : {}),
      chunking: {
        ...(maxChars !== undefined ? { maxChars } : {}),
        ...(overlap !== undefined ? { overlap } : {}),
      },
      ignore: values.ignore ?? [],
      ...(framework ? { framework: framework as Framework | 'auto' } : {}),
      cleanUrls: values['clean-urls'] ?? false,
      ...(values.config ? { config: values.config } : {}),
      quiet: values.quiet ?? false,
      ...(values['llms-txt'] === undefined
        ? {}
        : {
            llms: {
              dir: values['llms-txt'],
              ...(values['llms-index'] === undefined ? {} : { index: values['llms-index'] }),
              ...(values['llms-full'] === undefined ? {} : { full: values['llms-full'] }),
              ...(values['llms-markdown'] === undefined
                ? {}
                : { markdown: values['llms-markdown'] }),
              ...(values['llms-title'] ? { title: values['llms-title'] } : {}),
              ...(values['llms-description'] ? { description: values['llms-description'] } : {}),
              ...(values['site-url'] ? { siteUrl: values['site-url'] } : {}),
              ...(values['mcp-url'] ? { mcp: values['mcp-url'] } : {}),
            },
          }),
    },
  };
}

/**
 * `--llms-txt <dir>`: the pages again, read as Markdown to keep their links, and written as
 * `llms.txt`, `llms-full.txt` and a `.md` per page into `dir`, replacing what is there.
 */
async function writeLlms(
  llms: NonNullable<Flags['llms']>,
  config: AskConfig,
  directory: { root: string; options: Parameters<typeof loadDirectory>[1] } | undefined,
  indexed: readonly SourceDocument[],
  io: CliIO,
  log: (line: string) => void,
): Promise<void> {
  const settings = { ...config.llmsTxt, ...llms };
  const fromDirectory = directory
    ? await loadDirectory(directory.root, { ...directory.options, markdown: true })
    : [];
  const ids = new Set(fromDirectory.map((document) => document.id));
  // Documents from the config module are written as they were given.
  const documents = [...fromDirectory, ...indexed.filter((document) => !ids.has(document.id))];
  const pages: LlmsPage[] = documents.map((document) => ({
    url: document.url,
    title: document.title,
    ...(document.description ? { description: document.description } : {}),
    content: document.content,
  }));
  const outputs = llmsOutputs(settings);
  const dir = resolve(io.cwd, llms.dir);
  const label = relative(io.cwd, dir) || '.';
  // How a Next.js site routes the folder, which its pages' URLs follow, and so their links.
  const routing =
    directory?.options?.framework === 'next' ? await nextRouting(directory.root) : undefined;
  await writeLlmsFiles({
    pages: directory
      ? withResolvedLinks(pages, documents, ids, directory.options, routing, outputs)
      : pages,
    site: {
      title: settings.title ?? packageName(io.cwd) ?? 'Docs',
      ...(settings.description ? { description: settings.description } : {}),
      ...(settings.siteUrl ? { url: settings.siteUrl } : {}),
      ...(settings.mcp ? { mcp: settings.mcp } : {}),
    },
    outputs,
    dir,
    label,
    log: {
      info: (line) => {
        log(`✓ ${line}`);
      },
      warn: (line) => {
        log(`! ${line}`);
      },
    },
    overwrite: true,
  });
}

/**
 * The pages, with the relative links and images of those read from Markdown files resolved, so
 * they work from the pages' `.md` copies and from `llms-full.txt`, as they do from the files. A
 * link to another page's file goes to that page's copy, or to the page when there are no copies.
 * HTML files' links are resolved as they are read.
 */
function withResolvedLinks(
  pages: readonly LlmsPage[],
  documents: readonly SourceDocument[],
  files: ReadonlySet<string>,
  options: Parameters<typeof loadDirectory>[1],
  routing: NextRouting | undefined,
  outputs: { markdown: boolean },
): LlmsPage[] {
  const copies = outputs.markdown ? markdownCopies(pages) : new Map<LlmsPage, string>();
  const hrefs = new Map<string, string>();
  documents.forEach((document, i) => {
    const page = pages[i];
    if (!page || !files.has(document.id)) return;
    const copy = copies.get(page);
    const rooted = copy === undefined ? undefined : encodeURI(rootedPath(copy));
    hrefs.set(
      document.id,
      rooted === undefined
        ? document.url
        : /^https?:\/\//i.test(document.url)
          ? new URL(rooted, document.url).href
          : rooted,
    );
  });
  const framework = options?.framework === 'auto' ? 'none' : (options?.framework ?? 'none');
  return pages.map((page, i) => {
    const document = documents[i];
    if (!document || !files.has(document.id) || !/\.(?:mdx?|markdown)$/i.test(document.id)) {
      return page;
    }
    // The URL of the file's folder: where its folder's index page is (`page.mdx` in an App Router
    // folder), with a trailing slash, by the rules its pages' URLs follow.
    const index = routing === 'app' ? 'page.mdx' : 'index.md';
    const folder = frameworkUrl(
      `${document.id.replace(/[^/]*$/, '')}${index}`,
      {},
      framework,
      options?.baseUrl,
      routing ? { routing } : {},
    ).replace(/\/*$/, '/');
    return {
      ...page,
      content: resolveMarkdownLinks(page.content, document.id, folder, (file) => hrefs.get(file)),
    };
  });
}

/** The `name` in `package.json` in `cwd`, for a site title when none is given. */
function packageName(cwd: string): string | undefined {
  try {
    const name: unknown = (
      JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8')) as { name?: unknown }
    ).name;
    return typeof name === 'string' && name ? name : undefined;
  } catch {
    return undefined;
  }
}

/** Runs the CLI. Returns the exit code: 0 success, 1 failure or stale index, 2 usage error. */
export async function main(args: string[], io: CliIO): Promise<number> {
  // No .env files here: init reads no secrets.
  if (args[0] === 'init') return init(args.slice(1), io);
  if (args[0] === 'dev') {
    loadEnvFiles(io);
    return dev(args.slice(1), io);
  }
  if (args[0] === 'eval') {
    loadEnvFiles(io);
    return evalCommand(args.slice(1), io);
  }
  try {
    const { command, dir, flags, help, version: showVersion } = parseFlags(args);
    if (showVersion) {
      io.stdout(version);
      return 0;
    }
    if (help || !command) {
      io.stdout(USAGE);
      return command || help ? 0 : 2;
    }
    if (command !== 'index') throw new UsageError(`Unknown command "${command}".\n\n${USAGE}`);

    loadEnvFiles(io);
    const config = await loadConfig(flags.config, io);
    const log = (line: string): void => {
      if (!flags.quiet) io.stdout(line);
    };

    const documents: SourceDocument[] = [];
    let directory: { root: string; options: Parameters<typeof loadDirectory>[1] } | undefined;
    if (dir) {
      const root = resolve(io.cwd, dir);
      if (!existsSync(root) || !statSync(root).isDirectory()) {
        throw new UsageError(`Not a directory: ${dir}`);
      }
      const baseUrl = flags.baseUrl ?? config.baseUrl;
      const requested = flags.framework ?? config.framework ?? 'auto';
      if (!FRAMEWORKS.includes(requested)) {
        throw new UsageError(`framework must be one of ${FRAMEWORKS.join(', ')}.`);
      }
      const framework = requested === 'auto' ? await detectFramework(root) : requested;
      if (requested === 'auto' && framework !== 'none') {
        const name = FRAMEWORK_NAMES[framework === 'next' ? await nextRouting(root) : framework];
        log(`Reading ${dir} with ${name} URLs (--framework none to turn off)`);
      }
      if (framework === 'docusaurus' && !baseUrl) {
        log(
          'Docusaurus serves docs under /docs unless routeBasePath says otherwise: pass --base-url /docs',
        );
      }
      directory = {
        root,
        options: {
          ...(baseUrl ? { baseUrl } : {}),
          framework,
          cleanUrls: flags.cleanUrls || (config.cleanUrls ?? false),
          ignore: [...(config.ignore ?? []), ...flags.ignore],
        },
      };
      documents.push(...(await loadDirectory(root, directory.options)));
    }
    if (config.documents) {
      const extra =
        typeof config.documents === 'function' ? await config.documents() : config.documents;
      documents.push(...extra);
    }
    if (!dir && !config.documents) throw new UsageError(`Missing <dir>.\n\n${USAGE}`);

    const chunking: ChunkingOptions = { ...config.chunking, ...flags.chunking };
    const out = resolve(io.cwd, flags.out);
    // Paths inside the working directory print relative; anything else prints absolute.
    const relativeOut = relative(io.cwd, out);
    const outLabel = relativeOut && !relativeOut.startsWith('..') ? relativeOut : out;

    if (flags.check) {
      const existing = await readIndexFile(out);
      if (!existing) {
        io.stderr(`✗ ${outLabel} does not exist. Run \`ondocs index\` without --check.`);
        return 1;
      }
      const embedding = await resolveEmbedding(flags, config, io, 'check');
      const result = await checkIndex({
        documents,
        index: existing,
        // Options not given again default to what the index was built with.
        chunking: { ...existing.chunking, ...chunking },
        ...(embedding.model !== undefined ? { embeddingModel: embedding.model } : {}),
        ...(embedding.dimensions ? { embeddingDimensions: embedding.dimensions } : {}),
        ...(embedding.providerOptions
          ? { embeddingProviderOptions: embedding.providerOptions }
          : {}),
      });
      if (result.upToDate) {
        log(`✓ ${outLabel} is up to date (${String(existing.chunks.length)} chunks).`);
        return 0;
      }
      io.stderr(`✗ ${outLabel} is stale.`);
      for (const problem of result.problems) io.stderr(`  ${problem}`);
      const sample = (label: string, ids: string[]): void => {
        if (ids.length === 0) return;
        const more = ids.length > 5 ? ` (+${String(ids.length - 5)} more)` : '';
        io.stderr(`  ${label}: ${ids.slice(0, 5).join(', ')}${more}`);
      };
      sample('added', result.added);
      sample('changed', result.changed);
      sample('removed', result.removed);
      io.stderr('  Rebuild it with `ondocs index` and commit the result.');
      return 1;
    }

    const embedding = await resolveEmbedding(flags, config, io, 'build');
    let previous: AskIndexFile | null = null;
    try {
      previous = await readIndexFile(out);
    } catch {
      log(`! Ignoring unreadable ${outLabel}; rebuilding from scratch.`);
    }
    const model = embedding.model ?? null;
    log(
      `→ ${String(documents.length)} documents, embedding with ${model ? embeddingModelId(model) : 'none (keyword-only)'}`,
    );
    const started = performance.now();
    const { index, stats } = await buildIndex({
      documents,
      embeddingModel: model,
      ...(embedding.providerOptions ? { embeddingProviderOptions: embedding.providerOptions } : {}),
      chunking,
      previous,
      onProgress: ({ embedded, total }) => {
        log(`  embedded ${String(embedded)}/${String(total)} chunks`);
      },
    });
    await writeIndexFile(out, index);
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    const reuse = index.embedding
      ? `, ${String(stats.embedded)} embedded, ${String(stats.reused)} reused`
      : '';
    log(
      `✓ ${String(stats.chunks)} chunks${reuse} → ${outLabel} (${formatBytes(statSync(out).size)}, ${seconds}s)`,
    );
    if (flags.llms) {
      await writeLlms(flags.llms, config, directory, documents, io, log);
    }
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(error.message);
      return 2;
    }
    io.stderr(`✗ ${error instanceof Error ? error.message : String(error)}`);
    if (io.env.DEBUG && error instanceof Error && error.stack) io.stderr(error.stack);
    return 1;
  }
}
