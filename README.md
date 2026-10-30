# Napshot

Missing screenshots for Nostr napplets, captured and labeled.

Napshot watches root (`15129`) and named (`35129`) napplet manifests. When an eligible
revision has no usable screenshot, it renders the verified HTML in a fresh, signed-out
Kehto Paja session, captures the iframe, uploads the PNG to multiple Blossom servers,
and publishes a signed NIP-32 annotation referencing that exact manifest event.

Source and shell integration skill: [napplet/napshot](https://github.com/napplet/napshot).

## Run

Requirements: Node.js 24+, pnpm, and Chromium with its sandbox working. The browser and
user-namespace support must be provisioned by the operator. Napshot does not install
browsers, disable their sandbox, or modify desktop settings.

```sh
pnpm install --frozen-lockfile
pnpm build
cp .env.example .env
chmod 600 .env
# Fill .env with a dedicated signing key, relay URLs, and at least two Blossom servers.
node --env-file=.env dist/src/main.js
```

Generate a dedicated key locally using `node --input-type=module -e
'import {generateSecretKey} from "nostr-tools"; console.log(Buffer.from(generateSecretKey()).toString("hex"))'`.
Keep it private. Do not use a personal account key. The public signer key appears in the
startup log and `/api/status`; shells can pin it as a trusted screenshot provider.

Open <http://127.0.0.1:3080>. To preview only the explainer without a key or external
network activity, run `node dist/src/main.js --site-only`. `/healthz` returns 503 in this
mode; a site preview is not a running worker.

### Run persistently with systemd

`deploy/napshot.service` is a user-service template. Adjust `WorkingDirectory`,
`EnvironmentFile`, and `ExecStart` for the install location and an absolute Node 24
binary if Node is outside the service PATH. Then:

```sh
mkdir -p ~/.config/systemd/user
cp deploy/napshot.service ~/.config/systemd/user/napshot.service
systemctl --user daemon-reload
systemctl --user enable --now napshot.service
journalctl --user -u napshot.service -f
```

The user manager must remain running for service operation after logout. Configure
lingering under your host's normal service policy if needed. Napshot is not installed
or enabled on this machine by building this repository.

## Configuration

| Variable | Meaning / default |
| --- | --- |
| `NAPSHOT_SECRET_KEY` | Required lowercase hex private key; keep stable across restarts |
| `NAPSHOT_RELAYS` | Required comma-separated `wss://` relay URLs for watching and publishing |
| `NAPSHOT_BLOSSOM_SERVERS` | Required distinct HTTPS origins; at least two; also artifact fallbacks |
| `NAPSHOT_MIN_REPLICAS` | Minimum verified uploads before publication, default `2`, never below `2` |
| `NAPSHOT_TRUSTED_AUTHORS` | Additional comma-separated hex labeler public keys; own signer is always trusted |
| `NAPSHOT_DATA_DIR` | Local durable SQLite directory, default `./data` |
| `NAPSHOT_CHROMIUM` | Browser executable, default `/usr/bin/chromium` |
| `NAPSHOT_HOST`, `NAPSHOT_PORT` | Explainer/status bind, default `127.0.0.1:3080` |
| `NAPSHOT_POLL_MS` | Relay scan interval after each scan, default `30000` |
| `NAPSHOT_LOOKBACK_SECONDS` | First-run historical window, default `86400`; subsequent starts resume stored cursors |
| `NAPSHOT_WIDTH`, `NAPSHOT_HEIGHT` | Capture dimensions, default `1200` × `750` |
| `NAPSHOT_CAPTURE_DELAY_MS` | Settle time after loading, default `1500` |
| `NAPSHOT_CAPTURE_TIMEOUT_MS` | Overall browser capture limit, default `45000` |

Use servers that accept uploads from the configured signer. Napshot handles BUD-11
upload authorization; it does not purchase storage, negotiate payments, or perform
NIP-42 relay authentication. URLs are not credentials. HTTPS Blossom redirects are
rejected intentionally. At least two distinct origins are required, although different
origins do not prove independent infrastructure ownership.

## Behavior and recovery

- Only signed, current single-artifact root/named manifests enter the queue. Snapshots
  (`5129`), legacy file-map manifests, malformed identities, and invalid signatures are ignored.
- A usable author `screenshot` hash takes precedence. Trusted kind-1985 labels bound to
  the exact event ID also suppress work. Untrusted labels cannot veto a capture. Metadata
  presence is the skip criterion; Napshot does not repair a declared but unavailable author image.
- Polling uses persisted per-relay cursors, a 60-second overlap, pagination and duplicate
  IDs. Checkpoints advance only after a successful complete scan. Relay timeout is an
  error, never an empty result. This cannot recover events a relay omits, timestamps
  backdated outside the overlap, or relays that silently cap results below the requested limit.
- New revisions supersede queued older revisions at the same address, using NIP-01
  timestamp and event-ID ordering. Already published labels remain attached to their original revisions.
- Jobs, captures, upload receipts and signed labels live in SQLite. Each output label
  is stored before publication. A lost acknowledgement or restart resends the same event
  ID. At least one configured relay must acknowledge publication; every configured relay
  is attempted. Retry delay grows from 5 seconds to 1 hour with no silent retry cutoff.
- Every configured Blossom server is attempted. Only replicas that pass descriptor and
  readback-hash checks are advertised. Below quorum, the PNG and successful replicas are
  retained for retry. A capture is discarded after completion; metadata remains for deduplication.
- All configured relays must answer the existing-label query before a new capture. An
  unavailable relay delays jobs instead of treating an incomplete check as proof of absence.
- The data directory allows one worker on one host. A stale PID lock is recovered after
  a crash. Do not share a data directory across containers/hosts with different PID spaces.
- SIGINT/SIGTERM finish the current bounded operation, then close HTTP and SQLite.
  Restart after a forced kill resumes durable jobs. Back up the database with SQLite's
  backup tooling or stop the service before copying its data directory, including WAL files.

`/api/status` reports the signer, configured endpoints, queue counts and last successful
scan; it contains no secret key or manifest content. `/healthz` returns 200 only after a
recent complete scan, otherwise 503. Logs are JSON with job IDs and bounded failure
messages. A healthy scan does not imply every queued capture has succeeded; inspect the
failed count and retry logs. Put a reverse proxy in front if exposing the page publicly.

## Capture boundaries

Napshot adapts the existing napplet CLI's Paja/Playwright iframe capture flow; see
`THIRD_PARTY_NOTICES.md`. It uses the same upstream package versions as that capture
path instead of introducing a separate shell implementation. A fresh anonymous browser
context has no account or signing keys. Network requests are restricted to the disposable
local preview; external requests, websocket connections, downloads and service workers
are blocked. Fetching signed artifacts uses bounded responses, pinned public DNS and
SHA-256 verification, preventing manifest hints from reaching local services.

A screenshot is a signed-out preview, not a correctness or safety endorsement. Applets
that require live network data, authentication, interaction or more time may show a
loading or empty state. Browser failures remain retryable jobs. Run an internet-facing
renderer as a dedicated unprivileged user/container with OS memory/CPU limits; Chromium's
sandbox and request interception are not a replacement for host isolation against browser exploits.

## Shell implementers

```sh
npx skills add napplet/napshot
```

Then ask your coding agent to use **`$napshot-shell`** to integrate trusted screenshot
fallbacks. The source skill is [skills/napshot-shell/SKILL.md](skills/napshot-shell/SKILL.md).
The explainer includes the event shape and client steps. Shells read labels from Nostr
and bytes from Blossom; they do not depend on Napshot's HTTP process remaining online.

The wire contract is [docs/protocol.md](docs/protocol.md). Never attach a screenshot
solely by `a`: the `e` target pins the exact revision. Never trust a label solely because
it has a `screenshot` tag.

## Verify

```sh
pnpm check
```

This runs source hygiene/JS syntax checks, strict TypeScript static analysis, unit and
integration tests, plus real Chromium captures. Tests use local relay/Blossom fixtures
and temporary keys, with no public uploads or publications. Browser tests use
`/usr/bin/chromium` or `CHROMIUM_PATH` when provided. No browser download occurs.
