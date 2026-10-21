// The plugins check their options as the site's config gives them: a misspelled option, or one
// from another version of ondocs, fails the build with what to change, instead of being ignored
// (and, for the dialog's options, shipped to every page as they are).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { AstroIntegration } from 'astro';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { version } from '../package.json' with { type: 'json' };
import astroOndocs from '../src/astro';
import docusaurusOndocs, * as docusaurus from '../src/docusaurus';
import starlightOndocs from '../src/starlight';
import { withOndocs } from '../src/vitepress';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ondocs-options-'));
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('AI_GATEWAY_API_KEY', '');
  vi.stubEnv('ASK_ENDPOINT', '');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const context = () => ({
  siteDir: root,
  siteConfig: { title: 'Acme Docs' },
  baseUrl: '/',
  i18n: { currentLocale: 'en' },
});

/** Options as an untyped config gives them. */
const untyped = (options: Record<string, unknown>): never => options as never;

/** The Docusaurus plugin's validateOptions, as Docusaurus calls it. */
const validateOptions = (
  docusaurus as {
    validateOptions?: (args: {
      options: unknown;
      validate: (s: unknown, o: unknown) => unknown;
    }) => unknown;
  }
).validateOptions;

/** The Astro integration the Starlight plugin adds, as Starlight's config:setup makes it. */
function starlight(options: Record<string, unknown>): AstroIntegration | undefined {
  const plugin = starlightOndocs(untyped(options));
  let added: AstroIntegration | undefined;
  const setup = plugin.hooks['config:setup'] as unknown as (options: unknown) => void;
  setup({
    config: { title: 'Acme Docs' },
    astroConfig: { root: pathToFileURL(`${root}/`) },
    updateConfig: () => undefined,
    addIntegration: (integration: AstroIntegration) => {
      added = integration;
    },
  });
  return added;
}

/** The typos from the report: a top-level option, and three of the dialog's. */
const TYPOS = {
  embeding: 'mock',
  dialog: { shortcutt: 'j', buttonlabel: 'Ask', sugestions: ['Hi'] },
};

const TYPO_ISSUES = [
  '- embeding is not an option. Did you mean embedding?',
  '- dialog.shortcutt is not an option. Did you mean dialog.shortcut?',
  // `buttonLabel` still works, but `launcher` is its name now.
  '- dialog.buttonlabel is not an option. Did you mean dialog.launcher?',
  '- dialog.sugestions is not an option. Did you mean dialog.suggestions?',
];

describe('ondocs/docusaurus', () => {
  it('fails on misspelled options, naming each with the option it is near', () => {
    expect(() => docusaurusOndocs(context(), untyped(TYPOS))).toThrow(
      [`ondocs/docusaurus (ondocs ${version}): 4 options to fix:`, ...TYPO_ISSUES].join('\n'),
    );
  });

  it('exports validateOptions, which Docusaurus runs before the plugin', () => {
    expect(typeof validateOptions).toBe('function');
    const validate = vi.fn();
    const options = { embedding: 'mock', dialog: { navbar: true, suggestions: ['Hi'] } };
    // The options as they are: Docusaurus passes what it returns to the plugin.
    expect(validateOptions?.({ options, validate })).toBe(options);
    expect(() => validateOptions?.({ options: TYPOS, validate })).toThrow(TYPO_ISSUES[0]?.slice(2));
    expect(validate).not.toHaveBeenCalled();
  });

  it('checks each locale’s dialog options and labels', () => {
    expect(() =>
      docusaurusOndocs(
        context(),
        untyped({ dialog: { labels: { lancher: 'Ask' }, locales: { fr: { titel: 'Demander' } } } }),
      ),
    ).toThrow(
      [
        `ondocs/docusaurus (ondocs ${version}): 2 options to fix:`,
        '- dialog.labels.lancher is not an option. Did you mean dialog.labels.launcher?',
        '- dialog.locales.fr.titel is not an option. Did you mean dialog.locales.fr.title?',
      ].join('\n'),
    );
  });

  it('says what a value should be, and lists the options when nothing is near', () => {
    expect(() => docusaurusOndocs(context(), untyped({ exclude: '/changelog' }))).toThrow(
      `ondocs/docusaurus (ondocs ${version}): exclude must be a list of paths, such as ['/changelog'], not '/changelog'.`,
    );
    expect(() => docusaurusOndocs(context(), untyped({ colour: 'red' }))).toThrow(
      /colour is not an option\. The options are embedding, dimensions, .*endpoint, .*dialog/,
    );
  });

  it('takes every option it documents, and the deprecated names', () => {
    expect(() =>
      docusaurusOndocs(context(), {
        id: 'default',
        embedding: 'mock',
        dimensions: 64,
        chunking: { maxChars: 800, overlap: 100 },
        endpoint: 'https://acme.dev/api/ask',
        indexFile: 'ask.json',
        exclude: ['/changelog'],
        versions: 'all',
        mcp: { url: 'https://acme.dev/api/mcp', name: 'acme' },
        llmsTxt: { full: false, title: 'Acme' },
        dialog: {
          title: 'Ask Acme',
          navbar: 'Ask',
          labels: { launcher: 'Ask', footer: 'AI answers' },
          placeholder: 'Ask anything',
          suggestions: ['How do I start?'],
          shortcut: false,
          buttonLabel: 'Ask',
          links: 'sources',
          sourceUrls: { pages: { '/docs/a': '/a' }, base: 'https://docs.acme.dev' },
          challenge: { turnstile: '0x4AAA' },
          locales: { fr: { title: 'Demander', suggestions: ['Comment ?'], launcher: false } },
        },
      }),
    ).not.toThrow();
  });
});

