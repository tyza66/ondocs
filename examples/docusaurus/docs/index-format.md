---
# Generated from examples/nextjs/content/docs/index-format.md by scripts/sync-example-docs.mjs. Edit that file instead.
title: 'The index file'
description: 'What ask-index.json holds, why vectors are int8, and how the file stays small and diffable.'
---

The index is one JSON file, `ask-index.json`, with your documents, their chunks and one vector per chunk. It is built at build time, ships with your site, and is loaded into memory by the endpoint. There is no database behind it.

## What the file holds

The file records its format (`ask-my-site/index@1`, under the package's name before it became ondocs, so indexes from either name are read by both), the embedding model and vector size it was built with, the chunking options, a content hash, the documents (`id`, `url`, `title`) and the chunks. Each chunk has its heading path, its anchor, its text, a hash of the text it was embedded from, and its vector.

## Compatibility

The site that builds the index and the endpoint that reads it are often built apart: the Worker that `ondocs init --host github-pages` writes fetches the live site's `ask-index.json` and is upgraded on its own. So the format changes by these rules:

- **A field a later version adds is not a new format.** It stays `ask-my-site/index@1`, and readers ignore the fields they do not know, so an older endpoint reads a newer site's index.
- **A change an older reader could not follow gets a new id**, ending in `@2` rather than `@1`. Readers accept the new id for at least one minor version before any version writes it, so an endpoint kept within a minor of the site reads its index whichever version built it. The release notes and [Upgrading](./upgrading.md) say which version to upgrade the endpoint to first.
- **An index the endpoint cannot read fails where it shows.** `createAskHandler` and `createMcpHandler`, given an index of another format as it is rather than through a function, fail as they are made, and say both ways out: upgrade the endpoint, or rebuild the index. A [`remoteIndex`](./deployment.md#github-pages-and-other-static-hosts) that finds one on a later check keeps answering from the index it has, and reports the failed check to its `onError`, or the handlers'.

Every test run reads two indexes that ondocs 0.10.0 wrote, one keyword-only and one with 512-dimension vectors, from `test/fixtures/index-0.10` in the repository, so a reader change that would break an index already deployed fails the build.

## Index size

A site of 1,000 chunks of about 800 characters at 512 dimensions makes an index of 1.6 MB, or 0.9 MB gzipped. The size grows linearly: 15.7 MB at 10,000 chunks and 78.7 MB at 50,000. The same index with vectors written as plain JSON numbers would be 7.5 MB at 1,000 chunks. A keyword-only index has no vectors and is smaller still.

## Why vectors are int8

Each embedding is quantized to 8-bit integers. The vector is scaled so its largest component is ±127, then every component is rounded. No scale factor is stored, because cosine similarity is scale-invariant and the scale cancels out.

An int8 vector takes one byte per dimension, a quarter of float32. Stored as base64, a 512-dimension vector is 684 characters, against 6,500 to 7,000 characters for the same vector written as JSON numbers the way embedding APIs return them.

Quantization costs almost nothing in accuracy. Similarities stay within 0.005 of the float32 values, and the top 10 results overlap with those of exact float32 search by 99.9% at 1,000 chunks and 99.1% at 10,000.

## Why not binary quantization

Binary (1-bit) quantization would shrink vectors another 8×, but on the same benchmark vectors it keeps only 27% of the exact top 10, and 66% even after rescoring a 4× shortlist, which means shipping full vectors anyway. Product quantization needs trained codebooks. Neither pays off at the sizes a static site produces.

## Diffable by design

The file is written deterministically: documents are sorted, no timestamps are stored, and each chunk sits on its own line. Editing one paragraph changes one or two lines in a pull request, so the index can be committed and reviewed next to the content it describes.

## Incremental rebuilds

Every chunk records the first 16 hex characters of a SHA-256 of the text it was embedded from. On a rebuild, chunks whose hash is unchanged reuse their vectors, so only edited sections are sent to the embedding model. Vectors are reused only when the embedding model and its options are the same.

## Loading the index

At startup the handler parses the file, decodes the vectors into one contiguous `Int8Array` and builds the BM25 inverted index. This happens once per server instance and takes about 32 ms for 1,000 chunks, using 3.2 MB of memory.
