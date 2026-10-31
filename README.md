# Bootstrap Server

Standalone libp2p bootstrap server with a blessed TUI dashboard. Provides peer discovery and circuit relay for the P2P Trust Stack (P2PTS).

## Quick Start

```bash
cd bootstrap
npm install
npm run init-bootstrap -- --host <dns-or-ip> --generate   # once: writes ./.env
npm start
```

`init-bootstrap` derives the server's peer ID from a 24-word BIP-39 word
sequence (generated, or supplied with `--words-file`) and writes a **gitignored
`.env`**. Every component reads that file through `@p2p-trust-stack/core/config/bootstrap-env.js`.

## Production Usage

Point the server at its public address. The address may be a DNS hostname **or**
a fixed public IP:

```bash
# Generate a fresh identity and write ./.env
npm run init-bootstrap -- --host mediator.example.com --generate

# …or reuse the word sequence kept OUTSIDE the repo (never lands in shell history)
npm run init-bootstrap -- --words-file ~/data/phrase.txt --host 203.0.113.5

npm start
```

The peer ID is **deterministic** (derived from the seed), so clients can dial the
server without a prior identify exchange. There are **no hardcoded addresses and
no OS environment-variable overrides** — the `.env` is the single source of truth.
A missing/malformed `.env` prints an actionable message and exits(1).

### ⚠️ The word sequence is this server's private key

`--generate` mints a **new relay identity**: it creates a fresh 32-byte seed,
derives the peer ID from it, and prints the 24-word BIP-39 phrase **once**. That
phrase *is* the private key — anyone holding it can derive the peer ID and
impersonate this server. So:

- **Store it outside the repo** (e.g. `~/data/phrase.txt`) and pass it with
  `--words-file`. Never keep it in the working tree.
- **Never commit it.** `phrase.txt`, `bootstrap-phrase.txt` and `*.phrase.txt` are
  gitignored here as a safety net, but outside-the-repo is the recommendation.
- **Reuse the same phrase** across restarts so the peer ID stays stable — a new
  identity invalidates every client's `.env`.
- It is the ONLY way to reproduce the peer ID; there is no recovery path.

Clients (the utility server and the agent app) need the **peer ID and address
only**, never the seed. Their `init:bootstrap` writes a client `.env` with no
`BOOTSTRAP_SEED_HEX` and refuses to boot if one is present.

## Options

Identity (seed/peer ID) and address (host/ports) live in `./.env`, **not**
in flags. Only operational overrides remain on the command line:

| Flag | Default | Description |
|------|---------|-------------|
| `--env <path>` | `./.env` | Path to the `.env` file |
| `--host <addr>` | `0.0.0.0` | Bind address |
| `--db <path>` | `./data/bootstrapdb.db` | SQLite database path |
| `--enable-dht` | false | Enable Kademlia DHT |
| `--no-relay` | — | Disable circuit relay (overrides the `.env`) |
| `--relay-duration <ms>` | `3600000` | Max lifetime of a relayed session (ms) |
| `--relay-max-bytes <n>` | `10485760` | Max bytes per relayed session |

`.env` keys (see `.env.example`): `BOOTSTRAP_SEED_HEX`, `BOOTSTRAP_PEER_ID`,
`BOOTSTRAP_HOST`, `BOOTSTRAP_TCP_PORT`, `BOOTSTRAP_WS_PORT`,
`BOOTSTRAP_ENABLE_RELAY`. The only remaining environment variable is
`TEST_PEER_TTL_SECONDS` (default `300`), which governs test-peer pruning.

## Peer database & retention

The `peers` table is the discovery registry served to clients. Each peer carries a
**designation** (set at registration): its role (`agent` / `utility_server`), the
network/group it belongs to (`net`, e.g. `p2pts`), and its **user name**
(`agentName`). The bootstrap-facing name is the user's configured name — *not* the
name registered with the utility server — and is exposed as `vta:<net>:<agentName>`.
A name is derivable from first contact, before name registration has run.

Liveness and retention are reconciled automatically:

- **Startup** — `connected` and `relay_reserved` are reset to 0 (a fresh process has
  no connections), and any test peers from a previous run are purged.
- **Every 10s** — the peer table is reconciled against the live connection manager
  and the relay's **reservation store** (so "reachable via relay" is measured, not
  inferred), and expired test peers are pruned.
- **Test peers** — a peer registering with `test: true` gets `expires_at = now +
  TEST_PEER_TTL_SECONDS` and is deleted once that elapses. Test peers are hidden from
  real peers' discovery results. This is how a test suite's peers are reaped after the
  suite finishes, without a clean disconnect.
- **Discovery ordering** — results are ordered connected-first, then by reachability
  scope (`wan`/`dns` before `relay`/`lan`), then most-recently-seen.

## Key Bindings

- `q` or `Ctrl-C` — Quit
- `l` or `r` — Refresh display
- `c` — Clear all peer and relationship records

## Scripts

```bash
npm start                          # Start the bootstrap server
npm run init-bootstrap             # Write ./.env (peer ID + address)
npm run init:bootstrap             # Same command (alias used by the sibling repos)
npm run test-bootstrap             # Run connectivity tests
npm run gen-seed                   # Print a new word sequence + seed + peer ID
npm run dev                        # Start with --watch for development
```

## Architecture

```
bootstrap/
  index.ts              # Entry point — re-exports tui/app.ts
  api/
    bootstrap-api.ts    # Event-driven API layer (the ONLY interface the UI uses)
  db/
    peer-db.ts          # SQLite-backed peer and relationship store
  server/
    bootstrap-server.ts # libp2p node creation and management
    bootstrap-protocol.ts # /bootstrap/2.0.0 protocol handler
  tui/
    app.ts              # Blessed screen setup, CLI arg parsing, orchestration
    dashboard.ts        # Real-time peer list, connection stats, event log
```

## Related

- **`@p2p-trust-stack/core/transport/bootstrap-client.js`** — Client-side bootstrap discovery
- **`@p2p-trust-stack/core/config/bootstrap-env.js`** — The typed, source-pluggable `.env` loader
- **`scripts/init-bootstrap-env.ts`** — Writes the `.env` from a word sequence
- **`scripts/test-bootstrap-connect.ts`** — Connectivity test script
- **`scripts/generate-bootstrap-seed.ts`** — Prints a word sequence + seed + peer ID

## License

**Dual-licensed:**

- **AGPL-3.0-only** — see [`LICENSE`](./LICENSE); or
- a **commercial license** where AGPL-3.0 obligations (copyleft, source
  disclosure, and the section 13 network-interaction requirement) are not
  acceptable — see [`COMMERCIAL-LICENSE.md`](./COMMERCIAL-LICENSE.md).

[`NOTICE`](./NOTICE) declares the `LicenseRef-TrustStackers-Commercial`
reference and lists third-party attribution.

**Running a bootstrap or relay node for the public network is free and welcome**
under the AGPL branch. If you modify the software and let users interact with it
over a network, AGPL-3.0 section 13 requires you to offer them your source.

[`TRADEMARK.md`](./TRADEMARK.md) covers the marks ("Trust Stackers", "P2P Trust
Stack"), which no license grants. All contributions require the
[CLA](./CLA.md) — see [CONTRIBUTING.md](./CONTRIBUTING.md).
