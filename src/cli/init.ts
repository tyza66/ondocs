// `ondocs init`: writes the ask endpoint, and the MCP endpoint, for a docs site and the host
// it deploys to. Node.js only. It reads the site's config files to tell the framework and the host
// apart, never an .env file or a credential, and it deploys nothing.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

import { version } from '../../package.json' with { type: 'json' };
import { REMOVED_IN } from '../deprecation';
import {
  cloudflarePagesFiles,
  cloudflareWorkerFiles,
  netlifyConfig,
  netlifyFiles,
  nextFiles,
  STANDALONE_DIR,
  standaloneWorkerFiles,
  vercelConfig,
  vercelFiles,
  WORKER_MODULE,
  WORKERS_AI_EMBEDDING,
  workerName,
  type WorkerProvider,
  type WorkerVersions,
  type CloudflareMode,
  type GeneratedFile,
  type Host,
  type TemplateSite,
} from './init-templates';
import type { CliIO } from './main';

export const INIT_USAGE = `Usage: ondocs init [options]

Writes the ask endpoint (POST /api/ask) and the MCP endpoint (/api/mcp) for your docs site and
the host it deploys to, with a rate limit, a daily budget, CORS where the endpoint is on another
origin, and the index bundled the way the host needs. It detects the site (Docusaurus, Starlight,
Astro, Next.js or a static site) and the host (Vercel, Netlify, Cloudflare or GitHub Pages), and
prints what it wrote and the environment variables to set. It never deploys anything and never
reads secrets. Run it again any time: unchanged files stay as they are, and it asks before it
overwrites a file that differs.

Options:
      --host <name>        vercel | netlify | cloudflare | github-pages (default: detected, else
                           asked). github-pages also suits any other static host: the endpoint is
                           a Cloudflare Worker of its own.
      --provider <name>    For github-pages: workers-ai (the default; no API key) or openai
      --site-url <url>     The site's public URL with its base path, for github-pages
                           (default: from the site's config)
      --site-name <text>   The site's name, for the model's instructions (default: its title)
      --build-dir <dir>    A static site's build output folder (default: detected)
      --out <dir>          --build-dir's name before 0.14, which works until 1.0
      --no-mcp             Write the ask endpoint only
      --dry-run            Print what it would write, and write nothing
  -y, --yes                Overwrite files that differ without asking
  -h, --help               Show this help`;

class InitError extends Error {}

const HOSTS: readonly Host[] = ['vercel', 'netlify', 'cloudflare', 'github-pages'];
const HOST_LABELS: Record<Host, string> = {
  vercel: 'Vercel',
  netlify: 'Netlify',
  cloudflare: 'Cloudflare',
  'github-pages': 'GitHub Pages',
};

type SiteKind = 'docusaurus' | 'starlight' | 'astro' | 'vitepress' | 'next' | 'static';

/** What init found out about the site. */
interface Site extends TemplateSite {
  kind: SiteKind;
  /** The framework or generator, for messages: "Docusaurus", "Hugo". */
  label: string;
  /** Astro's SSR adapter package, when the site has one. */
  adapter?: string;
  /** VitePress's config file: `.vitepress/config.mts` or `docs/.vitepress/config.mts`. */
  config?: string;
  /** Next.js's app folder: `app` or `src/app`. */
  appDir?: string;
  /** For a site the CLI indexes (Next.js, static generators): the command that builds the index. */
  indexCommand?: string;
  /** The config file that adds ondocs's plugin, when it already does: `docusaurus.config.ts`. */
  plugin?: string;
  /** Whether that config gives the plugin an `mcp` option already. */
  pluginMcp?: boolean;
  /**
   * Whether the config sets the site's URL, which the plugin resolves a path in `mcp` against: as
   * a literal or as an expression, such as `process.env.SITE_URL ?? 'https://…'`.
   */
  urlInConfig?: boolean;
}

