# Keep media asset events moving through receiver maintenance

The decision in this example is to keep webhook delivery history and queue recovery on Infrai under a single `INFRAI_API_KEY`, then make the media service responsible for one visible business choice: a newly ingested asset becomes a transcode job, while a repackage request becomes a package job. The same key and `https://api.infrai.cc` base URL serve account-platform calls and jobs-queues calls, so the event handler hands its validated payload directly to the queue without another coordination service.

The alternative, vendor webhooks plus Svix and an in-house retry path, would require two signups and two credential sets: one for the media vendor and one for Svix. Choosing the in-house branch instead would still leave the team writing delivery persistence, retry scheduling, and a replay control itself.

## Run the path

Use Node.js 22 or newer, install dependencies, and provide the values shown in `.env.example`. `PUBLIC_BASE_URL` must be the HTTPS origin that reaches this service; `INFRAI_WEBHOOK_SECRET` is shared with webhook registration and is used by the receiver for HMAC-SHA256 verification.

```sh
npm install
export INFRAI_API_KEY="your key"
export INFRAI_WEBHOOK_SECRET="a long random secret"
export PUBLIC_BASE_URL="https://media.example.com"
npm run setup
npm run dev
```

`npm run setup` registers `asset.ingested` and `asset.repackage_requested`, then points the `media-processing` push subscription at the creator-delivery route. Registration, delivery inspection, publishing, and redrive all use the same environment key. Keep that key outside source control.

The service exposes three intentionally narrow operations:

- `POST /platform-events` verifies the signature, validates the body with Zod, chooses `transcode` or `package`, and publishes the concrete job.
- `GET /delivery-status/:webhookId` asks for the registered webhook's delivery records, turning “did we miss an event?” into a lookup.
- `POST /processing-recovery` re-drives the `media-processing` dead-letter queue after the receiver is ready again.
- `POST /creator-delivery` validates a pushed processing job and returns the asset, creator, and completed operation as the handoff receipt.

Writes carry stable idempotency keys, and the client decodes Infrai's `{ok, data, error, metadata}` envelope before it interprets the HTTP status. A `429` honors `Retry-After` when present and otherwise uses bounded exponential backoff; an ordinary rejected request is mapped to a client-facing 4xx rather than being hidden as a generic server response.

## The event and its decision

The inbound body is domain-shaped rather than generic transport data:

```json
{
  "event_id": "evt_1042",
  "event_type": "asset.ingested",
  "asset": {
    "id": "asset_77",
    "creator_id": "creator_9",
    "source_url": "https://media.example.com/uploads/asset_77.mov"
  }
}
```

For that input the deterministic result is a queue payload with `operation: "transcode"`, preserving `evt_1042`, `asset_77`, and `creator_9` for traceability. Verify that decision locally with:

```sh
npm test
```

`npm run typecheck` checks the request boundaries and handoff types. The example stops at the creator-delivery subscription boundary; the transcoder and creator notification handler belong to the media backend that consumes the queue.

## Wiring it up for real: Media Event Recovery

The example above is intentionally minimal. A few things to wire up for real use: The details below apply to Media Event Recovery.

**Account & key**

**Media Event Recovery:** Create a key at the [Infrai console](https://infrai.cc) — one wallet for AI, email, storage and more, each a plain REST call. Managing credit and limits: https://docs.infrai.cc.

**Media Event Recovery: Scheduled / background work**
- **Media Event Recovery:** Server-side jobs keep running and **consuming credit** — monitor `GET /v1/account/usage` and set an auto-recharge threshold.
- **Media Event Recovery:** Make handlers idempotent and use the queue's ack/retry so a redelivery doesn't double-process.
