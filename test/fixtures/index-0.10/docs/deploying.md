---
title: Deploying
description: Put the built site on a static host.
---

# Deploying

The `out/` folder is plain files, so any static host serves it.

## GitHub Pages

Push `out/` to the `gh-pages` branch, or let a workflow build and publish it on every push to `main`.

## Caching

Hashed assets can be cached for a year. HTML files should be revalidated on every request, so a deploy shows up at once.