interface PackageJson {
  name?: unknown;
  homepage?: unknown;
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

/** The project: its root, its package.json and its dependencies. */
interface Project {
  root: string;
  pkg: PackageJson | null;
  deps: Set<string>;
  read: (path: string) => string | null;
  has: (path: string) => boolean;
}

function project(root: string): Project {
  const read = (path: string): string | null => {
    try {
      return readFileSync(join(root, path), 'utf8');
    } catch {
      return null;
    }
  };
  let pkg: PackageJson | null = null;
  try {
    const parsed: unknown = JSON.parse(read('package.json') ?? 'null');
    if (parsed && typeof parsed === 'object') pkg = parsed;
  } catch {
    // Not a Node project, or a broken package.json: detect from the other files.
  }
  const deps = new Set([
    ...Object.keys(pkg?.dependencies ?? {}),
    ...Object.keys(pkg?.devDependencies ?? {}),
  ]);
  return { root, pkg, deps, read, has: (path) => existsSync(join(root, path)) };
}

/** The first of `names` that exists in the project. */
const first = (p: Project, names: readonly string[]): string | undefined =>
  names.find((name) => p.has(name));

const configNames = (base: string) =>
  ['ts', 'mts', 'js', 'mjs', 'cjs'].map((extension) => `${base}.${extension}`);

/** A string-valued key from a JS/TS config's source, such as `url: 'https://…'`. */
function configString(source: string | null, key: string): string | undefined {
  if (!source) return undefined;
  return new RegExp(`\\b${key}\\s*:\\s*(['"\`])([^'"\`]+)\\1`).exec(source)?.[2];
}

/** A JS/TS config's source without its whole-line `//` comments, where a key can be commented out. */
const uncommented = (source: string | null): string =>
  (source ?? '').replace(/^[ \t]*\/\/.*$/gm, '');

/**
 * Whether a JS/TS config's source sets one of `keys`, to a literal or to an expression, such as
 * `site: process.env.SITE_URL ?? 'https://…'`.
 */
const configSets = (source: string | null, keys: string[]): boolean =>
  new RegExp(`\\b(?:${keys.join('|')})\\s*:`).test(uncommented(source));

/** A key from a YAML or TOML config, such as `site_name: Acme Docs` or `baseURL = "…"`. */
function flatConfigString(source: string | null, key: string): string | undefined {
  if (!source) return undefined;
  const match = new RegExp(
    `^[ \\t]*${key}[ \\t]*[:=][ \\t]*(?:"([^"\\n]*)"|'([^'\\n]*)'|([^#\\n]*))`,
    'm',
  ).exec(source);
  const value = (match?.[1] ?? match?.[2] ?? match?.[3])?.trim();
  return value || undefined;
}

/**
 * The locales of a site other than its default, from its config: Docusaurus's and Astro's
 * `i18n: { defaultLocale, locales: [...] }`, or Starlight's `locales: { root, fr, ... }` (every key
 * but `root`). Read from the source, so a config that builds them in code is not seen.
 */
export function configLocales(source: string | null, starlight: boolean): string[] {
  if (!source) return [];
  const quoted = (text: string) =>
    [...text.matchAll(/['"`]([a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*)['"`]/g)].map((m) => m[1] ?? '');
  if (starlight) {
    const start = /\blocales\s*:\s*\{/.exec(source);
    if (!start) return [];
    // The object's own keys: scan to its closing brace, at depth one.
    let depth = 0;
    const keys: string[] = [];
    for (let i = start.index + start[0].length - 1; i < source.length; i += 1) {
      const char = source[i];
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) break;
      } else if (depth === 1) {
        const rest = source.slice(i);
        const match = /^['"]?([a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*|root)['"]?\s*:/.exec(rest);
        if (match && /[\s,{]/.test(source[i - 1] ?? ' ')) {
          const key = match[1] ?? '';
          if (key && key !== 'root') keys.push(key);
          i += match[0].length - 1;
        }
      }
    }
    return keys;
  }
  const list = /\blocales\s*:\s*\[([^\]]*)\]/.exec(source)?.[1];
  if (!list) return [];
  const defaultLocale = /\bdefaultLocale\s*:\s*['"`]([^'"`]+)['"`]/.exec(source)?.[1];
  return quoted(list).filter((locale) => locale !== defaultLocale);
}

/**
 * A URL and a base path joined: `https://acme.github.io` and `/docs/` give
 * `https://acme.github.io/docs`. A URL whose path already ends with the base keeps it once, as
 * VitePress's `sitemap.hostname` has it on a project site: `https://acme.github.io/docs/` and
 * `/docs/` give the same.
 */
function joinUrl(url: string | undefined, base: string | undefined): string | undefined {
  if (!url || !/^https?:\/\//.test(url)) return undefined;
  const path = (base ?? '').replace(/^\/+|\/+$/g, '');
  const site = url.replace(/\/+$/, '');
  if (!path || site.replace(/^https?:\/\/[^/]*/, '').endsWith(`/${path}`)) return site;
  return `${site}/${path}`;
}

const STATIC_GENERATORS: { label: string; files: string[]; out: string }[] = [
  { label: 'Hugo', files: ['hugo.toml', 'hugo.yaml', 'hugo.json'], out: 'public' },
  { label: 'MkDocs', files: ['mkdocs.yml', 'mkdocs.yaml'], out: 'site' },
  { label: 'Jekyll', files: ['_config.yml', '_config.yaml'], out: '_site' },
  {
    label: 'Eleventy',
    files: [...configNames('eleventy.config'), '.eleventy.js', '.eleventy.cjs'],
    out: '_site',
  },
];

/** Detects the site's framework, where its build writes the index, its name and its URL. */
function detectSite(
  p: Project,
  flags: { buildDir?: string; name?: string; siteUrl?: string },
): Site {
  const packageName = typeof p.pkg?.name === 'string' ? p.pkg.name : undefined;
  const homepage = typeof p.pkg?.homepage === 'string' ? p.pkg.homepage : undefined;
  const named = (title: string | undefined) => flags.name ?? title ?? packageName ?? 'the docs';
  const url = (found: string | undefined) => flags.siteUrl ?? found ?? joinUrl(homepage, '');

  const docusaurus = first(p, configNames('docusaurus.config'));
  if (docusaurus || p.deps.has('@docusaurus/core')) {
    const source = docusaurus ? p.read(docusaurus) : null;
    return withUrl(
      {
        kind: 'docusaurus',
        label: 'Docusaurus',
        name: named(configString(source, 'title')),
        indexFile: 'build/ask-index.json',
        indexPath: '/ask-index.json',
        // Docusaurus needs `url`.
        urlInConfig: true,
        ...localesOf(configLocales(source, false)),
        ...pluginIn(
          docusaurus,
          source,
          /['"`](?:ondocs\/docusaurus|docusaurus-plugin-ondocs)['"`]/,
        ),
      },
      url(joinUrl(configString(source, 'url'), configString(source, 'baseUrl'))),
    );
  }

  const astro = first(p, configNames('astro.config'));
  if (astro || p.deps.has('astro')) {
    const source = astro ? p.read(astro) : null;
    const starlight = p.deps.has('@astrojs/starlight') || !!source?.includes('@astrojs/starlight');
    const adapter =
      [...p.deps].find((dep) =>
        /^@astrojs\/(?:node|vercel|netlify|cloudflare)$|^astro-.*adapter|adapter-/.test(dep),
      ) ?? (/\badapter\s*:/.test(source ?? '') ? 'an adapter' : undefined);
    const outDir = adapter ? 'dist/client' : 'dist';
    return withUrl(
      {
        kind: starlight ? 'starlight' : 'astro',
        label: starlight ? 'Starlight' : 'Astro',
        name: named(configString(source, 'title')),
        indexFile: `${outDir}/ask-index.json`,
        indexPath: '/ask-index.json',
        ...(adapter ? { adapter } : {}),
        ...(configSets(source, ['site']) ? { urlInConfig: true } : {}),
        ...localesOf(configLocales(source, starlight)),
        ...pluginIn(
          astro,
          source,
          starlight
            ? /['"`](?:ondocs\/starlight|starlight-ondocs)['"`]/
            : /['"`]ondocs\/astro['"`]/,
        ),
      },
      url(joinUrl(configString(source, 'site'), configString(source, 'base'))),
    );
  }

  if (first(p, configNames('next.config')) || p.deps.has('next')) {
    const appDir = p.has('src/app') ? 'src/app' : 'app';
    const content = first(p, ['content/docs', 'content', 'docs']) ?? 'content';
    return withUrl(
      {
        kind: 'next',
        label: 'Next.js',
        name: named(undefined),
        indexFile: 'ask-index.json',
        indexPath: '/ask-index.json',
        appDir,
        indexCommand: `npx ondocs index ${content} --base-url /docs`,
      },
      url(undefined),
    );
  }

  // VitePress, in docs/ as `vitepress init` suggests, or at the root: the plugin builds the index.
  const vitepress = first(p, ['docs/.vitepress', '.vitepress']);
  if (vitepress) {
    const config = first(
      p,
      ['mts', 'ts', 'mjs', 'js'].map((extension) => `${vitepress}/config.${extension}`),
    );
    const source = config ? p.read(config) : null;
    return withUrl(
      {
        kind: 'vitepress',
        label: 'VitePress',
        name: named(configString(source, 'title')),
        indexFile: `${vitepress}/dist/ask-index.json`,
        indexPath: '/ask-index.json',
        config: config ?? `${vitepress}/config.mts`,
        // `sitemap.hostname`, or withOndocs's own `siteUrl`.
        ...(configSets(source, ['hostname', 'siteUrl']) ? { urlInConfig: true } : {}),
        ...localesOf(configLocales(source, true)),
        ...pluginIn(config, source, /['"`]ondocs\/vitepress['"`]/),
      },
      url(joinUrl(configString(source, 'hostname'), configString(source, 'base'))),
    );
  }

  const generator = STATIC_GENERATORS.find(({ files }) => files.some((file) => p.has(file)));
  const out = (flags.buildDir ?? generator?.out)?.replace(/^\.\/|\/+$/g, '');
  if (!out) {
    const html = HTML_FOLDERS.find((dir) => hasHtml(p, dir));
    throw new InitError(
      'No Docusaurus, Astro, Next.js, VitePress, Hugo, MkDocs, Jekyll or Eleventy config here. ' +
        (html
          ? `${html}/ has HTML files: if it is the folder the site deploys, run npx ondocs init --build-dir ${html}.`
          : 'Run init in the site’s folder. For plain HTML, pass the folder of its HTML files with --build-dir <dir>, as in npx ondocs init --build-dir public.'),
    );
  }
  const source =
    first(p, generator && 'files' in generator ? generator.files : [])?.toString() ?? null;
  const config = source ? p.read(source) : null;
  const foundUrl =
    flatConfigString(config, 'site_url') ??
    flatConfigString(config, 'baseURL') ??
    joinUrl(flatConfigString(config, 'url'), flatConfigString(config, 'baseurl'));
  return withUrl(
    {
      kind: 'static',
      label: generator?.label ?? 'static',
      name: named(
        flatConfigString(config, 'site_name') ?? flatConfigString(config, 'title') ?? undefined,
      ),
      indexFile: `${out}/ask-index.json`,
      indexPath: '/ask-index.json',
      indexCommand: `npx ondocs index ${out} -o ${out}/ask-index.json`,
    },
    url(foundUrl?.replace(/\/+$/, '')),
  );
}

const withUrl = (site: Site, url: string | undefined): Site => (url ? { ...site, url } : site);

/**
 * `{ plugin: file }` when the config file's source names ondocs's plugin, as `pattern` finds it,
 * with `pluginMcp` when the source sets an `mcp` option too. The plugin's `mcp` is never `false`,
 * so `route: { mcp: false }`, and a commented-out line, are not one.
 */
const pluginIn = (
  file: string | undefined,
  source: string | null,
  pattern: RegExp,
): { plugin?: string; pluginMcp?: boolean } =>
  file && source && pattern.test(source)
    ? {
        plugin: file,
        ...(/\bmcp\s*:(?!\s*false\b)/.test(uncommented(source)) ? { pluginMcp: true } : {}),
      }
    : {};

/** Where a plain HTML site keeps its pages, in the order init looks. */
const HTML_FOLDERS = ['public', 'site', '_site', 'dist', 'build', 'out', 'www'];

/** Whether `dir` in the project holds an HTML file. */
function hasHtml(p: Project, dir: string): boolean {
  try {
    return readdirSync(join(p.root, dir)).some((file) => /\.html?$/i.test(file));
  } catch {
    return false;
  }
}

/**
 * Whether `url` is a template's placeholder rather than a site's address: on a domain kept for
 * examples (example.com, .org and .net, and the .example, .test, .invalid and .localhost
 * domains), localhost, or a host named like `your-docusaurus-site`.
 */
export function placeholderUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    /(?:^|\.)example\.(?:com|org|net)$/.test(host) ||
    /(?:^|\.)(?:example|test|invalid|localhost)$/.test(host) ||
    /^your[-.]/.test(host)
  );
}

const localesOf = (locales: string[]): { locales?: string[] } =>
  locales.length > 0 ? { locales } : {};

/** The wrangler config file, if any. */
const WRANGLER = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];

/** Hosts the project's files point at, in the order they are checked. */
function detectHosts(p: Project): Host[] {
  const hosts: Host[] = [];
  if (p.has('vercel.json') || p.has('.vercel')) hosts.push('vercel');
  if (p.has('netlify.toml') || p.has('.netlify')) hosts.push('netlify');
  if (first(p, WRANGLER)) hosts.push('cloudflare');
  if (deploysToPages(p)) hosts.push('github-pages');
  return hosts;
}

/**
 * A GitHub Pages workflow, or the gh-pages package or a script that runs it. Not a `docusaurus
 * deploy` script: every new Docusaurus site has one, wherever it is hosted.
 */
function deploysToPages(p: Project): boolean {
  const scripts = Object.values(p.pkg?.scripts ?? {}).filter((s) => typeof s === 'string');
  if (p.deps.has('gh-pages') || scripts.some((s) => /\bgh-pages\b/.test(s))) {
    return true;
  }
  const dir = join(p.root, '.github', 'workflows');
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => /\.ya?ml$/.test(file));
  } catch {
    return false;
  }
  return files.some((file) =>
    /actions\/deploy-pages|actions\/upload-pages-artifact|peaceiris\/actions-gh-pages|JamesIves\/github-pages-deploy-action/.test(
      p.read(join('.github', 'workflows', file)) ?? '',
    ),
  );
}

/** Cloudflare Pages (`pages_build_output_dir`, or no wrangler config) or a Worker with assets. */
function cloudflareMode(p: Project): { mode: CloudflareMode; file?: string } {
  const file = first(p, WRANGLER);
  if (!file) return { mode: 'pages' };
  const source = p.read(file) ?? '';
  if (source.includes('pages_build_output_dir')) return { mode: 'pages', file };
  return { mode: 'workers', file };
}

/**
 * The wrangler config with the Worker's entry point and the ASSETS binding added, or why it
 * cannot be edited safely, with what to add by hand.
 */
export function wranglerWorkerConfig(
  file: string,
  source: string,
): { content: string } | { error: string } {
  const main = WORKER_MODULE;
  const byHand = `${file}: set main to "${main}" and the static assets' binding to "ASSETS"`;
  if (file.endsWith('.toml')) {
    const lines = source.split('\n');
    const header = (line: string) => /^\s*\[/.test(line);
    const firstTable = lines.findIndex(header);
    const top = firstTable === -1 ? lines : lines.slice(0, firstTable);
    const mainLine = top.find((line) => /^\s*main\s*=/.test(line));
    if (mainLine && !mainLine.includes(main)) {
      return {
        error: `${file} has its own entry point (${mainLine.trim()}): call ondocs(request, env) from ${main} in it`,
      };
    }
    const assets = lines.findIndex((line) => /^\s*\[\s*assets\s*\]\s*$/.test(line));
    if (assets === -1) {
      return /^\s*assets\s*=/m.test(source)
        ? { error: byHand }
        : {
            error: `${file} has no [assets] (a Worker with static assets) nor pages_build_output_dir (Pages)`,
          };
    }
    const end = lines.findIndex((line, i) => i > assets && header(line));
    const table = lines.slice(assets + 1, end === -1 ? undefined : end);
    const binding = table.find((line) => /^\s*binding\s*=/.test(line));
    if (binding && !/["']ASSETS["']/.test(binding)) {
      return { error: `${file}: the static assets' binding must be "ASSETS" (${binding.trim()})` };
    }
    const out = [...lines];
    if (!binding) out.splice(assets + 1, 0, 'binding = "ASSETS"');
    if (!mainLine) {
      const name = out.findIndex(
        (line, i) => /^\s*name\s*=/.test(line) && (firstTable === -1 || i < firstTable),
      );
      out.splice(name === -1 ? 0 : name + 1, 0, `main = "${main}"`);
    }
    return { content: out.join('\n') };
  }
  // JSON, with comments in a .jsonc: edited as text, so the comments stay.
  const mainMatch = /"main"\s*:\s*"([^"]*)"/.exec(source);
  if (mainMatch && mainMatch[1] !== main) {
    return {
      error: `${file} has its own entry point ("main": "${String(mainMatch[1])}"): call ondocs(request, env) from ${main} in it`,
    };
  }
  const assets = /"assets"\s*:\s*\{/.exec(source);
  if (!assets) {
    return {
      error: `${file} has no "assets" (a Worker with static assets) nor "pages_build_output_dir" (Pages)`,
    };
  }
  const close = source.indexOf('}', assets.index);
  const object = source.slice(assets.index, close);
  const binding = /"binding"\s*:\s*"([^"]*)"/.exec(object);
  if (binding && binding[1] !== 'ASSETS') {
    return {
      error: `${file}: the static assets' binding must be "ASSETS" ("${String(binding[1])}")`,
    };
  }
  const indent = /\n([ \t]+)"/.exec(source)?.[1] ?? '  ';
  let out = source;
  if (!binding) {
    const at = assets.index + assets[0].length;
    // `"assets": { "directory": "./build" }` stays on one line; a multi-line object gets a line.
    const inline = !object.includes('\n');
    const insert = inline ? ' "binding": "ASSETS",' : `\n${indent}${indent}"binding": "ASSETS",`;
    out = `${out.slice(0, at)}${insert}${out.slice(at)}`;
  }
  if (!mainMatch) {
    // After "name", where a config usually says what the Worker is, else first.
    const name = /^([ \t]*)"name"\s*:\s*"[^"]*"\s*,[^\n]*$/m.exec(out);
    if (name) {
      const at = name.index + name[0].length;
      out = `${out.slice(0, at)}\n${String(name[1])}"main": "${main}",${out.slice(at)}`;
    } else {
      const open = out.indexOf('{');
      if (open === -1) return { error: byHand };
      out = `${out.slice(0, open + 1)}\n${indent}"main": "${main}",${out.slice(open + 1)}`;
    }
  }
  return { content: out };
}

/** One file of the plan, with what init does with it. */
interface Change extends GeneratedFile {
  /** `create`: new; `update`: exists and differs; `same`: already as it would write it. */
  status: 'create' | 'update' | 'same';
}

interface Plan {
  site: Site;
  host: Host;
  changes: Change[];
  /** Edits init could not make safely, with what to do by hand. */
  manual: string[];
  /** Variables to set: what they are for, and where. */
  env: { name: string; when: string; how: string }[];
  next: string[];
}

/** What the CLI's index step needs to know without a key. */
const WITHOUT_KEY =
  ' (it embeds with OPENAI_API_KEY; -e none builds a keyword-only index without it)';

/** The dependency ranges init writes into a standalone Worker's package.json. */
const WORKER_VERSIONS: WorkerVersions = {
  ondocs: `^${version}`,
  ai: '^7.0.0',
  openai: '^4.0.0',
  workersAi: '^4.0.0',
  wrangler: '^4.0.0',
  typescript: '^6.0.0',
  workersTypes: '^5.20261001.0',
};

function install(p: Project, packages: string[], dev = false): string | null {
  const missing = packages.filter((name) => !p.deps.has(name));
  if (missing.length === 0 || !p.pkg) return null;
  const pm = p.has('pnpm-lock.yaml')
    ? `pnpm add${dev ? ' -D' : ''}`
    : p.has('yarn.lock')
      ? `yarn add${dev ? ' -D' : ''}`
      : p.has('bun.lock') || p.has('bun.lockb')
        ? `bun add${dev ? ' -d' : ''}`
        : `npm i${dev ? ' -D' : ''}`;
  return `${pm} ${missing.join(' ')}`;
}

/**
 * The packages the site needs for the dialog and the endpoint it was given. `functions`: init
 * writes the endpoint into the site's own project (not a standalone Worker), as functions that
 * import ondocs/server and @ai-sdk/openai.
 */
function sitePackages(site: Site, openai = true, functions = false): string[] {
  // A React site's dialog renders with the site's React, and these two. The Starlight, Astro and
  // VitePress plugins mount ondocs/embed/standalone, whose dialog brings its own React, Radix and
  // cmdk, as the script tag on a static site does.
  const dialog =
    site.kind === 'docusaurus' || site.kind === 'next' ? ['@radix-ui/react-dialog', 'cmdk'] : [];
  // The plugins embed the pages with OpenAI when OPENAI_API_KEY is set as the site builds. A
  // static site is indexed with npx, so it needs the models only for its functions; the
  // standalone Worker has a package.json of its own.
  const models =
    site.kind === 'static' && !functions ? [] : openai ? ['ai', '@ai-sdk/openai'] : ['ai'];
  return ['ondocs', ...models, ...dialog];
}

/**
 * How to add the dialog, for the site's framework, pointed at `endpoint` when it is not /api/ask,
 * embedding the pages with `embedding` when given, and naming the MCP endpoint at `mcp`, when
 * given, for llms.txt. `null` when the site's config already adds the plugin and there is no
 * option to give it.
 */
function dialogStep(
  site: Site,
  endpoint: string | null,
  embedding?: string,
  mcp?: string,
): string | null {
  // An `mcp` option the config already has stays as it is.
  const named = site.pluginMcp ? undefined : mcp;
  const fields = [
    ...(endpoint ? [`endpoint: '${endpoint}'`] : []),
    ...(named ? [`mcp: '${named}'`] : []),
    ...(embedding ? [`embedding: '${embedding}'`] : []),
  ];
  const option = fields.length > 0 ? `{ ${fields.join(', ')} }` : '';
  // A path needs the site's URL in the config: without it, the build stops and says so.
  const urlFirst =
    named?.startsWith('/') && !site.urlInConfig
      ? `; set ${site.kind === 'vitepress' ? `sitemap.hostname in ${site.config ?? '.vitepress/config.mts'}` : 'site in astro.config'} to the site's URL first, which the path is resolved against`
      : '';
  const notes = [
    ...(named ? [`mcp points agents that read llms.txt at the MCP endpoint${urlFirst}`] : []),
    ...(embedding
      ? [
          'the embedding needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN as the site builds; leave it out for a keyword-only index',
        ]
      : []),
  ];
  const why = notes.length > 0 ? ` (${notes.join('; ')})` : '';
  if (site.plugin) {
    return option ? `Pass ${option} to the ondocs plugin in ${site.plugin}${why}` : null;
  }
  switch (site.kind) {
    case 'docusaurus':
      return option
        ? `Add the plugin to docusaurus.config: plugins: [['ondocs/docusaurus', ${option}]]${why}`
        : "Add the plugin to docusaurus.config: plugins: ['ondocs/docusaurus']";
    case 'starlight':
      return `Add the plugin to Starlight in astro.config: plugins: [ondocs(${option})], from 'ondocs/starlight'${why}`;
    case 'astro':
      return `Add the integration to astro.config: integrations: [ondocs(${option})], from 'ondocs/astro'${why}`;
    case 'vitepress':
      return `Wrap the config in ${site.config ?? '.vitepress/config.mts'} in withOndocs, from 'ondocs/vitepress': export default withOndocs(defineConfig({ ... })${option ? `, ${option}` : ''})${why}`;
    case 'next':
      return `Render <AskDialog launcher${endpoint ? ` endpoint="${endpoint}"` : ''} /> from 'ondocs/react' in your layout, with 'ondocs/react/styles.css' and 'ondocs/embed/launcher.css'`;
    case 'static':
      return `Add to your base template: <script src="https://cdn.jsdelivr.net/npm/ondocs@${version.split('.').slice(0, 2).join('.')}/dist/embed.global.js" data-endpoint="${endpoint ?? '/api/ask'}" defer></script>`;
  }
}

/** The files and steps for `site` on `host`. */
function planFor(
  p: Project,
  site: Site,
  host: Host,
  mcp: boolean,
  provider: WorkerProvider,
): Omit<Plan, 'changes'> & {
  files: GeneratedFile[];
} {
  const files: GeneratedFile[] = [];
  const manual: string[] = [];
  const env: Plan['env'] = [];
  const next: string[] = [];
  const key = 'OPENAI_API_KEY';
  // Where the pages are embedded: by the plugin as the site builds, or by `ondocs index`.
  const build =
    site.kind === 'next' || site.kind === 'static' ? 'the index build' : 'the site\u2019s build';
  // The plugins build a keyword-only index without a key; `ondocs index` needs -e none for one.
  const keyless =
    site.kind === 'next' || site.kind === 'static'
      ? 'without it there, add -e none to the index command for a keyword-only index, which works too'
      : 'without it there, the index is keyword-only, which works too';
  // Where one variable serves the build and the endpoint: the build can do without the key, but
  // the endpoint cannot, as a model writes every answer.
  const answersNeedIt = `without it, ${mcp ? 'the MCP endpoint works and ' : ''}off-topic questions are refused, but the Ask box cannot answer; for no key at all, init --host github-pages writes a Worker that answers with Workers AI`;
  // A site whose Worker answers with Workers AI embeds with it too, or not at all.
  const needed = sitePackages(
    site,
    !(host === 'github-pages' && provider === 'workers-ai'),
    host !== 'github-pages',
  );
  const packages = install(p, needed);
  if (packages) next.push(packages);
  else if (!p.pkg && site.kind === 'static' && host !== 'github-pages') {
    // A static site with no package.json: the host installs the functions' packages from one.
    next.push(
      `npm init -y && npm i ${needed.join(' ')} (the functions import them, and the host installs them from package.json)`,
    );
  }

  const edit = (
    path: string,
    description: string,
    result: { content: string } | { error: string },
  ): void => {
    if ('error' in result) manual.push(result.error);
    else files.push({ path, content: result.content, description, addition: true });
  };

  if (site.kind === 'next' && host !== 'github-pages') {
    files.push(...nextFiles(site, host, site.appDir ?? 'app', mcp));
    env.push({
      name: key,
      when: `for the app and ${build}`,
      how: `in ${HOST_LABELS[host]}'s environment variables; ${answersNeedIt}`,
    });
    next.push(
      `Build the index before the app, as a "prebuild" script: ${String(site.indexCommand)}${WITHOUT_KEY}`,
    );
    addStep(next, dialogStep(site, null));
  } else if (host === 'github-pages') {
    if (!site.url) {
      throw new InitError(
        'The Worker fetches the index from the live site, so it needs the site’s URL: pass --site-url https://<user>.github.io/<repo>.',
      );
    }
    const indexed = site.kind === 'next' ? { ...site, indexFile: 'public/ask-index.json' } : site;
    files.push(
      ...standaloneWorkerFiles({ ...indexed, url: site.url }, mcp, WORKER_VERSIONS, provider),
    );
    const workersAi = provider === 'workers-ai';
    if (workersAi) {
      env.push({
        name: 'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN',
        when: `for ${build}, optional`,
        how: `repository secrets, to embed the pages with ${WORKERS_AI_EMBEDDING} for semantic search (a token allowed to run Workers AI); without them, nothing is embedded and questions are matched on keywords`,
      });
    } else {
      env.push({
        name: key,
        when: 'for the Worker',
        how: `cd ${STANDALONE_DIR} && npx wrangler secret put ${key}`,
      });
      env.push({
        name: key,
        when: `for ${build}`,
        how: `a repository secret, for a GitHub Actions build; ${keyless}`,
      });
    }
    const spec = workersAi ? ` -e workers-ai:${WORKERS_AI_EMBEDDING}` : '';
    // A project site, at https://user.github.io/repo, serves its pages under /repo. The Worker
    // links to them by their URLs in the index, on SITE_URL's origin, so the URLs need the path.
    const base = site.kind === 'static' ? new URL(`${site.url}/`).pathname.replace(/\/+$/, '') : '';
    if (site.indexCommand) {
      next.push(
        `Build the index with the site: ${site.kind === 'next' ? `${site.indexCommand} -o public/ask-index.json` : site.indexCommand}${base ? ` --base-url ${base}` : ''}${spec}${workersAi ? ' (with the two Cloudflare variables set; -e none builds a keyword-only index without them)' : WITHOUT_KEY}`,
      );
    }
    next.push(
      `cd ${STANDALONE_DIR} && npm install && npx wrangler deploy${workersAi ? '' : ` (after wrangler secret put ${key})`}: it prints the Worker's URL, https://${standaloneName(site)}.<your-subdomain>.workers.dev`,
    );
    addStep(
      next,
      dialogStep(
        site,
        `https://${standaloneName(site)}.<your-subdomain>.workers.dev/api/ask`,
        workersAi && site.kind !== 'next' && site.kind !== 'static'
          ? `workers-ai:${WORKERS_AI_EMBEDDING}`
          : undefined,
        mcp ? `https://${standaloneName(site)}.<your-subdomain>.workers.dev/api/mcp` : undefined,
      ),
    );
  } else if (host === 'vercel') {
    files.push(...vercelFiles(site, mcp));
    edit(
      'vercel.json',
      `bundles ${site.locales?.length ? 'the index of each locale' : site.indexFile} with the function${mcp ? 's' : ''}`,
      vercelConfig(p.read('vercel.json'), site, mcp),
    );
    env.push({
      name: key,
      when: `for the functions and ${build}`,
      how: `in the project's Settings, Environment Variables; ${answersNeedIt}`,
    });
    if (p.pkg && !p.deps.has('@types/node')) {
      const types = install(p, ['@types/node'], true);
      if (types) next.push(`${types} (the functions' types)`);
    }
  } else if (host === 'netlify') {
    files.push(...netlifyFiles(site, mcp));
    edit(
      'netlify.toml',
      `bundles ${site.locales?.length ? 'the index of each locale' : site.indexFile} with the function${mcp ? 's' : ''}`,
      netlifyConfig(p.read('netlify.toml'), site, mcp),
    );
    env.push({
      name: key,
      when: `for the functions and ${build}`,
      how: `in the site's Environment variables, or netlify env:set ${key}; ${answersNeedIt}`,
    });
    if (p.pkg && !p.deps.has('@types/node')) {
      const types = install(p, ['@types/node'], true);
      if (types) next.push(`${types} (the functions' types)`);
    }
  } else {
    const { mode, file } = cloudflareMode(p);
    if (mode === 'pages') {
      files.push(...cloudflarePagesFiles(site, mcp));
      env.push({
        name: key,
        when: 'for the functions',
        how: `npx wrangler pages secret put ${key}, or the project's Variables and Secrets`,
      });
      env.push({ name: key, when: `for ${build}`, how: `a build variable; ${keyless}` });
    } else {
      files.push(...cloudflareWorkerFiles(site, mcp));
      if (file) {
        edit(
          file,
          `sets main to ${WORKER_MODULE}, and the static assets' binding to ASSETS`,
          wranglerWorkerConfig(file, p.read(file) ?? ''),
        );
      }
      env.push({ name: key, when: 'for the Worker', how: `npx wrangler secret put ${key}` });
      env.push({ name: key, when: `for ${build}`, how: `a build variable; ${keyless}` });
    }
  }

  if (site.kind === 'static' && site.indexCommand && host !== 'github-pages') {
    next.push(`Build the index after the site: ${site.indexCommand}${WITHOUT_KEY}`);
  }
  if (site.kind !== 'next' && host !== 'github-pages') {
    // The plugins take `mcp`; the script tag has nothing to name it in. Always the path: a URL
    // made from package.json's homepage can be the repository's page, as npm init sets it.
    addStep(
      next,
      dialogStep(site, null, undefined, mcp && site.kind !== 'static' ? '/api/mcp' : undefined),
    );
  }
  next.push('Deploy as you do now. init has deployed nothing.');
  return { site, host, files, manual, env, next };
}

const standaloneName = (site: Site): string => workerName(site.name);

const addStep = (next: string[], step: string | null): void => {
  if (step) next.push(step);
};

function parseInitFlags(args: string[]) {
  try {
    const { values } = parseArgs({
      args,
      allowNegative: true,
      strict: true,
      options: {
        host: { type: 'string' },
        provider: { type: 'string' },
        'site-url': { type: 'string' },
        'site-name': { type: 'string' },
        // --site-name's name before 0.9.
        name: { type: 'string' },
        'build-dir': { type: 'string' },
        // --build-dir's name before 0.14: `ondocs index -o` names the file it writes instead.
        out: { type: 'string' },
        mcp: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    const host = values.host;
    if (host !== undefined && !HOSTS.includes(host as Host)) {
      throw new InitError(`--host must be one of ${HOSTS.join(', ')}.`);
    }
    const given = values.provider;
    if (given !== undefined && given !== 'workers-ai' && given !== 'openai') {
      throw new InitError('--provider must be workers-ai or openai.');
    }
    const provider: WorkerProvider | undefined = given;
    const siteUrl = values['site-url'];
    if (siteUrl !== undefined && !/^https?:\/\/[^/]/.test(siteUrl)) {
      throw new InitError(`--site-url must be an absolute http(s) URL (got ${siteUrl}).`);
    }
    const name = values['site-name'] ?? values.name;
    const buildDir = values['build-dir'] ?? values.out;
    return {
      ...(host ? { host: host as Host } : {}),
      ...(provider ? { provider: provider } : {}),
      ...(siteUrl ? { siteUrl: siteUrl.replace(/\/+$/, '') } : {}),
      ...(name ? { name } : {}),
      deprecated: [
        ...(values.name === undefined
          ? []
          : [`--name is now --site-name. The old name still works until ${REMOVED_IN}.`]),
        ...(values.out === undefined
          ? []
          : [`--out is now --build-dir. The old name still works until ${REMOVED_IN}.`]),
      ],
      ...(buildDir ? { buildDir } : {}),
      mcp: values.mcp ?? true,
      dryRun: values['dry-run'] ?? false,
      yes: values.yes ?? false,
      help: values.help ?? false,
    };
  } catch (error) {
    if (error instanceof InitError) throw error;
    throw new InitError((error as Error).message);
  }
}

async function chooseHost(detected: Host[], io: CliIO): Promise<Host> {
  const choices = detected.length > 1 ? detected : HOSTS;
  if (!io.prompt) {
    throw new InitError(
      detected.length > 1
        ? `This site has config for ${detected.map((h) => HOST_LABELS[h]).join(' and ')}: pick one with --host ${detected.join('|')}.`
        : `No vercel.json, netlify.toml, wrangler config or GitHub Pages workflow here: pass --host ${HOSTS.join('|')}.`,
    );
  }
  const lines = [
    detected.length > 1
      ? `This site has config for ${detected.map((h) => HOST_LABELS[h]).join(' and ')}. Which one serves it?`
      : 'Where is the site hosted?',
    ...choices.map(
      (host, i) =>
        `  ${String(i + 1)}. ${HOST_LABELS[host]}${host === 'github-pages' ? ', or another static host (the endpoint runs as a Cloudflare Worker)' : ''}`,
    ),
  ];
  for (const line of lines) io.stdout(line);
  for (;;) {
    const answer = (await io.prompt(`Choose 1-${String(choices.length)}: `)).trim();
    const host = choices[Number(answer) - 1] ?? choices.find((h) => h === answer);
    if (host) return host;
  }
}

async function confirm(io: CliIO, question: string): Promise<boolean> {
  if (!io.prompt) return false;
  return /^y(es)?$/i.test((await io.prompt(`${question} [y/N] `)).trim());
}

/** Runs `ondocs init`. Returns the exit code: 0 done, 1 something left undone, 2 usage. */
export async function init(args: string[], io: CliIO): Promise<number> {
  let flags: ReturnType<typeof parseInitFlags>;
  try {
    flags = parseInitFlags(args);
  } catch (error) {
    io.stderr((error as Error).message);
    io.stderr(`\n${INIT_USAGE}`);
    return 2;
  }
  if (flags.help) {
    io.stdout(INIT_USAGE);
    return 0;
  }
  for (const warning of flags.deprecated) io.stderr(`! ${warning}`);
  try {
    const p = project(io.cwd);
    const site = detectSite(p, flags);
    const detected = detectHosts(p);

    // Astro with an adapter: the integration serves the endpoints itself, on any host.
    if ((site.kind === 'astro' || site.kind === 'starlight') && site.adapter) {
      const packages = install(p, sitePackages(site));
      io.stdout(
        [
          `${site.label} with ${site.adapter}: nothing to write. The ondocs integration serves POST /api/ask and /api/mcp itself, through the adapter, from the index it builds.`,
          '',
          'Set OPENAI_API_KEY where the site builds and where it runs. Pass route: { model, rateLimit, budget } to ondocs() to change the model or the limits; route: false turns it off.',
          // llms.txt names the MCP route only with an absolute URL to give.
          ...(site.urlInConfig
            ? []
            : [
                '',
                "Set site in astro.config to the site's URL, so llms.txt names /api/mcp for agents.",
              ]),
          ...(packages ? ['', `Install: ${packages}`] : []),
        ].join('\n'),
      );
      return 0;
    }

    const host =
      flags.host ??
      (detected.length === 1 && detected[0] ? detected[0] : await chooseHost(detected, io));
    let resolved = site;
    // A URL from the site's config can be its template's, as a new Docusaurus site's is.
    const placeholder = !flags.siteUrl && site.url && placeholderUrl(site.url) ? site.url : null;
    if (host === 'github-pages' && (!site.url || placeholder) && io.prompt) {
      if (placeholder) {
        io.stdout(
          `The site's config has ${placeholder} as its URL, which looks like a placeholder.`,
        );
      }
      const answer = (
        await io.prompt('The site’s public URL, with its base path (https://user.github.io/repo): ')
      ).trim();
      if (/^https?:\/\/[^/]/.test(answer)) resolved = { ...site, url: answer.replace(/\/+$/, '') };
    }
    if (host === 'github-pages' && placeholder && resolved.url === placeholder) {
      io.stderr(
        `! The site's URL, ${placeholder}, looks like a template's placeholder, and the Worker reads the index from it. Set the site's real URL in its config, or run init again with --site-url.`,
      );
    }
    if (flags.provider === 'workers-ai' && host !== 'github-pages') {
      throw new InitError(
        '--provider workers-ai is for --host github-pages, whose endpoint is a Cloudflare Worker of its own with a Workers AI binding.',
      );
    }
    const planned = planFor(p, resolved, host, flags.mcp, flags.provider ?? 'workers-ai');
    const changes: Change[] = planned.files.map((file) => {
      const existing = p.read(file.path);
      const status = existing === null ? 'create' : existing === file.content ? 'same' : 'update';
      return { ...file, status };
    });
    const plan: Plan = { ...planned, changes };
    return await apply(plan, flags, io);
  } catch (error) {
    if (error instanceof InitError) {
      io.stderr(`✗ ${error.message}`);
      return 2;
    }
    io.stderr(`✗ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function apply(
  plan: Plan,
  flags: { dryRun: boolean; yes: boolean },
  io: CliIO,
): Promise<number> {
  const { site, host } = plan;
  const where =
    host === 'github-pages' ? 'GitHub Pages, answered by a Cloudflare Worker' : HOST_LABELS[host];
  io.stdout(`${flags.dryRun ? 'Dry run: ' : ''}a ${site.label} site on ${where}.`);
  if (site.locales?.length && site.kind !== 'next') {
    io.stdout(
      `Its other locales, ${site.locales.join(', ')}, are answered from their own indexes, as the dialog asks.`,
    );
  }
  io.stdout('');

  const written: Change[] = [];
  const skipped: Change[] = [];
  for (const change of plan.changes) {
    if (change.status === 'same') continue;
    if (flags.dryRun) {
      written.push(change);
      continue;
    }
    if (change.status === 'update' && !change.addition && !flags.yes) {
      if (
        !(await confirm(
          io,
          `${change.path} exists and differs from what init writes. Overwrite it?`,
        ))
      ) {
        skipped.push(change);
        continue;
      }
    }
    await mkdir(dirname(join(io.cwd, change.path)), { recursive: true });
    await writeFile(join(io.cwd, change.path), change.content);
    written.push(change);
  }

  const width = Math.max(...plan.changes.map((change) => change.path.length), 0);
  const verb = (change: Change): string => {
    if (skipped.includes(change)) return 'skipped';
    if (change.status === 'same') return 'unchanged';
    if (flags.dryRun) return change.status === 'create' ? 'would create' : 'would update';
    return change.status === 'create' ? 'created' : 'updated';
  };
  const verbWidth = flags.dryRun ? 12 : 9;
  for (const change of plan.changes) {
    io.stdout(
      `  ${verb(change).padEnd(verbWidth)}  ${change.path.padEnd(width)}  ${change.description}`,
    );
  }
  for (const line of plan.manual) io.stdout(`  ${'by hand'.padEnd(verbWidth)}  ${line}`);

  if (flags.dryRun) {
    for (const change of written) {
      io.stdout('');
      io.stdout(`--- ${change.path}`);
      io.stdout(change.content.replace(/\n$/, ''));
    }
  }

  io.stdout('');
  io.stdout('Set (init reads none of these):');
  for (const variable of plan.env) {
    io.stdout(`  ${variable.name}, ${variable.when}: ${variable.how}`);
  }
  io.stdout('');
  io.stdout('Next:');
  plan.next.forEach((step, i) => {
    io.stdout(`  ${String(i + 1)}. ${step}`);
  });

  if (skipped.length > 0) {
    io.stderr('');
    io.stderr(
      `! Left ${skipped.map((change) => change.path).join(', ')} as ${skipped.length === 1 ? 'it is' : 'they are'}. Rerun with --dry-run to see what init would write, or --yes to overwrite.`,
    );
    return 1;
  }
  return plan.manual.length > 0 ? 1 : 0;
}
