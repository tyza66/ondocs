// `ondocs init`: what it writes per site and host (snapshotted), and how it behaves when run
// again, asked to overwrite, or given config it cannot edit safely. scripts/deploy-recipes.mjs
// builds these same files with each host's own tooling.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { version } from '../package.json' with { type: 'json' };
import { placeholderUrl, wranglerWorkerConfig } from '../src/cli/init';
import { comment, workerName } from '../src/cli/init-templates';
import { main } from '../src/cli/main';

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'ondocs-init-'));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function files(root: string, dir = root): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, await files(root, path));
    else out[relative(root, path)] = await readFile(path, 'utf8');
  }
  return out;
}

async function site(contents: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(contents)) {
    await mkdir(join(cwd, path, '..'), { recursive: true });
    await writeFile(join(cwd, path), text);
  }
}

async function run(args: string[], answers?: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const asked: string[] = [];
  const env: Record<string, string | undefined> = {};
  const queue = [...(answers ?? [])];
  const code = await main(['init', ...args], {
    cwd,
    env,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    ...(answers
      ? {
          prompt: (question: string) => {
            asked.push(question);
            return Promise.resolve(queue.shift() ?? '');
          },
        }
      : {}),
  });
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n'), asked, env };
}

const DOCUSAURUS = {
  'package.json': JSON.stringify({ name: 'acme-docs', dependencies: { '@docusaurus/core': '3' } }),
  'docusaurus.config.ts':
    "export default { title: 'Acme Docs', url: 'https://acme.github.io', baseUrl: '/docs/' };\n",
};

