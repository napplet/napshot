# Instance identity

Set one optional runtime variable to let an instance publish its own profile and
relay list:

```dotenv
NAPSHOT_PROFILE='{"name":"napshot","display_name":"Napshot","about":"Automated napplet previews","nip05":"napshot@example.com","bot":true}'
```

In Coolify, paste the JSON object as the value without the surrounding shell
single quotes. Mark it literal and runtime-only, save, and redeploy.
`name`, `display_name`, and `bot` default to `napshot`, `Napshot`, and `true`, so
an instance can start with just `{"about":"Your bio","nip05":"you@example.com"}`.
Blank or unset disables both announcements. Site-only mode never publishes.

Napshot derives the public key from `NAPSHOT_SECRET_KEY`; do not configure a
second key or a public key. It signs both events with the same identity used for
screenshot labels:

- Kind `0` contains the profile JSON, following NIP-01 and NIP-24. Standard fields
  include `name`, `display_name`, `about`, `picture`, `banner`, `website`, `nip05`,
  `lud16`, and boolean `bot`. Other JSON metadata fields are preserved. Omit
  fields you do not want published. Profiles are public and limited to 16 KiB.
- Kind `10002` uses empty content and one `r` tag per existing `NAPSHOT_RELAYS`
  entry. The unmarked tags advertise both read and write use under NIP-65. No
  separate relay-list configuration is needed.

NIP-05 is a declared profile field. Napshot does not resolve it before publishing
and never blocks startup or publication because its DNS/HTTP configuration is
unfinished. Clients may show it as unverified until the endpoint resolves.

## Delivery and changes

Both signed events are saved in the existing SQLite data directory before any
network publication. Each configured relay is attempted independently, and
missing or negative acknowledgements remain pending with exponential backoff
from five seconds to one hour. A failed relay or one failed event kind cannot
veto delivery to another relay or stop screenshot processing. Logs report
`instance_event_published` or `instance_event_retry_scheduled` with kind, event
ID, and relay; they never include the private key.

The background publisher retries while the service runs. Restarting reannounces
unchanged metadata with the same stored event IDs; pending retries retain their
backoff. Editing the profile or configured relay list and restarting creates a
new signed version only for the changed event kind. Its timestamp advances
strictly beyond the previous local version, including changes within one second.
Changing top-level JSON property order or relay order does not create another event.

Keep the signing key and data volume stable. This configuration owns the
instance metadata; coordinate external edits using the same key. Local event
timestamps cannot account for a newer version independently published elsewhere.

## Homelab instance

The public metadata is tracked in
[`deploy/homelab.json`](../deploy/homelab.json) and applied by
`./homelab napshot deploy` from the homelab repository. It describes **Napshot**,
sets `bot: true` and `nip05: napshot@napplet.run`, and omits `website`. Future
deploys restore that profile from the manifest; edit it there to change the
desired identity. The instance uses its existing private key in Coolify.

Verify both events by querying the configured relays with the instance's public
key and kinds `[0, 10002]`, then validate their IDs and signatures. A positive
publish acknowledgement reports relay acceptance; readback is separate evidence
that a relay serves the event.

References: [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md),
[NIP-24](https://github.com/nostr-protocol/nips/blob/master/24.md),
[NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md).
