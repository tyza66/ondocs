---
# Generated from examples/nextjs/content/docs/upgrading.md by scripts/sync-example-docs.mjs. Edit that file instead.
title: 'Upgrading'
description: 'The options each minor version renames, old name to new, and the defaults that change with them.'
---

# Upgrading

Before 1.0, a minor version can rename an option. The old name keeps working until 1.0, and says once what it is called now: in the build's output for the plugins, in the server's log for the endpoint, in the terminal for the CLI, and in the browser's console for the dialog.

## 0.14: one meaning per name

0.14 renames the options whose names meant two things: `ignore` was a selector in the plugins but a list of file globs in `ondocs index` and `loadDirectory`, the content selector was `content` in the plugins but `root` in `loadBuiltPage`, `--out` was the file `ondocs index` writes but the folder `ondocs init` reads, and `rateLimitFailure` also decides what happens when the budget store or the bot check fails. The old names still work, with a warning, until 1.0 removes them.

| Where                                     | Before 0.14                      | From 0.14                                           |
| ----------------------------------------- | -------------------------------- | --------------------------------------------------- |
| `ondocs/astro`, `ondocs/vitepress`        | `content: '.prose'`              | `contentSelector: '.prose'`                         |
| `ondocs/astro`, `ondocs/vitepress`        | `ignore: '.toc'`                 | `ignoreSelector: '.toc'`                            |
| `loadBuiltPage` from `ondocs/integration` | `root: 'main'`, `ignore: '.toc'` | `contentSelector: 'main'`, `ignoreSelector: '.toc'` |
| `createAskHandler`, `createMcpHandler`    | `rateLimitFailure: 'open'`       | `failureMode: 'open'`                               |
| `ondocs init`                             | `--out public`                   | `--build-dir public`                                |

`ignore` keeps its meaning where it is a list of globs: `ondocs index --ignore`, the CLI config module's `ignore` and `loadDirectory`'s. To leave whole pages out of a plugin's index, use `exclude`, as before.

Three more changes in 0.14 make a mistake fail where you can see it, instead of on the first question:

- **The plugins check their options.** An option that is misspelled, or not one of the installed version's, fails the build and names the option nearest to it: `dialog.sugestions is not an option. Did you mean dialog.suggestions?`. A value of the wrong kind does too, such as `exclude: '/changelog'` for `exclude: ['/changelog']`. `ondocs/docusaurus` exports `validateOptions`, which Docusaurus runs before it loads the plugin.
- **The endpoints check what they are given as they are made.** `createAskHandler` and `createMcpHandler` throw on an `index` that is a path (`'./ask-index.json'` for `import index from './ask-index.json'`), JSON that is not an ondocs index, or an index of a format the installed version does not read, and `createAskHandler` on a missing `model`. They now take a Promise of the index, as `import('./ask-index.json')` gives.
- **The CLI's config module takes `embedding` and `dimensions`**, as the plugins do, and fails on an option it does not have. The flags still win over it.

To find the old names in a site:

```sh
git grep -nE 'rateLimitFailure|init --out|loadBuiltPage'
```

In `astro.config.mjs` and VitePress's config, look for `content` and `ignore` in the options passed to `ondocs()` or `withOndocs()`.

## 0.9: one name per option

0.9 gives each option one name across `createAskHandler`, `AskDialog`, `mountAskDialog`, the script tag, the plugins and the CLI. The old names still work, with a warning, until 1.0 removes them.

| Where                                                                                 | Before 0.9                                 | From 0.9                               |
| ------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------- |
| The plugins' `dialog` and `dialog.locales`, `mountAskDialog`, `window.Ondocs.mount()` | `buttonLabel: 'Ask'`, `buttonLabel: false` | `launcher: 'Ask'`, `launcher: false`   |
| The script tag                                                                        | `data-button-label="Ask"`                  | `data-launcher="Ask"`                  |
| `AskDialog`                                                                           | `theme="system"`                           | `theme="auto"`                         |
| `createAskHandler`                                                                    | `maxContextChars: 6000`                    | `retrieval: { maxContextChars: 6000 }` |
| `ondocs init`                                                                         | `--name "Acme Docs"`                       | `--site-name "Acme Docs"`              |

`launcher` takes the same values `buttonLabel` did, and `true` for the default label. When a site sets both names, the new one wins.

Two defaults change in `AskDialog`, so that it matches the plugins and the script tag:

- **The shortcut is ⌘I, or Ctrl+I outside macOS.** It was ⌘K. ⌘K stays with the site's search, and text fields keep ⌘I for italic. Pass `shortcut="k"` to keep ⌘K, as on a site whose only search is this dialog.
- **`theme="auto"`, the default, follows `data-theme` on `<html>`.** A page with `data-theme="dark"` gets the dark dialog whatever the system's setting, as with the plugins and the script tag. A page without one still follows the system, and `theme="light"` or `"dark"` still pins one.

To find the old names in a site:

```sh
git grep -nE 'buttonLabel|data-button-label|theme="system"|maxContextChars|init --name'
```

`maxContextChars` is fine where it is already inside `retrieval`.