describe('ondocs/astro', () => {
  it('fails as the integration is made, before Astro runs it', () => {
    expect(() => astroOndocs(untyped(TYPOS))).toThrow(
      [`ondocs/astro (ondocs ${version}): 4 options to fix:`, ...TYPO_ISSUES].join('\n'),
    );
  });

  it('tells a list of paths in a selector option to use exclude', () => {
    // Before, this threw "selector.split is not a function" as the site built.
    expect(() => astroOndocs(untyped({ ignoreSelector: ['/changelog'] }))).toThrow(
      `ondocs/astro (ondocs ${version}): ignoreSelector must be a selector, such as '.toc, .comments', not ["/changelog"]. To leave pages out, use exclude: ['/changelog'].`,
    );
    expect(() => astroOndocs(untyped({ ignore: ['/changelog'] }))).toThrow(
      'ignore must be a selector',
    );
  });

  it('says the header button is Starlight’s, and checks route', () => {
    expect(() =>
      astroOndocs(untyped({ dialog: { navbar: true }, route: { modle: 'mock' } })),
    ).toThrow(
      [
        `ondocs/astro (ondocs ${version}): 2 options to fix:`,
        '- dialog.navbar is not an option: the header button is the Starlight plugin’s (ondocs/starlight). With ondocs/astro, the dialog opens from its floating button or ⌘/Ctrl+I.',
        '- route.modle is not an option. Did you mean route.model?',
      ].join('\n'),
    );
  });
});

describe('ondocs/starlight', () => {
  it('takes dialog.navbar, and fails on a misspelled option', () => {
    expect(starlight({ dialog: { navbar: true, suggestions: ['Hi'] } })).toBeDefined();
    expect(() => starlight({ dialog: { navbr: true } })).toThrow(
      `ondocs/starlight (ondocs ${version}): dialog.navbr is not an option. Did you mean dialog.navbar?`,
    );
  });

  it('takes no selector: it indexes what Starlight’s search does', () => {
    for (const option of ['contentSelector', 'ignoreSelector', 'content', 'ignore']) {
      expect(() => starlight({ [option]: 'main' })).toThrow(
        `ondocs/starlight (ondocs ${version}): ${option} is not an option here: the Starlight plugin indexes what Starlight’s search does. Mark what to leave out with data-pagefind-ignore.`,
      );
    }
  });
});

describe('ondocs/vitepress', () => {
  it('fails as withOndocs is called', () => {
    expect(() => withOndocs({}, untyped(TYPOS))).toThrow(
      [`ondocs/vitepress (ondocs ${version}): 4 options to fix:`, ...TYPO_ISSUES].join('\n'),
    );
    expect(() => withOndocs({}, untyped({ siteURL: 'https://acme.dev' }))).toThrow(
      'siteURL is not an option. Did you mean siteUrl?',
    );
  });
});
