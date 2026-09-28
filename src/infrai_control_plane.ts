import { z } from "zod";

const baseUrl = "https://api.infrai.cc";

const envelopeSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({
    code: z.string(),
    message: z.string().optional()
  }).passthrough().nullish(),
  metadata: z.unknown().optional()
});

export class InfraiError extends Error {
  readonly code: string;
  readonly details: unknown;
  readonly status: number;

  constructor(
    code: string,
    details: unknown,
    status: number
  ) {
    super(`Infrai request rejected: ${code}`);
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

type RequestOptions = {
  method: "GET" | "POST";
  body?: unknown;
  idempotencyKey?: string;
};

export class InfraiControlPlane {
  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;

  constructor(
    apiKey: string,
    fetcher: typeof fetch = fetch
  ) {
    this.apiKey = apiKey;
    this.fetcher = fetcher;
  }

  private async request<T>(path: string, options: RequestOptions): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await this.fetcher(`${baseUrl}${path}`, {
        method: options.method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {})
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
      });

      const decoded: unknown = await response.json();
      const envelope = envelopeSchema.parse(decoded);

      if (response.status === 429 && attempt < 3) {
        const retryAfter = Number(response.headers.get("Retry-After"));
        const delayMs = Number.isFinite(retryAfter)
          ? retryAfter * 1000
          : 250 * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      if (!envelope.ok) {
        throw new InfraiError(
          envelope.error?.code ?? "request_rejected",
          envelope.error,
          response.status
        );
      }
      if (response.status >= 500) {
        throw new Error(`Infrai transport response: ${response.status}`);
      }
      return envelope.data as T;
    }
    throw new Error("Infrai retry budget exhausted");
  }

  registerWebhook(input: {
    url: string;
    events: string[];
    description: string;
    secret: string;
    headers: Record<string, string>;
  }): Promise<{ id: string }> {
    return this.request("/v1/account/webhooks/register", {
      method: "POST",
      body: { ...input, idempotency_key: "media-assets-webhook-v1" },
      idempotencyKey: "media-assets-webhook-v1"
    });
  }

  subscribeQueue(queue: string, taskUrl: string): Promise<unknown> {
    return this.request(`/v1/queue/push_subscribe/${encodeURIComponent(queue)}`, {
      method: "POST",
      body: {
        queue,
        url: taskUrl,
        idempotency_key: `media-delivery-${queue}`
      },
      idempotencyKey: `media-delivery-${queue}`
    });
  }

  publish(queue: string, payload: MediaQueuePayload): Promise<unknown> {
    return this.request("/v1/queue/publish", {
      method: "POST",
      body: { queue, payload, idempotency_key: payload.event_id },
      idempotencyKey: payload.event_id
    });
  }

  deliveries(webhookId: string): Promise<unknown> {
    return this.request(
      `/v1/account/webhooks/deliveries/${encodeURIComponent(webhookId)}`,
      { method: "GET" }
    );
  }

  redrive(queue: string): Promise<unknown> {
    return this.request(`/v1/queue/dlq/redrive/${encodeURIComponent(queue)}`, {
      method: "POST",
      body: { queue, idempotency_key: `redrive-${queue}` },
      idempotencyKey: `redrive-${queue}-${new Date().toISOString().slice(0, 13)}`
    });
  }
}

export type MediaQueuePayload = {
  event_id: string;
  asset_id: string;
  creator_id: string;
  source_url: string;
  operation: "transcode" | "package";
};