describe('ondocs init: what it writes per host', () => {
  const cases: [string, Record<string, string>, string[]][] = [
    ['Docusaurus on Vercel', { ...DOCUSAURUS, 'vercel.json': '{ "cleanUrls": true }\n' }, []],
    [
      'Docusaurus on Netlify',
      { ...DOCUSAURUS, 'netlify.toml': '[build]\n  publish = "build"\n' },
      [],
    ],
    [
      'Docusaurus on Cloudflare Pages, without a wrangler config',
      DOCUSAURUS,
      ['--host', 'cloudflare'],
    ],
    [
      'Docusaurus on a Cloudflare Worker with static assets (wrangler.toml)',
      {
        ...DOCUSAURUS,
        'wrangler.toml':
          'name = "acme-docs"\ncompatibility_date = "2026-09-01"\n\n[assets]\ndirectory = "./build"\n',
      },
      [],
    ],
    [
      'Docusaurus on GitHub Pages',
      {
        ...DOCUSAURUS,
        'package.json': JSON.stringify({
          name: 'acme-docs',
          scripts: { deploy: 'docusaurus deploy' },
          dependencies: { '@docusaurus/core': '3' },
        }),
        '.github/workflows/deploy.yml': 'steps:\n  - uses: actions/deploy-pages@v4\n',
      },
      [],
    ],
    [
      'Starlight on Vercel',
      {
        'package.json': JSON.stringify({
          dependencies: { astro: '7', '@astrojs/starlight': '0.42' },
        }),
        'astro.config.mjs':
          "import starlight from '@astrojs/starlight';\nexport default { site: 'https://docs.acme.dev', integrations: [starlight({ title: 'Acme' })] };\n",
        '.vercel/project.json': '{}',
      },
      [],
    ],
    [
      'Next.js on Netlify',
      {
        'package.json': JSON.stringify({ name: 'acme', dependencies: { next: '16' } }),
        'next.config.ts': 'export default {};\n',
        'src/app/page.tsx': '',
        'netlify.toml': '',
      },
      [],
    ],
    [
      'Docusaurus in three locales on Netlify',
      {
        'package.json': JSON.stringify({
          name: 'acme-docs',
          dependencies: { '@docusaurus/core': '3' },
        }),
        'docusaurus.config.ts':
          "export default {\n  title: 'Acme Docs',\n  url: 'https://acme.github.io',\n  baseUrl: '/',\n  i18n: { defaultLocale: 'en', locales: ['en', 'fr', 'pt-BR'] },\n};\n",
        'netlify.toml': '',
      },
      [],
    ],
    [
      'Starlight in two locales on a Cloudflare Worker',
      {
        'package.json': JSON.stringify({
          dependencies: { astro: '7', '@astrojs/starlight': '0.42' },
        }),
        'astro.config.mjs':
          "import starlight from '@astrojs/starlight';\nexport default { site: 'https://docs.acme.dev', integrations: [starlight({ title: 'Acme', locales: { root: { label: 'English', lang: 'en' }, fr: { label: 'Français' } } })] };\n",
        'wrangler.jsonc': '{\n  "name": "acme",\n  "assets": { "directory": "./dist" }\n}\n',
      },
      [],
    ],
    [
      'VitePress in docs/, in two locales, on Vercel',
      {
        'package.json': JSON.stringify({
          name: 'acme',
          devDependencies: { vitepress: '1.6.4' },
          scripts: { 'docs:build': 'vitepress build docs' },
        }),
        'docs/.vitepress/config.mts':
          "import { defineConfig } from 'vitepress';\n\nexport default defineConfig({\n  title: 'Acme Docs',\n  base: '/docs/',\n  sitemap: { hostname: 'https://acme.dev' },\n  locales: {\n    root: { label: 'English', lang: 'en' },\n    fr: { label: 'Français', lang: 'fr' },\n  },\n});\n",
        'vercel.json': '{}\n',
      },
      [],
    ],
    [
      'VitePress on GitHub Pages',
      {
        'package.json': JSON.stringify({ devDependencies: { vitepress: '1.6.4' } }),
        '.vitepress/config.mts':
          "import { defineConfig } from 'vitepress';\n\nexport default defineConfig({ title: 'Acme', base: '/acme/' });\n",
        '.github/workflows/deploy.yml': 'steps:\n  - uses: actions/deploy-pages@v4\n',
      },
      ['--site-url', 'https://acme.github.io/acme'],
    ],
    [
      'Hugo on a GitHub Pages workflow',
      {
        'hugo.toml': 'baseURL = "https://acme.github.io/site/"\ntitle = "Acme"\n',
        '.github/workflows/pages.yml': 'steps:\n  - uses: actions/deploy-pages@v4\n',
      },
      [],
    ],
  ];

  for (const [name, contents, args] of cases) {
    it(name, async () => {
      await site(contents);
      const before = await files(cwd);
      const result = await run(['--yes', ...args]);
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      const after = await files(cwd);
      // The package's own version, which a release changes, as a placeholder.
      const minor = version.split('.').slice(0, 2).join('.');
      const unversioned = (text: string) =>
        text.replaceAll(`^${version}`, '^<version>').replaceAll(`@${minor}/`, '@<minor>/');
      const written = Object.fromEntries(
        Object.entries(after)
          .filter(([path, text]) => before[path] !== text)
          .map(([path, text]) => [path, unversioned(text)]),
      );
      expect(written).toMatchSnapshot();
      expect(unversioned(result.stdout)).toMatchSnapshot();
    });
  }
});

