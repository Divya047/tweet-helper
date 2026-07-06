import { describe, expect, it } from "vitest";
import { parseTweetsJs } from "../src/archive.js";

describe("X archive parsing", () => {
  it("extracts posts and replies from an official tweets.js payload", () => {
    const payload = `window.YTD.tweets.part0 = [
      {
        "tweet": {
          "id_str": "100",
          "created_at": "Mon Jul 06 10:00:00 +0000 2026",
          "full_text": "Shipping small local tools is underrated."
        }
      },
      {
        "tweet": {
          "id_str": "101",
          "created_at": "Mon Jul 06 10:05:00 +0000 2026",
          "full_text": "@someone exactly, the boring parts matter most",
          "in_reply_to_status_id_str": "99",
          "in_reply_to_screen_name": "someone"
        }
      },
      {
        "tweet": {
          "id_str": "102",
          "full_text": "RT @other: not original"
        }
      }
    ];`;

    const examples = parseTweetsJs(payload);

    expect(examples).toHaveLength(2);
    expect(examples[0]).toMatchObject({ id: "x:100", kind: "post" });
    expect(examples[1]).toMatchObject({ id: "x:101", kind: "comment", replyToUser: "someone" });
  });
});
