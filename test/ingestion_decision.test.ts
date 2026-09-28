import assert from "node:assert/strict";
import test from "node:test";
import { planMediaJob } from "../src/media_event_service.js";

test("an ingested asset becomes a transcode job for the same creator", () => {
  const job = planMediaJob({
    event_id: "evt_1042",
    event_type: "asset.ingested",
    asset: {
      id: "asset_77",
      creator_id: "creator_9",
      source_url: "https://media.example.com/uploads/asset_77.mov"
    }
  });

  assert.deepEqual(job, {
    event_id: "evt_1042",
    asset_id: "asset_77",
    creator_id: "creator_9",
    source_url: "https://media.example.com/uploads/asset_77.mov",
    operation: "transcode"
  });
});