describe('ondocs init', () => {
  it('is idempotent: run again, it finds every file as it would write it', async () => {
    await site({ ...DOCUSAURUS, 'vercel.json': '{}' });
    expect((await run([])).code).toBe(0);
    const first = await files(cwd);
    const again = await run([]);
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/unchanged {2}api\/ask\.ts/);
    expect(again.stdout).toMatch(/unchanged {2}vercel\.json/);
    expect(await files(cwd)).toEqual(first);
  });

  it('writes nothing with --dry-run, and prints what it would write', async () => {
    await site({ ...DOCUSAURUS, 'vercel.json': '{}' });
    const result = await run(['--dry-run']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Dry run: a Docusaurus site on Vercel\./);
    expect(result.stdout).toMatch(/would create {2}api\/ask\.ts/);
    expect(result.stdout).toContain('--- api/ask.ts');
    expect(result.stdout).toContain(
      "import { createAskHandler, memoryRateLimit, turnstile } from 'ondocs/server';",
    );
    expect(existsSync(join(cwd, 'api'))).toBe(false);
    expect(await readFile(join(cwd, 'vercel.json'), 'utf8')).toBe('{}');
  });

  it('asks before it overwrites a file that differs, and leaves it when told no', async () => {
    await site({ ...DOCUSAURUS, 'vercel.json': '{}', 'api/ask.ts': '// mine\n' });
    const no = await run([], ['n']);
    expect(no.asked).toEqual([
      'api/ask.ts exists and differs from what init writes. Overwrite it? [y/N] ',
    ]);
    expect(no.code).toBe(1);
    expect(no.stdout).toMatch(/skipped {4}api\/ask\.ts/);
    expect(await readFile(join(cwd, 'api/ask.ts'), 'utf8')).toBe('// mine\n');
    // The edit to vercel.json only adds, so it is made without asking.
    expect(JSON.parse(await readFile(join(cwd, 'vercel.json'), 'utf8'))).toEqual({
      functions: {
        'api/ask.ts': { includeFiles: 'build/ask-index.json' },
        'api/mcp.ts': { includeFiles: 'build/ask-index.json' },
      },
    });

    const yes = await run([], ['y']);
    expect(yes.code).toBe(0);
    expect(await readFile(join(cwd, 'api/ask.ts'), 'utf8')).toContain('createAskHandler');
  });

  it('never overwrites without a terminal to ask, unless given --yes', async () => {
    await site({ ...DOCUSAURUS, 'vercel.json': '{}', 'api/ask.ts': '// mine\n' });
    const result = await run([]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Left api/ask.ts as it is.');
    expect(await readFile(join(cwd, 'api/ask.ts'), 'utf8')).toBe('// mine\n');
    expect((await run(['--yes'])).code).toBe(0);
    expect(await readFile(join(cwd, 'api/ask.ts'), 'utf8')).toContain('createAskHandler');
  });

  it('asks for the host when nothing names one, and fails without a terminal', async () => {
    await site(DOCUSAURUS);
    const unattended = await run([]);
    expect(unattended.code).toBe(2);
    expect(unattended.stderr).toContain('pass --host vercel|netlify|cloudflare|github-pages');

    const asked = await run([], ['2']);
    expect(asked.code).toBe(0);
    expect(asked.stdout).toContain('Where is the site hosted?');
    expect(asked.stdout).toContain('a Docusaurus site on Netlify.');
    expect(existsSync(join(cwd, 'netlify/functions/ask.mts'))).toBe(true);
  });

  it('does not take a new Docusaurus site’s deploy script for GitHub Pages', async () => {
    // As create-docusaurus writes it: a `docusaurus deploy` script, the template's URL, and the
    // plugin added as the docs say.
    await site({
      'package.json': JSON.stringify({
        name: 'acme-docs',
        scripts: { build: 'docusaurus build', deploy: 'docusaurus deploy' },
        dependencies: { '@docusaurus/core': '3' },
      }),
      'docusaurus.config.ts':
        "export default {\n  title: 'Acme Docs',\n  url: 'https://your-docusaurus-site.example.com',\n  baseUrl: '/',\n  plugins: ['ondocs/docusaurus'],\n};\n",
    });
    const unattended = await run([]);
    expect(unattended.code).toBe(2);
    expect(unattended.stderr).toContain('pass --host vercel|netlify|cloudflare|github-pages');
    expect(existsSync(join(cwd, 'ondocs-worker'))).toBe(false);

    // Asked, and told GitHub Pages: it asks for the site's URL, since the config's is the
    // template's, and warns when it gets none.
    const asked = await run([], ['4', '']);
    expect(asked.code).toBe(0);
    expect(asked.stdout).toContain('Where is the site hosted?');
    expect(asked.stdout).toContain(
      "The site's config has https://your-docusaurus-site.example.com as its URL, which looks like a placeholder.",
    );
    expect(asked.asked.at(-1)).toContain('The site’s public URL');
    expect(asked.stderr).toContain(
      "! The site's URL, https://your-docusaurus-site.example.com, looks like a template's placeholder",
    );
    // The plugin is in the config already: the step gives it the Worker's endpoints.
    expect(asked.stdout).not.toContain('Add the plugin');
    expect(asked.stdout).toContain(
      "Pass { endpoint: 'https://acme-docs-ask.<your-subdomain>.workers.dev/api/ask', mcp: 'https://acme-docs-ask.<your-subdomain>.workers.dev/api/mcp', embedding: 'workers-ai:@cf/baai/bge-small-en-v1.5' } to the ondocs plugin in docusaurus.config.ts",
    );

    // Given the real URL, it uses it, and has nothing to warn about.
    const answered = await run(['--yes'], ['4', 'https://acme.github.io/docs/']);
    expect(answered.stderr).toBe('');
    expect(await readFile(join(cwd, 'ondocs-worker/wrangler.jsonc'), 'utf8')).toContain(
      '"SITE_URL": "https://acme.github.io/docs"',
    );
    // And on a host whose endpoint is the site's own, the plugin needs only the MCP endpoint's
    // path.
    const vercel = await run(['--host', 'vercel', '--dry-run']);
    expect(vercel.code).toBe(0);
    expect(vercel.stderr).toBe('');
    const steps = vercel.stdout.slice(vercel.stdout.lastIndexOf('\nNext:'));
    expect(steps).toContain('Deploy as you do now.');
    expect(steps).toContain(
      "Pass { mcp: '/api/mcp' } to the ondocs plugin in docusaurus.config.ts",
    );
    expect(steps).not.toContain('endpoint:');
  });

  it('takes the gh-pages package or a script that runs it for GitHub Pages', async () => {
    await site({
      ...DOCUSAURUS,
      'package.json': JSON.stringify({
        name: 'acme-docs',
        scripts: { deploy: 'gh-pages -d build' },
        dependencies: { '@docusaurus/core': '3' },
      }),
    });
    const result = await run(['--dry-run']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      'a Docusaurus site on GitHub Pages, answered by a Cloudflare Worker.',
    );
  });

  it('tells a plain HTML site to name its folder with --build-dir', async () => {
    await site({ 'package.json': JSON.stringify({ name: 'acme' }) });
    const nothing = await run([]);
    expect(nothing.code).toBe(2);
    expect(nothing.stderr).toContain(
      'For plain HTML, pass the folder of its HTML files with --build-dir <dir>, as in npx ondocs init --build-dir public.',
    );

    await site({ '_site/index.html': '<!doctype html><title>Acme</title><main>Hi</main>' });
    const found = await run([]);
    expect(found.code).toBe(2);
    expect(found.stderr).toContain(
      '_site/ has HTML files: if it is the folder the site deploys, run npx ondocs init --build-dir _site.',
    );
    const named = await run(['--out', '_site', '--host', 'vercel', '--dry-run']);
    expect(named.code).toBe(0);
    // `ondocs index` needs -e none to build without a key, which the plugins do not.
    expect(named.stdout).toContain(
      'Build the index after the site: npx ondocs index _site -o _site/ask-index.json (it embeds with OPENAI_API_KEY; -e none builds a keyword-only index without it)',
    );
  });

  it('does not call the key optional where one variable serves the build and the functions', async () => {
    const variables = (stdout: string) =>
      stdout
        .slice(stdout.indexOf('Set (init reads none of these):'), stdout.indexOf('\nNext:'))
        .split('\n')
        .filter((line) => line.startsWith('  OPENAI_API_KEY, '));
    const NEEDED =
      'without it, the MCP endpoint works and off-topic questions are refused, but the Ask box cannot answer; for no key at all, init --host github-pages writes a Worker that answers with Workers AI';
    const NEXT = {
      'package.json': JSON.stringify({ name: 'acme', dependencies: { next: '16' } }),
      'next.config.ts': 'export default {};\n',
      'src/app/page.tsx': '',
    };
    for (const [contents, args] of [
      [{ ...DOCUSAURUS, 'vercel.json': '{}' }, []],
      [{ ...DOCUSAURUS, 'netlify.toml': '' }, []],
      [NEXT, ['--host', 'vercel']],
      [{ ...NEXT, 'netlify.toml': '' }, []],
      [
        { 'package.json': JSON.stringify({ name: 'acme' }) },
        ['--out', '_site', '--host', 'vercel'],
      ],
    ] as const) {
      await rm(cwd, { recursive: true, force: true });
      await mkdir(cwd);
      await site(contents);
      const result = await run(['--dry-run', ...args]);
      expect(result.code).toBe(0);
      const [line, ...more] = variables(result.stdout);
      expect(more).toEqual([]);
      expect(line).toMatch(/^ {2}OPENAI_API_KEY, for the (functions|app) and the /);
      expect(line).toContain(NEEDED);
      expect(line).not.toContain('which works too');
    }

    // Without the MCP endpoint, the line does not name it.
    await rm(cwd, { recursive: true, force: true });
    await mkdir(cwd);
    await site({ ...DOCUSAURUS, 'vercel.json': '{}' });
    expect(variables((await run(['--dry-run', '--no-mcp'])).stdout)).toEqual([
      expect.stringContaining(
        '; without it, off-topic questions are refused, but the Ask box cannot answer; ',
      ),
    ]);

    // Where the build has a variable of its own, the build can do without it; the functions can't.
    await rm(cwd, { recursive: true, force: true });
    await mkdir(cwd);
    await site(DOCUSAURUS);
    const pages = variables((await run(['--dry-run', '--host', 'cloudflare'])).stdout);
    expect(pages).toEqual([
      "  OPENAI_API_KEY, for the functions: npx wrangler pages secret put OPENAI_API_KEY, or the project's Variables and Secrets",
      '  OPENAI_API_KEY, for the site’s build: a build variable; without it there, the index is keyword-only, which works too',
    ]);
  });

  it('asks which host when the site has config for two', async () => {
    await site({ ...DOCUSAURUS, 'vercel.json': '{}', 'netlify.toml': '' });
    const unattended = await run([]);
    expect(unattended.code).toBe(2);
    expect(unattended.stderr).toContain(
      'config for Vercel and Netlify: pick one with --host vercel|netlify',
    );
    const asked = await run([], ['1']);
    expect(asked.stdout).toContain('a Docusaurus site on Vercel.');
  });

  it('writes nothing for Astro with an SSR adapter: the integration serves the endpoints', async () => {
    await site({
      'package.json': JSON.stringify({ dependencies: { astro: '7', '@astrojs/node': '10' } }),
      'astro.config.mjs':
        "import node from '@astrojs/node';\nexport default { adapter: node() };\n",
      'vercel.json': '{}',
    });
    const before = await files(cwd);
    const result = await run([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Astro with @astrojs/node: nothing to write.');
    // The integration's dialog brings its own React, Radix and cmdk: the site installs none.
    expect(result.stdout.split('\n')).toContain('Install: npm i ondocs ai @ai-sdk/openai');
    expect(await files(cwd)).toEqual(before);
    // Without `site`, llms.txt has no URL to name the MCP route by: init says what to set.
    const hint =
      "Set site in astro.config to the site's URL, so llms.txt names /api/mcp for agents.";
    expect(result.stdout).toContain(hint);
    await site({
      'astro.config.mjs':
        "import node from '@astrojs/node';\nexport default { site: 'https://acme.dev', adapter: node() };\n",
    });
    expect((await run([])).stdout).not.toContain(hint);
  });

  it('gives the plugin the MCP endpoint it writes, so llms.txt points agents at it', async () => {
    const steps = (stdout: string) => stdout.slice(stdout.lastIndexOf('\nNext:'));
    const config = (plugins: string) =>
      `export default { title: 'Acme Docs', url: 'https://acme.dev', plugins: [${plugins}] };\n`;

    // A path, which the plugin resolves against the config's url.
    await site({ ...DOCUSAURUS, 'vercel.json': '{}' });
    const added = await run(['--dry-run']);
    expect(added.code).toBe(0);
    expect(steps(added.stdout)).toContain(
      "Add the plugin to docusaurus.config: plugins: [['ondocs/docusaurus', { mcp: '/api/mcp' }]] (mcp points agents that read llms.txt at the MCP endpoint)",
    );
    // No MCP endpoint, nothing to name.
    const without = await run(['--dry-run', '--no-mcp']);
    expect(steps(without.stdout)).toContain(
      "Add the plugin to docusaurus.config: plugins: ['ondocs/docusaurus']",
    );
    expect(without.stdout).not.toContain('mcp:');

    // The plugin is in the config: the option alone, until the config sets it.
    await site({ 'docusaurus.config.ts': config("'ondocs/docusaurus'") });
    expect(steps((await run(['--dry-run'])).stdout)).toContain(
      "Pass { mcp: '/api/mcp' } to the ondocs plugin in docusaurus.config.ts (mcp points agents that read llms.txt at the MCP endpoint)",
    );
    await site({ 'docusaurus.config.ts': config("['ondocs/docusaurus', { mcp: '/api/mcp' }]") });
    expect(steps((await run(['--dry-run'])).stdout)).not.toMatch(/plugin/i);
    // `route: { mcp: false }` and a commented-out line are not the plugin's `mcp`.
    for (const plugin of [
      "['ondocs/docusaurus', { route: { mcp: false } }]",
      "\n    // ['ondocs/docusaurus', { mcp: '/api/mcp' }],\n    'ondocs/docusaurus'",
    ]) {
      await site({ 'docusaurus.config.ts': config(plugin) });
      expect(steps((await run(['--dry-run'])).stdout)).toContain(
        "Pass { mcp: '/api/mcp' } to the ondocs plugin in docusaurus.config.ts",
      );
    }

    // Astro resolves the path against `site`, VitePress against `sitemap.hostname` (or
    // withOndocs's siteUrl), set to a literal or to an expression. Without one, the step says to
    // set it first, so a build that skips it stops and says so; it never makes a URL up, nor
    // takes package.json's homepage, which npm init sets to the repository's page.
    const named = '(mcp points agents that read llms.txt at the MCP endpoint)';
    const siteFirst =
      "(mcp points agents that read llms.txt at the MCP endpoint; set site in astro.config to the site's URL first, which the path is resolved against)";
    const starlight = (astroConfig: string, pkg: Record<string, unknown> = {}) => ({
      'package.json': JSON.stringify({
        ...pkg,
        dependencies: { astro: '7', '@astrojs/starlight': '0.42' },
      }),
      'astro.config.mjs': `import starlight from '@astrojs/starlight';\nexport default { ${astroConfig}integrations: [starlight({ title: 'Acme' })] };\n`,
      'vercel.json': '{}',
    });
    const vitepress = (config: string) => ({
      'package.json': JSON.stringify({ devDependencies: { vitepress: '1.6.4' } }),
      '.vitepress/config.mts': `export default defineConfig({ title: 'Acme'${config} });\n`,
      'netlify.toml': '',
    });
    const withOndocs = "withOndocs(defineConfig({ ... }), { mcp: '/api/mcp' })";
    const cases: [Record<string, string>, string][] = [
      [
        starlight("site: 'https://docs.acme.dev', "),
        `ondocs({ mcp: '/api/mcp' })], from 'ondocs/starlight' ${named}`,
      ],
      [
        starlight("site: process.env.SITE_URL ?? 'https://docs.acme.dev', "),
        `ondocs({ mcp: '/api/mcp' })], from 'ondocs/starlight' ${named}`,
      ],
      [starlight(''), `ondocs({ mcp: '/api/mcp' })], from 'ondocs/starlight' ${siteFirst}`],
      [
        starlight('', { homepage: 'https://github.com/acme/docs#readme' }),
        `ondocs({ mcp: '/api/mcp' })], from 'ondocs/starlight' ${siteFirst}`,
      ],
      [
        starlight("\n  // site: 'https://docs.acme.dev',\n  "),
        `ondocs({ mcp: '/api/mcp' })], from 'ondocs/starlight' ${siteFirst}`,
      ],
      [vitepress(", sitemap: { hostname: 'https://acme.dev' }"), `${withOndocs} ${named}`],
      [vitepress(', sitemap: { hostname: process.env.SITE_URL }'), `${withOndocs} ${named}`],
      [
        vitepress(''),
        `${withOndocs} (mcp points agents that read llms.txt at the MCP endpoint; set sitemap.hostname in .vitepress/config.mts to the site's URL first, which the path is resolved against)`,
      ],
      // The script tag takes no `mcp`.
      [
        { 'hugo.toml': 'baseURL = "/site/"\ntitle = "Acme"\n', 'vercel.json': '{}' },
        'data-endpoint="/api/ask" defer></script>',
      ],
    ];
    for (const [contents, expected] of cases) {
      await rm(cwd, { recursive: true, force: true });
      await mkdir(cwd, { recursive: true });
      await site(contents);
      const result = await run(['--dry-run']);
      expect(result.code).toBe(0);
      expect(steps(result.stdout)).toContain(expected);
      // A URL init cannot know is never filled in for it.
      expect(result.stdout).not.toMatch(/mcp: 'https?:/);
    }
  });

  it('lists what a static site’s functions import, with npm init when it has no package.json', async () => {
    const page = { 'public/index.html': '<!doctype html><title>Acme</title><main>Hi</main>' };
    const step = (stdout: string) =>
      stdout.split('\n').find((line) => /\b(?:npm|pnpm) (?:i|init|add)\b/.test(line));

    // No package.json: the host installs the functions' packages from one, so make it first.
    for (const host of ['vercel', 'netlify', 'cloudflare']) {
      await rm(cwd, { recursive: true, force: true });
      await mkdir(cwd, { recursive: true });
      await site(page);
      const result = await run(['--yes', '--dry-run', '--out', 'public', '--host', host]);
      expect([host, result.code]).toEqual([host, 0]);
      expect([host, step(result.stdout)]).toEqual([
        host,
        '  1. npm init -y && npm i ondocs ai @ai-sdk/openai (the functions import them, and the host installs them from package.json)',
      ]);
    }

    // A package.json: what it lacks, with its package manager.
    await rm(cwd, { recursive: true, force: true });
    await mkdir(cwd, { recursive: true });
    await site({
      ...page,
      'package.json': JSON.stringify({ name: 'acme', dependencies: { ai: '7' } }),
      'pnpm-lock.yaml': '',
    });
    const withPackage = await run(['--yes', '--dry-run', '--out', 'public', '--host', 'vercel']);
    expect(step(withPackage.stdout)).toBe('  1. pnpm add ondocs @ai-sdk/openai');

    // On GitHub Pages the Worker has a package.json of its own, and the site needs nothing.
    await rm(cwd, { recursive: true, force: true });
    await mkdir(cwd, { recursive: true });
    await site(page);
    const pages = await run([
      '--yes',
      '--dry-run',
      '--out',
      'public',
      '--host',
      'github-pages',
      '--site-url',
      'https://acme.github.io/site',
    ]);
    expect(pages.code).toBe(0);
    expect(step(pages.stdout)).toBeUndefined();
  });

  it('needs the site URL for GitHub Pages, as the Worker reads the live index', async () => {
    await site({ 'docusaurus.config.ts': "export default { title: 'Acme' };\n" });
    const result = await run(['--host', 'github-pages']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('pass --site-url');
    const given = await run([
      '--host',
      'github-pages',
      '--site-url',
      'https://acme.github.io/docs/',
    ]);
    expect(given.code).toBe(0);
    expect(await readFile(join(cwd, 'ondocs-worker/wrangler.jsonc'), 'utf8')).toContain(
      '"SITE_URL": "https://acme.github.io/docs"',
    );
  });

  it('answers GitHub Pages with Workers AI and no key, or with OpenAI when asked', async () => {
    await site({
      'docusaurus.config.ts': "export default { title: 'Acme', url: 'https://a.dev' };\n",
    });
    const zeroKey = await run(['--host', 'github-pages']);
    expect(zeroKey.code).toBe(0);
    const worker = await readFile(join(cwd, 'ondocs-worker/src/index.ts'), 'utf8');
    expect(worker).toContain("import { createWorkersAI } from 'workers-ai-provider';");
    expect(worker).not.toContain('OPENAI_API_KEY');
    expect(await readFile(join(cwd, 'ondocs-worker/wrangler.jsonc'), 'utf8')).toContain(
      '"ai": { "binding": "AI" },',
    );
    expect(zeroKey.stdout).not.toContain('wrangler secret put');

    const openai = await run(['--host', 'github-pages', '--provider', 'openai', '--yes']);
    expect(openai.code).toBe(0);
    expect(await readFile(join(cwd, 'ondocs-worker/src/index.ts'), 'utf8')).toContain(
      "import { createOpenAI } from '@ai-sdk/openai';",
    );
    expect(openai.stdout).toContain('npx wrangler secret put OPENAI_API_KEY');
  });

  it('runs Workers AI only in the Worker it writes for GitHub Pages', async () => {
    await site({ ...DOCUSAURUS, 'vercel.json': '{}' });
    const result = await run(['--provider', 'workers-ai']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--provider workers-ai is for --host github-pages');
    expect((await run(['--provider', 'anthropic'])).stderr).toContain(
      '--provider must be workers-ai or openai.',
    );
  });

  it('says what to add by hand when a config file already configures the function', async () => {
    await site({
      ...DOCUSAURUS,
      'netlify.toml': '[functions.ask]\n  node_bundler = "esbuild"\n',
    });
    const result = await run([]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      'by hand    netlify.toml already configures [functions.ask]; add included_files = ["build/ask-index.json"] to it',
    );
    expect(await readFile(join(cwd, 'netlify.toml'), 'utf8')).toBe(
      '[functions.ask]\n  node_bundler = "esbuild"\n',
    );
  });

  it('leaves a vercel.json it cannot parse alone', async () => {
    await site({ ...DOCUSAURUS, 'vercel.json': '{ "functions": ' });
    const result = await run([]);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/by hand {4}vercel\.json is not valid JSON/);
  });

  it('reads no .env file', async () => {
    await site({ ...DOCUSAURUS, 'vercel.json': '{}', '.env': 'OPENAI_API_KEY=sk-not-for-init\n' });
    const result = await run([]);
    expect(result.code).toBe(0);
    expect(result.env).toEqual({});
    expect(result.stdout).not.toContain('sk-not-for-init');
  });

  it('rejects an unknown host and a relative site URL', async () => {
    await site(DOCUSAURUS);
    expect((await run(['--host', 'heroku'])).stderr).toContain('--host must be one of');
    expect((await run(['--host', 'github-pages', '--site-url', 'acme.dev'])).stderr).toContain(
      '--site-url must be an absolute http(s) URL',
    );
  });

  it('prints its help', async () => {
    const result = await run(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('It never deploys anything and never');
  });
});

describe('wranglerWorkerConfig', () => {
  it('adds main and the ASSETS binding to a TOML config', () => {
    expect(
      wranglerWorkerConfig(
        'wrangler.toml',
        'name = "docs"\ncompatibility_date = "2026-09-01"\n\n[assets]\ndirectory = "./build"\n',
      ),
    ).toEqual({
      content:
        'name = "docs"\nmain = "worker/ondocs.ts"\ncompatibility_date = "2026-09-01"\n\n[assets]\nbinding = "ASSETS"\ndirectory = "./build"\n',
    });
  });

  it('edits a JSONC config as text, keeping its comments', () => {
    const source =
      '{\n  // The docs.\n  "name": "docs",\n  "assets": {\n    "directory": "./build"\n  }\n}\n';
    expect(wranglerWorkerConfig('wrangler.jsonc', source)).toEqual({
      content:
        '{\n  // The docs.\n  "name": "docs",\n  "main": "worker/ondocs.ts",\n  "assets": {\n    "binding": "ASSETS",\n    "directory": "./build"\n  }\n}\n',
    });
  });

  it('leaves a Worker with its own entry point to its owner', () => {
    expect(
      wranglerWorkerConfig(
        'wrangler.toml',
        'main = "src/index.ts"\n[assets]\ndirectory = "dist"\n',
      ),
    ).toEqual({
      error:
        'wrangler.toml has its own entry point (main = "src/index.ts"): call ondocs(request, env) from worker/ondocs.ts in it',
    });
    expect(
      wranglerWorkerConfig(
        'wrangler.json',
        '{ "main": "src/index.ts", "assets": { "directory": "d" } }',
      ),
    ).toHaveProperty('error');
  });

  it('needs static assets, or a binding named ASSETS', () => {
    expect(wranglerWorkerConfig('wrangler.toml', 'name = "x"\n')).toHaveProperty('error');
    expect(
      wranglerWorkerConfig('wrangler.toml', '[assets]\nbinding = "STATIC"\ndirectory = "d"\n'),
    ).toEqual({
      error: 'wrangler.toml: the static assets\' binding must be "ASSETS" (binding = "STATIC")',
    });
  });
});

describe('the templates’ helpers', () => {
  it('wraps comments at 100 columns', () => {
    const text = comment('word '.repeat(60));
    expect(text.split('\n').every((line) => line.length <= 100 && line.startsWith('// '))).toBe(
      true,
    );
  });

  it('tells a template’s placeholder URL from a site’s', () => {
    for (const url of [
      'https://your-docusaurus-site.example.com',
      'https://example.org/',
      'http://localhost:3000',
      'https://docs.test',
      'https://your-site.netlify.app',
    ]) {
      expect([url, placeholderUrl(url)]).toEqual([url, true]);
    }
    for (const url of ['https://acme.github.io/docs', 'https://docs.acme.dev', 'not a url']) {
      expect([url, placeholderUrl(url)]).toEqual([url, false]);
    }
  });

  it('names a Worker from the site', () => {
    expect(workerName('Acme Docs')).toBe('acme-docs-ask');
    expect(workerName('Ünïcode & Co.')).toBe('unicode-co-ask');
    expect(workerName('***')).toBe('docs-ask');
    expect(workerName('a'.repeat(80)).length).toBeLessThanOrEqual(63);
  });
});
