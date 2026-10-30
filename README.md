# Ark Play Core

Shared native `/ws` gameplay client for the DSH and Codex Ark Stronghold plugins.

Owns the six gameplay tools, compact observations, action batches, recovery,
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
folder. Supported sites currently use app 0.3.0 through 0.3.3 and vanilla protocol v1 (the default official game version only). Historical-version rooms fail explicitly before loading their data.

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

## Shared connection settings

Without an explicit site, clients use https://ark.minyako.top. Site roots and /ws
URLs are normalized at the connection boundary. Defaults resolve from the saved
client.json, then ARK_AGENT_URL / ARK_AGENT_ROOM_CODE / ARK_AGENT_NAME, then host overrides.
A saved roomCode is used by ark_start when omitted; an explicit empty string
creates a solo game. Credentials are never included in model views.

The configure export is an explicit CLI entry. Host builds bundle it into a
standalone configure.mjs and packageClient includes that host-built file. It
accepts --room-code, --name and --update; updates preserve other saved fields and use an
atomic file replacement. No settings command connects to the game site.

Use `node configure.mjs --update --name "小刻"` to save a player name (up to 12
characters). An empty name restores the host default: 蓝色大肥鱼 for DSH and
笨蛋大肥龙 for Codex (Ark Agent for other clients). Names do not affect LLM controller
declarations. Hosts apply changed settings at the next safe game boundary.

## Event-driven multiplayer waits

ark_start stays pending after joining/readying until the host starts and this
player can make a decision. ark_act and ark_view likewise wait for teammates,
other draft turns, combat and pause/resume. Idle waiting sends no state queries
and returns no periodic model results. WS pushes trigger a cancellable state
wait; a short event debounce only combines public/private message bursts.
Results, room closure, disconnection, cancellation and runtime failure end the
wait. Cancellation does not undo accepted actions: recover once with ark_view.

Host tool deadlines still apply. DSH does not declare a per-tool deadline. Codex
can send requested MCP progress notifications, but these cannot override an
absolute client deadline. Use a longer host tool timeout for extended waits.

## Completed combat metrics

`ark_combat({scope: 'last' | 'match'})` reads in-memory native unit counters.
`last` includes normal and unite fields of the latest settled round; `match`
includes retained settled rounds. Each player and operator has damage, damage
taken, effective healing and shares (fractions 0–1); summons are credited to
their owning operator. Player DPS/HPS uses simulated field seconds. A zero
denominator gives a zero share. Healing excludes overheal and restore-mode
HP restoration; damage taken includes self/friendly HP loss.

Only fields locally simulated for this player are covered, including paired
allies present there. This is not a server-wide ranking. Reconstructed,
interrupted, taken-over or failed simulations are marked incomplete; missing
fields are unavailable, not zero. Reads cannot connect, advance the game or
expose active-round counters. History keeps at most 64 battles and returns
at most 256 unit rows per player, with omitted-row counts and full totals.
A new start clears history; finish disposes it. No frame/event recording.

After each settled round, call this tool once before taking the next decision
(or finishing the terminal review). Do not poll pending/unavailable statistics.
