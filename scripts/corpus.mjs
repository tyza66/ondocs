// Fetches the real-world docs the tests search, each at a pinned commit, so the counts they check
// never move under a pull request: docusaurus.io's docs, which test/corpus.test.ts searches, and
// Astro's and Vitest's, which test/eval/real-questions.test.ts asks Stack Overflow's questions of
// with docusaurus.io's (test/eval/README.md). Only each repository's docs folder is checked out
// (a sparse, blobless clone of a few MB).
//
//   node scripts/corpus.mjs            # all three into .corpus/ (git-ignored), once
//   node scripts/corpus.mjs .corpus astro vitest
//   ONDOCS_CORPUS=.corpus pnpm vitest run test/corpus.test.ts
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** facebook/docusaurus main on 2026-10-09: 92 docs pages, as the 2026-10-10 audit measured. */
export const DOCUSAURUS_COMMIT = 'c245217563f6491fdb79bf5ac91bfa16536e5de9';

/**
 * @typedef {object} Corpus
 * @property {string} name The folder under the corpus directory, and the eval file's prefix.
 * @property {string} title
 * @property {string} repository
 * @property {string} commit
 * @property {string} docs The docs folder in the repository.
 * @property {string[]} sparse What the sparse checkout takes.
 * @property {'docusaurus' | 'starlight' | 'none'} framework
 * @property {string} baseUrl
 * @property {string[]} [ignore]
 * @property {string} site
 * @property {string} license
 */

/**
 * Each corpus: where its docs come from, at which commit, and how `ondocs index` reads them so
 * that a page's URL is the path the live site serves it at.
 * @type {Corpus[]}
 */
export const CORPORA = [
  {
    name: 'docusaurus',
    title: "docusaurus.io's docs",
    repository: 'facebook/docusaurus',
    commit: DOCUSAURUS_COMMIT,
    docs: 'website/docs',
    sparse: ['/website/docs/'],
    framework: 'docusaurus',
    baseUrl: '/docs',
    site: 'https://docusaurus.io',
    license: 'CC BY 4.0, by Meta Platforms',
  },
  {
    name: 'astro',
    title: "Astro's docs, in English",
    repository: 'withastro/docs',
    // main on 2026-10-13.
    commit: '3480e4b84e9d114177d80acc9105dad20bd48a17',
    docs: 'src/content/docs/en',
    sparse: ['/src/content/docs/en/'],
    framework: 'starlight',
    baseUrl: '/en',
    site: 'https://docs.astro.build',
    license: 'MIT, by the Astro contributors',
  },
  {
    name: 'vitest',
    title: "Vitest's docs",
    repository: 'vitest-dev/vitest',
    // main on 2026-10-14.
    commit: '2899eb3e97931aaaba561013f483cb671506eea4',
    docs: 'docs',
    // The pages only: the folder also holds the site's images, fonts and Vue components.
    sparse: ['/docs/**/*.md', '!/docs/.vitepress/', '!/docs/public/'],
    framework: 'none',
    baseUrl: '/',
    // What the site's VitePress config leaves out (srcExclude): no page has these URLs.
    ignore: ['guide/examples/**', 'guide/cli-generated.md', 'AGENTS.md'],
    site: 'https://vitest.dev',
    license: 'MIT, by VoidZero Inc. and Vitest contributors',
  },
];

/**
 * The `ondocs index` arguments that index `corpus`, fetched into `dir`, as its site serves it.
 * The real-question evals' files (test/eval/*-title.yaml) give the same command.
 * @param {string} dir
 * @param {Corpus} corpus
 * @returns {string[]}
 */
export function indexArgs(dir, corpus) {
  return [
    join(dir, corpus.name, corpus.docs),
    '--framework',
    corpus.framework,
    '--base-url',
    corpus.baseUrl,
    ...(corpus.ignore ?? []).flatMap((pattern) => ['--ignore', pattern]),
  ];
}

/**
 * Fetches `corpus` into `<dir>/<name>`, unless it is there at its commit.
 * @param {string} dir
 * @param {Corpus} corpus
 */
function fetchCorpus(dir, corpus) {
  const target = join(dir, corpus.name);
  const git = (/** @type {string[]} */ ...args) =>
    execFileSync('git', args, { cwd: target, stdio: 'inherit' });
  if (existsSync(join(target, corpus.docs))) {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: target }).toString().trim();
    if (head === corpus.commit) {
      console.log(`${target} is at ${corpus.commit}.`);
      return;
    }
  }
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  git('init', '--quiet');
  git('remote', 'add', 'origin', `https://github.com/${corpus.repository}.git`);
  git('sparse-checkout', 'set', '--no-cone', ...corpus.sparse);
  git('fetch', '--quiet', '--depth', '1', '--filter=blob:none', 'origin', corpus.commit);
  git('checkout', '--quiet', 'FETCH_HEAD');
  console.log(`Fetched ${corpus.title} at ${corpus.commit} into ${target}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const [dir = join(root, '.corpus'), ...names] = process.argv.slice(2);
  const unknown = names.filter((name) => !CORPORA.some((corpus) => corpus.name === name));
  if (unknown.length > 0) {
    console.error(
      `✗ No corpus named ${unknown.join(', ')}: ${CORPORA.map(({ name }) => name).join(', ')}`,
    );
    process.exit(2);
  }
  for (const corpus of CORPORA) {
    if (names.length === 0 || names.includes(corpus.name)) fetchCorpus(dir, corpus);
  }
}
