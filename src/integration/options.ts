// Checking a plugin's options as the site's config gives them, which TypeScript may not have seen
// (a plugin tuple in docusaurus.config.ts is untyped, astro.config.mjs is JavaScript): an option
// that is misspelled, or from another version of ondocs, fails the build with what to change,
// instead of being ignored. Node.js only, as the plugins are.
// The default import: a site's VitePress config, which esbuild bundles, cannot take a JSON's names.
import manifest from '../../package.json' with { type: 'json' };
import { warnDeprecated } from '../deprecation';
import type { OndocsDialogOptions } from '../embed/options';
import type { SourceUrls } from '../react/answer';
import { LABEL_NAMES, type AskDialogLabels } from '../react/labels';
import type { ChunkingOptions } from '../types';
import type { IndexOptions, McpOption } from './build';
import type { LocaleDialogOptions } from './launcher';
import type { LlmsTxtOption } from './llms';

/** What an option's value must be. */
export interface OptionRule {
  /** What the value should be, for the message: `a string`, `a list of paths`. */
  readonly expected: string;
  /** What to do instead, after the message, for a value it does not accept. */
  readonly advice?: string;
  /** Whether the value is of this kind at all: a string for a string, an object for a shape. */
  accepts(value: unknown): boolean;
  /** Adds what is wrong with `value`, which the rule accepts, at `path` to `issues`. */
  check(value: unknown, path: string, issues: string[]): void;
}

const leaf = (expected: string, accepts: (value: unknown) => boolean): OptionRule => ({
  expected,
  accepts,
  check: () => undefined,
});

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `value` as the message quotes it: `'/changelog'`, `["/changelog"]`, `a function`. */
function shown(value: unknown): string {
  if (typeof value === 'string') return `'${value}'`;
  if (typeof value === 'function') return 'a function';
  try {
    const json = JSON.stringify(value);
    return json.length > 60 ? `${json.slice(0, 57)}...` : json;
  } catch {
    return String(value);
  }
}

const string = leaf('a string', (value) => typeof value === 'string');
const boolean = leaf('true or false', (value) => typeof value === 'boolean');
const number = leaf('a number', (value) => typeof value === 'number' && Number.isFinite(value));
const func = leaf('a function', (value) => typeof value === 'function');
/** Anything: for a value checked elsewhere, such as an AI SDK model. */
const anything = leaf('anything', () => true);
/** An object, such as an AI SDK model or a provider's options. */
const object = leaf('an object', isPlainObject);

/** One of `values`, such as `'last'` or `'all'`. */
function literal(...values: readonly (string | number | boolean)[]): OptionRule {
  return leaf(values.map(shown).join(' or '), (value) =>
    values.includes(value as string | number | boolean),
  );
}

/** A value of any of `rules`, checked by the first that accepts it. */
function oneOf(...rules: readonly OptionRule[]): OptionRule {
  return {
    expected: rules.map((rule) => rule.expected).join(', or '),
    accepts: (value) => rules.some((rule) => rule.accepts(value)),
    check(value, path, issues) {
      rules.find((rule) => rule.accepts(value))?.check(value, path, issues);
    },
  };
}

/** A list, each of whose items is checked by `rule`. `expected` names it, with an example. */
function listOf(rule: OptionRule, expected: string): OptionRule {
  return {
    expected,
    accepts: Array.isArray,
    check(value, path, issues) {
      (value as unknown[]).forEach((item, i) => {
        checkValue(rule, item, `${path}[${String(i)}]`, issues);
      });
    },
  };
}

/** An object whose keys are the site's own, such as locales, each value checked by `rule`. */
function recordOf(rule: OptionRule, expected: string): OptionRule {
  return {
    expected,
    accepts: isPlainObject,
    check(value, path, issues) {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        checkValue(rule, item, `${path}.${key}`, issues);
      }
    },
  };
}

/** The rules of an object's options, one per key of `Options`, none missing and none extra. */
export type OptionRules<Options> = { [Key in keyof Required<Options>]: OptionRule };

export interface OptionShapeExtras {
  /** Old names that still work, and the names they are now: a near miss suggests the new one. */
  renamed?: Record<string, string>;
  /**
   * Old names that still work, which say once, given, what they are called now. Their values
   * are checked by their own rules.
   */
  deprecated?: Record<string, string>;
  /** What to say about a key that is not an option here but is elsewhere, such as `navbar`. */
  hints?: Record<string, string>;
  /** Keys that are options of the type but not here, and what to do instead. */
  notHere?: Record<string, string>;
}

