# Coolify on homelab

Napshot uses the repository's `Dockerfile` and `compose.yaml`. The container runs
as UID 1000, includes Deno 2.9.6 and Debian Chromium, and retains SQLite in the
application-specific `napshot-data` volume at `/app/data`. Run one replica on beta.

## Deploy or recreate

From the homelab repository at `origin/master`:

```sh
./homelab napshot deploy
./homelab napshot verify
```

The command applies the source-tracked deployment manifest to create or update `napshot` in **Homelab Apps → production** on
**beta-ssh**. Coolify builds GitHub `napplet/napshot`, branch `main`, using
`/compose.yaml`. Its route is <http://napshot.192.168.151.147.sslip.io> on the LAN.
The source must be committed and pushed to `main` before deploying. Subsequent
deploys preserve environment variables entered through Coolify; the manifest
deliberately does not contain worker credentials or reset the activation flag.

## Enter worker configuration

Open the `napshot` application in Coolify and select **Environment Variables**.
Add these production runtime values (no build-time variables are needed):

```dotenv
NAPSHOT_SECRET_KEY=<dedicated 64-character lowercase hex private key>
NAPSHOT_RELAYS=wss://your-relay.example,wss://your-second-relay.example
NAPSHOT_BLOSSOM_SERVERS=https://your-blossom.example,https://your-second-blossom.example
NAPSHOT_SITE_ONLY=false
```

The endpoints above are placeholders. Use relays that serve napplet manifests
and permit label publication. Use at least two distinct HTTPS Blossom origins
that accept uploads from your dedicated signer. Generate the key locally with
`deno task keygen`; store it as a secret in Coolify and keep it stable across
redeploys. Never put the private key in Git or build arguments.

Save all four values, then click **Redeploy**. Until then, the Compose default
`NAPSHOT_SITE_ONLY=true` serves the explainer with the worker offline and makes
no relay connections or signed publications. Setting it back to `true` and
redeploying pauses the worker while preserving data.

Compose already sets `NAPSHOT_HOST=0.0.0.0`, `NAPSHOT_PORT=3080`,
`NAPSHOT_DATA_DIR=/app/data`, and `NAPSHOT_CHROMIUM=/usr/bin/chromium`.
Leave these container paths and port unchanged. Optional runtime values are
`NAPSHOT_MIN_REPLICAS=2`, `NAPSHOT_POLL_MS=30000`,
`NAPSHOT_LOOKBACK_SECONDS=86400`, and `NAPSHOT_TRUSTED_AUTHORS=` (additional
comma-separated hex public keys). Two verified mirrors are always required.

## Verify and maintain

After activation, `/api/status` must report your signer public
key, configured endpoints, and a recent successful scan. `/healthz` becomes 200
after a complete scan from any configured relay; `relayErrors` reports degraded
relays. Preview mode intentionally returns 503. The Compose
healthcheck checks `/` for HTTP liveness, so a healthy container alone does not
prove relay scans or captures are succeeding. Check Coolify logs and job counts
for capture, upload, or publication failures.

The seccomp profile comes from Playwright's Docker configuration and
permits Chromium user namespaces while keeping the browser sandbox enabled.
Compose resolves the profile relative to the source checkout inside Coolify’s
build helper; no host-side installation or environment override is needed. Do not add
`--no-sandbox`, privileged mode, or a second worker sharing the data volume.
The container has a 2 GiB memory limit, two CPUs, and 512 MiB shared memory.
See [Playwright's Docker guidance](https://playwright.dev/docs/docker).

The named volume survives normal Coolify redeploys. Do not delete it during
cleanup. To back up, stop the application through Coolify, back up the volume,
then start it through Coolify. Restore the volume and the same signing key before
starting a replacement on beta. A host move requires copying the volume first;
the volume name alone does not move data. Roll back code by deploying a previous
Git commit through Coolify while retaining the volume and signing key.
