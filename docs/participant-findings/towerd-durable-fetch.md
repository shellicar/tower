# Whether towerd can show files from the durable store

**Question.** Can towerd show files committed to the durable object store?

**Method.** Code reading of towerd and both frontends; rechecked against HEAD
(4294ad5): no durable bucket in `mvp/crates/towerd/src`, and the only
attachment route is still `/attachment/{id}`.

**Found.**
- Towerd opens one store at startup, its transit bucket
  (`TOWER_ATTACH_BUCKET`, default `attach`, TTL `TOWER_ATTACH_TTL_S`).
- `GET /attachment/{id}` takes only an id. A durable id
  `<conversation>/<opaque>` contains a `/`, so it misses the route and falls
  to `/{*path}`, which serves `index.html` with 200. The image then fails to
  load and shows "preview expired: the transit object is gone".
- Content-Type comes from the object's description, while the spec puts the
  media type in metadata.
- Towerd overwrites a say's bucket with the transit name.
- Refs leave object sources inline.
- Bridge has a per-bucket fetch pattern (`bridge/src/broker.rs`).
- Neither frontend reads `bucket` or percent-encodes the id; the dev proxies
  cover only `/ws`, `/ref` and `/attachment`.
- The frontends never carry `bucket`; towerd stamps it (an earlier decision,
  recorded in `frontend-parity.md`).
- `mvp/docs/tower-ws-spec.md` contradicts the durable spec: it says the
  committed message carries the same reference blocks as the say, quotes
  wording since removed from `conversation.md`, and says nothing client-side
  may depend on a bucket.
- Three calls are needed before a fix: how the browser names a durable
  object, which buckets towerd may read, and how towerd learns the durable
  bucket's name.

**Resume comparison.** Not about resume.

**Used by.** [object-stores.md](../participant/object-stores.md), Images.
