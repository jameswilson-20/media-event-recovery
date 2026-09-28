import { createHmac, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import {
  InfraiControlPlane,
  InfraiError,
  type MediaQueuePayload
} from "./infrai_control_plane.js";

const assetEventSchema = z.object({
  event_id: z.string().min(1),
  event_type: z.enum(["asset.ingested", "asset.repackage_requested"]),
  asset: z.object({
    id: z.string().min(1),
    creator_id: z.string().min(1),
    source_url: z.string().url()
  })
});

const queuedMediaJobSchema = z.object({
  event_id: z.string().min(1),
  asset_id: z.string().min(1),
  creator_id: z.string().min(1),
  source_url: z.string().url(),
  operation: z.enum(["transcode", "package"])
});

export type AssetEvent = z.infer<typeof assetEventSchema>;

export function planMediaJob(event: AssetEvent): MediaQueuePayload {
  return {
    event_id: event.event_id,
    asset_id: event.asset.id,
    creator_id: event.asset.creator_id,
    source_url: event.asset.source_url,
    operation: event.event_type === "asset.ingested" ? "transcode" : "package"
  };
}

export function signatureIsValid(rawBody: Buffer, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const supplied = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return supplied.length === expectedBuffer.length && timingSafeEqual(supplied, expectedBuffer);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function createMediaService(client: InfraiControlPlane, webhookSecret: string) {
  const app = express();

  app.post("/platform-events", express.raw({ type: "application/json" }), async (req, res, next) => {
    try {
      const signature = req.header("x-infrai-signature") ?? "";
      if (!signatureIsValid(req.body, signature, webhookSecret)) {
        res.status(401).json({ error: "invalid signature" });
        return;
      }
      const event = assetEventSchema.parse(JSON.parse(req.body.toString("utf8")));
      const job = planMediaJob(event);
      await client.publish("media-processing", job);
      res.status(202).json({ event_id: event.event_id, queued_operation: job.operation });
    } catch (error) {
      next(error);
    }
  });

  app.get("/delivery-status/:webhookId", async (req, res, next) => {
    try {
      res.json(await client.deliveries(req.params.webhookId));
    } catch (error) {
      next(error);
    }
  });

  app.post("/processing-recovery", express.json(), async (_req, res, next) => {
    try {
      res.json(await client.redrive("media-processing"));
    } catch (error) {
      next(error);
    }
  });

  app.post("/creator-delivery", express.json(), (req, res, next) => {
    try {
      const job = queuedMediaJobSchema.parse(req.body);
      res.status(200).json({
        event_id: job.event_id,
        asset_id: job.asset_id,
        creator_id: job.creator_id,
        delivered_operation: job.operation
      });
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "invalid request", issues: error.issues });
      return;
    }
    if (error instanceof InfraiError) {
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      res.status(status).json({ error: error.code, details: error.details });
      return;
    }
    res.status(502).json({ error: "upstream request failed" });
  });

  return app;
}

async function main() {
  const apiKey = requiredEnv("INFRAI_API_KEY");
  const secret = requiredEnv("INFRAI_WEBHOOK_SECRET");
  const publicBaseUrl = requiredEnv("PUBLIC_BASE_URL").replace(/\/$/, "");
  const client = new InfraiControlPlane(apiKey);

  if (process.argv.includes("--setup")) {
    const webhook = await client.registerWebhook({
      url: `${publicBaseUrl}/platform-events`,
      events: ["asset.ingested", "asset.repackage_requested"],
      description: "Media asset processing intake",
      secret,
      headers: { "x-media-pipeline": "creator-delivery" }
    });
    await client.subscribeQueue("media-processing", `${publicBaseUrl}/creator-delivery`);
    console.log(JSON.stringify({ webhook_id: webhook.id, queue: "media-processing" }, null, 2));
    return;
  }

  const port = Number(process.env.PORT ?? 3000);
  createMediaService(client, secret).listen(port, () => {
    console.log(`Media event service listening on ${port}`);
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main();
}