/** An object with known keys: one that is not an option fails, with the nearest that is. */
function shape<Options>(rules: OptionRules<Options>, extras: OptionShapeExtras = {}): OptionRule {
  const known = Object.keys(rules);
  const current = known.filter(
    (key) =>
      !(key in (extras.renamed ?? {})) &&
      !(key in (extras.deprecated ?? {})) &&
      !(key in (extras.notHere ?? {})),
  );
  return {
    expected: 'an object',
    accepts: isPlainObject,
    check(value, path, issues) {
      const at = (key: string) => (path ? `${path}.${key}` : key);
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (item === undefined) continue;
        const notHere = extras.notHere?.[key];
        if (notHere !== undefined) {
          issues.push(`${at(key)} is not an option here: ${notHere}`);
          continue;
        }
        const rule = (rules as Record<string, OptionRule | undefined>)[key];
        if (rule) {
          const now = extras.deprecated?.[key];
          if (now !== undefined) warnDeprecated(at(key), at(now));
          checkValue(rule, item, at(key), issues);
          continue;
        }
        const hint = extras.hints?.[key];
        if (hint !== undefined) {
          issues.push(`${at(key)} is not an option: ${hint}`);
          continue;
        }
        const near = nearest(key, known);
        const suggestion =
          near === undefined
            ? undefined
            : (extras.renamed?.[near] ?? extras.deprecated?.[near] ?? near);
        issues.push(
          suggestion === undefined
            ? `${at(key)} is not an option. The options${path ? ` of ${path}` : ''} are ${current.join(', ')}.`
            : `${at(key)} is not an option. Did you mean ${at(suggestion)}?`,
        );
      }
    },
  };
}

/** Checks `value` against `rule` at `path`, adding what is wrong to `issues`. */
function checkValue(rule: OptionRule, value: unknown, path: string, issues: string[]): void {
  if (value === undefined) return;
  if (!rule.accepts(value)) {
    const advice = rule.advice ? ` ${rule.advice}` : '';
    issues.push(`${path} must be ${rule.expected}, not ${shown(value)}.${advice}`);
    return;
  }
  rule.check(value, path, issues);
}

/**
 * The edits that turn `a` into `b`: insertions, deletions, substitutions, and two letters swapped
 * (`titel` for `title`) as one.
 */
