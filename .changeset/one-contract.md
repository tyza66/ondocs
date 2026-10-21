---
'ondocs': minor
---

One meaning per option name, options checked where they are given, and mistakes that fail as the site builds or the endpoint is made, not on the first question.

- Renamed, with the old names still working, and warning once, until 1.0: the Astro and VitePress plugins' `content` and `ignore` are `contentSelector` and `ignoreSelector`, as are `loadBuiltPage`'s `root` and `ignore`; `createAskHandler`'s and `createMcpHandler`'s `rateLimitFailure` is `failureMode`; and `ondocs init --out` is `--build-dir`. The Upgrading page has the table.
- The Docusaurus, Astro, Starlight and VitePress plugins check their options. One that is misspelled or not in the installed version fails the build and names the nearest option (`dialog.sugestions is not an option. Did you mean dialog.suggestions?`), as does a value of the wrong kind, such as `exclude: '/changelog'`. Before, they ignored it, and shipped the dialog's to every page. `ondocs/docusaurus` exports `validateOptions`, which Docusaurus runs before it loads the plugin.
- `createAskHandler` and `createMcpHandler` throw as they are made on an `index` that is a path, JSON that is not an ondocs index, or an index of a format this version does not read, saying both ways out, and `createAskHandler` on a missing `model`. Before, every question got a 500. They now take a Promise of the index, as `import('./ask-index.json')` gives.
- `createAskHandler` says once, to `onError`, when the index has vectors but it has no `embeddingModel`, so questions are matched on keywords only. A provider's 404, for a model it does not have, and OpenAI's `insufficient_quota` 429 now say the endpoint is misconfigured, without "Please try again".
- `remoteIndex` takes `onError`. A check of the site that fails while the index in hand keeps answering (an error status, a failed fetch, or a file that does not load, such as one from a newer ondocs) is reported once until it changes, instead of not at all. Without `onError`, it goes to the handlers' `onError`, else to `console.error`.
- The CLI's config module takes `embedding` and `dimensions`, as the plugins do, and fails on an option it does not have.
- The Package API page names the exports that may still change before 1.0, and the index file page states the format's compatibility rules.
