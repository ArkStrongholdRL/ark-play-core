# Ark Play Core

Shared native `/ws` gameplay client for the DSH and Codex Ark Stronghold plugins.

Owns the five gameplay tools, compact observations, action batches, recovery,
room joining, LLM controller declarations, site content verification and battle
Worker, plus source/notice/package helpers. Host adapters, MCP SDK, UI artwork
and game engine snapshots are not included. The configured game site supplies
public data and simulation code; remote modules are kept in memory only.

## Use

Depend on a pinned GitHub commit archive. This package is not published on npm.

```js
import {createTools} from '@arkstrongholdrl/ark-play-core';
const runtime = createTools({url: 'wss://ark.minyako.top/ws', client: 'dsh-plugin'});
// Use client: 'codex-mcp' in the Codex host. Hosts own tool calls and cleanup.
await runtime.close();
```

Hosts bundle src/site-worker.mjs and src/site-loader.mjs into the same output
folder. Supported sites currently use app 0.3.0 / 0.3.1 and vanilla protocol v1.

## Validate

```sh
npm ci --ignore-scripts
npm test
npm run check:package
npm run pack:release
```

CI checks Node 22 and 24. The build-package export provides copySource and
packageClient. Release ZIPs include both core and host corresponding source;
PUBLISH.md is optional and its absence does not fail packaging.

Hosts: [Codex](https://github.com/HarcoChen/ArkStrongholdCodex),
[DSH](https://github.com/HarcoChen/dsh-ArkStronghold).

GPL-3.0-or-later. See LICENSE and PROVENANCE.md.