function distance(a: string, b: string): number {
  const rows: number[][] = [Array.from({ length: b.length + 1 }, (_, j) => j)];
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const above = rows[i - 1] ?? [];
      let best = Math.min(
        (above[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (above[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, (rows[i - 2]?.[j - 2] ?? 0) + 1);
      }
      row[j] = best;
    }
    rows.push(row);
  }
  return rows[a.length]?.[b.length] ?? 0;
}

/** The known key `key` is most likely a slip for: the same but for case, or a typo or two away. */
function nearest(key: string, known: readonly string[]): string | undefined {
  const lower = key.toLowerCase();
  const same = known.find((candidate) => candidate.toLowerCase() === lower);
  if (same) return same;
  const limit = Math.max(1, Math.floor(key.length / 4));
  let best: { key: string; distance: number } | undefined;
  for (const candidate of known) {
    const d = distance(lower, candidate.toLowerCase());
    if (d <= limit && (!best || d < best.distance)) best = { key: candidate, distance: d };
  }
  return best?.key;
}

/**
 * Throws, naming each option that is not right and what to change, when `options` do not fit
 * `rules` (`optionRules.shape(…)`); `plugin` names who took them, such as `ondocs/docusaurus`.
 * An old name the rules list as `deprecated` says once what it is called now.
 */
export function checkOptions(plugin: string, rules: OptionRule, options: unknown): void {
  if (options === undefined) return;
  const issues: string[] = [];
  if (!rules.accepts(options)) {
    throw new Error(
      `${plugin}: the options must be an object, such as { endpoint: '/api/ask' }, not ${shown(options)}.`,
    );
  }
  rules.check(options, '', issues);
  if (issues.length === 0) return;
  if (issues.length === 1) {
    throw new Error(`${plugin} (ondocs ${manifest.version}): ${String(issues[0])}`);
  }
  throw new Error(
    `${plugin} (ondocs ${manifest.version}): ${String(issues.length)} options to fix:\n${issues.map((issue) => `- ${issue}`).join('\n')}`,
  );
}

// The rules the plugins share.

const strings = listOf(string, "a list of strings, such as ['How do I install it?']");

const chunkingRules = shape<ChunkingOptions>({ maxChars: number, overlap: number });

/** The build options every plugin takes. */
const indexRules: OptionRules<IndexOptions> = {
  embedding: string,
  dimensions: number,
  embeddingModel: anything,
  embeddingProviderOptions: object,
  chunking: chunkingRules,
};

const labelRules = shape<AskDialogLabels>(
  Object.fromEntries(LABEL_NAMES.map((name) => [name, string])) as OptionRules<AskDialogLabels>,
);

/** The dialog's options in the embed, which every plugin's `dialog` has. */
const dialogRules: OptionRules<OndocsDialogOptions> = {
  labels: labelRules,
  title: string,
  placeholder: string,
  suggestions: strings,
  shortcut: oneOf(string, literal(false)),
  launcher: oneOf(boolean, string),
  buttonLabel: oneOf(string, literal(false)),
  links: literal('all', 'sources'),
  sourceUrls: shape<SourceUrls>({ pages: recordOf(string, 'an object of URLs'), base: string }),
  challenge: shape<{ turnstile: string }>({ turnstile: string }),
};

/** `buttonLabel`, the launcher's name before 0.9, which still works. */
const dialogRenamed = { buttonLabel: 'launcher' };

const localeDialogRules = shape<LocaleDialogOptions>(
  {
    labels: labelRules,
    placeholder: string,
    suggestions: strings,
    launcher: oneOf(boolean, string),
    buttonLabel: oneOf(string, literal(false)),
    title: string,
  },
  { renamed: dialogRenamed },
);

/** Each locale's dialog options, by its path prefix or locale. */
const localesRules = recordOf(
  localeDialogRules,
  "an object of locales, such as { fr: { title: 'Demander' } }",
);

const mcpRules = oneOf(string, shape<Exclude<McpOption, string>>({ url: string, name: string }));

const llmsTxtRules = oneOf(
  boolean,
  shape<Exclude<LlmsTxtOption, boolean>>({
    index: boolean,
    full: boolean,
    markdown: boolean,
    title: string,
    description: string,
  }),
);

/** `exclude`: URL paths, not globs or a selector. */
const excludeRules = listOf(string, "a list of paths, such as ['/changelog']");

/** A selector option, for which a list of paths to leave out is easily mistaken. */
const selector = (example: string): OptionRule => ({
  ...string,
  expected: `a selector, such as '${example}'`,
  advice: "To leave pages out, use exclude: ['/changelog'].",
});

/** The rules a plugin's options are checked with, and the ones every plugin of ondocs shares. */
export interface OptionRuleSet {
  string: OptionRule;
  boolean: OptionRule;
  /** A finite number. */
  number: OptionRule;
  func: OptionRule;
  /** An object, such as a provider's options. */
  object: OptionRule;
  /** Anything: for a value checked elsewhere, such as an AI SDK model. */
  anything: OptionRule;
  /** One of `values`, such as `'last'` or `'all'`. */
  literal: (...values: readonly (string | number | boolean)[]) => OptionRule;
  /** A value of any of `rules`, checked by the first that takes its kind. */
  oneOf: (...rules: readonly OptionRule[]) => OptionRule;
  /** A list, each item checked by `rule`; `expected` names it, with an example. */
  listOf: (rule: OptionRule, expected: string) => OptionRule;
  /** An object whose keys are the site's own, such as locales, each value checked by `rule`. */
  recordOf: (rule: OptionRule, expected: string) => OptionRule;
  /** An object with known keys, one rule each: a key that is not one fails, with the nearest. */
  shape: <Options>(rules: OptionRules<Options>, extras?: OptionShapeExtras) => OptionRule;
  /** A selector option, such as `contentSelector`, given `example`. */
  selector: (example: string) => OptionRule;
  /** The build options every plugin takes, to spread into its own. */
  index: OptionRules<IndexOptions>;
  /** `chunking`, which `index` has. */
  chunking: OptionRule;
  /** The dialog's options in the embed, which every plugin's `dialog` has, to spread. */
  dialog: OptionRules<OndocsDialogOptions>;
  /** The dialog's renamed options, for `shape`'s `renamed`. */
  dialogRenamed: Record<string, string>;
  /** `dialog.locales`: each locale's dialog options. */
  locales: OptionRule;
  mcp: OptionRule;
  llmsTxt: OptionRule;
  /** `exclude`: a list of URL paths. */
  exclude: OptionRule;
}

/** The rules {@link checkOptions} checks options with. */
export const optionRules: OptionRuleSet = {
  string,
  boolean,
  number,
  func,
  object,
  anything,
  literal,
  oneOf,
  listOf,
  recordOf,
  shape,
  selector,
  index: indexRules,
  chunking: chunkingRules,
  dialog: dialogRules,
  dialogRenamed,
  locales: localesRules,
  mcp: mcpRules,
  llmsTxt: llmsTxtRules,
  exclude: excludeRules,
};
