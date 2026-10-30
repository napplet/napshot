# Napshot screenshot annotation

Napshot uses [NIP-32](https://github.com/nostr-protocol/nips/blob/master/32.md) kind `1985`.
The `#screenshot` namespace labels the target with screenshot metadata; the hash is the
label value. `screenshot` is an actual tag name (`tag[0]`), with the same NIP-92-style
fields as current NIP-5D manifest presentation media.

```json
{
  "kind": 1985,
  "content": "Signed-out napplet preview captured by Napshot.",
  "tags": [
    ["L", "#screenshot"],
    ["l", "<png-sha256>", "#screenshot"],
    ["e", "<exact-manifest-event-id>", "wss://relay.example"],
    ["a", "35129:<manifest-author>:<name>"],
    ["p", "<manifest-author>"],
    ["screenshot", "x <png-sha256>", "m image/png", "dim 1200x750", "size <bytes>"],
    ["server", "https://blossom-one.example"],
    ["server", "https://blossom-two.example"]
  ]
}
```

The normal Nostr `id`, `sig`, `pubkey`, and `created_at` fields are added when signing.
For a root manifest the address is `15129:<author>:` with a trailing colon. Named
manifests use `35129:<author>:<d>`. Snapshots never receive annotations from this service.

Shell query:

```js
const filter = {
  kinds: [1985],
  '#e': [manifest.id],
  '#L': ['#screenshot'],
  authors: trustedScreenshotPubkeys
};
```

Validate signatures locally, require the exact `e` target and a trusted signer, ensure
`l` matches the screenshot's one valid lowercase SHA-256, and parse `m`, `size`, `dim`
with resource bounds. Prefer author-supplied media. Resolve the hash from the label's
`server` origins, verify downloaded bytes before display, and fall back between mirrors.
Do not follow arbitrary private-network hints from labels in server-side shell fetchers.

Upload authorization follows [BUD-11](https://github.com/hzrd149/blossom/blob/master/buds/11.md):
a signed kind-24242 event scoped to `t=upload`, the blob `x` and the destination hostname,
with expiration, encoded in the `Authorization: Nostr <base64url>` header. Uploads follow
[BUD-02](https://github.com/hzrd149/blossom/blob/master/buds/02.md). Each replica is read
back by its content-addressed hash before inclusion in the annotation.

This is the Napshot interoperability profile. The NIP-5D working draft and upstream
capture code can evolve; this service handles the current `15129`/`35129` single-HTML
manifest shape, not legacy aggregate manifests. Source:
[napplet CLI](https://github.com/napplet/napplet/tree/master/packages/cli).
