---
name: napshot-shell
description: Add trusted Napshot screenshot discovery and verified Blossom image loading to a Nostr shell’s napplet picker or catalog. Use when integrating fallback previews for root or named napplets; not for implementing the screenshot service or changing napplet permissions.
---

# Napshot shell integration

Add previews to the shell’s existing manifest/media path. Preserve author-provided usable screenshots and fall back to Napshot only when those are absent. Do not add an independent relay pool, permission layer, or image cache when the shell already has one.

Install from the published repository with `npx skills add napplet/napshot`. Invoke with `$napshot-shell`, for example: “Use $napshot-shell to add trusted previews to our napplet picker.”

## Discovery contract

Napshot watches root manifests (kind `15129`) and named manifests (kind `35129`). Exclude snapshots (`5129`). A label is a signed kind-`1985` NIP-32 event describing the exact manifest revision:

```js
const filter = {
  kinds: [1985],
  authors: trustedNapshotPubkeys,
  "#e": [manifest.id],
  "#L": ["#screenshot"],
};
```

Require a nonempty, explicitly configured trusted signer list before querying. Never omit `authors` or interpret an empty list as permission to trust everyone. The instance’s `/api/status` exposes its public key for comparison with the operator’s independently verified key; the endpoint itself is not a trust anchor.

A label’s tags have this shape (metavariables are explanatory):

```js
[
  ["L", "#screenshot"],
  ["l", sha256, "#screenshot"],
  ["e", manifest.id, relayHint],
  ["a", `${manifest.kind}:${manifest.pubkey}:${identifier}`],
  ["p", manifest.pubkey],
  [
    "screenshot",
    `x ${sha256}`,
    "m image/png",
    "dim 1200x750",
    `size ${byteLength}`,
  ],
  ["server", "https://blossom-one.example"],
  ["server", "https://blossom-two.example"],
];
```

`identifier` is empty for root manifests and the `d` tag for named manifests. The `e` tag binds the picture to a revision. The `a` tag supports discovery and must never make an old image apply to a new revision. `screenshot` is the literal tag name (`tag[0]`). Its remaining entries use NIP-92-style `key value` fields. Dimensions can vary by service configuration; do not require 1200×750.

## Verification and display

1. Validate the manifest using the shell’s existing NIP-5D path. Use its usable author-provided screenshot first.
2. Verify each label’s event ID and signature with the shell’s Nostr library. Check kind `1985`, signer membership, the exact `e` target, matching `a`/`p`, `L` namespace, and matching `l` hash. Treat relay results as untrusted input even when the filter was correct.
3. Parse the `screenshot` tag: require exactly one lowercase 64-character SHA-256 `x` field, one `m image/png` field, and valid positive dimensions and size. Reject contradictory or duplicate fields. Bound image bytes and decoded dimensions using the shell’s existing image limits; do not allocate from an unchecked size declaration.
4. Deduplicate and validate `server` URLs using the shell’s existing network policy. Use HTTPS, disallow credentials and unsafe destinations, and preserve the configured Blossom base path. Fetch `<server>/<sha256>` with a timeout and response size limit. A `.png` suffix may also be used by the server. Do not trust a response’s MIME header or redirect destination without validation.
5. Hash the fetched bytes and compare with `x` before decoding. Require PNG bytes and actual dimensions consistent with the declaration. Retry another listed mirror on transport failure, rejection, wrong hash, or invalid image; stop after the bounded mirror list is exhausted.
6. Display verified bytes through the shell’s existing safe image component. Use a local object URL when appropriate and revoke it on disposal. Give the image accessible text. When no label or mirror is usable, preserve the existing icon/placeholder without blocking the picker.

Cache by manifest event ID and image hash. Invalidate the association when the manifest revision or trusted signer set changes. If multiple trusted labels are usable, apply a deterministic policy (for example, configured signer preference followed by newest event and lexicographic event ID). Never choose based on an untrusted signer’s timestamp.

A Napshot capture is an automated signed-out Paja view. Network-dependent or account-dependent content may be empty. A signed label proves who published the preview; it does not endorse the napplet or grant it capabilities.

## Proof before completion

Exercise the actual picker/catalog path with fixtures for:

- Author screenshot precedence and no Napshot request when it is usable.
- Root and named manifests accepted; snapshots excluded.
- Valid trusted label rendered after byte-hash verification.
- Invalid signature, wrong signer, empty trust list, wrong `e`, or stale `a`-only match ignored.
- A valid label for the previous revision ignored after a manifest update.
- Bad first mirror followed by a correct second mirror; all mirrors failing leaves the placeholder.
- Duplicate screenshot fields, label/hash mismatch, wrong image bytes, oversized responses, and unsafe URLs rejected.

Use the repository’s existing tests and test data. Report the integration points changed, trust configuration needed, and actual verification performed.
