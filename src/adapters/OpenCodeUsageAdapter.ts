import { JsonUsageAdapter } from "./JsonUsageAdapter";

/**
 * opencode usage comes from pi agent session transcripts
 * (bundled-pi-agent/sessions/<workspace>/<session>.jsonl). Each message line
 * carries the real opencode-go billing data:
 *
 *   {"type":"message","id":...,"parentId":...,"timestamp":"<ISO>",
 *    "message":{"role":"assistant","provider":"opencode-go",
 *               "model":"deepseek-v4-flash",
 *               "usage":{"input","output","cacheRead","cacheWrite",
 *                        "reasoning","totalTokens",
 *                        "cost":{"input","output","cacheRead","cacheWrite",
 *                                "total" (USD)}},
 *               "timestamp":<epoch ms>,...}}
 *
 * The base JsonUsageAdapter already resolves model via `message.model`,
 * tokens via `message.usage`, timestamps via the line-level ISO `timestamp`,
 * and (with the shared normalizeCost extension) the imported USD cost via
 * `message.usage.cost.total`. This adapter only fixes the provider identity.
 */
/** opencode usage from pi agent session transcripts with real opencode-go billing. */
export class OpenCodeUsageAdapter extends JsonUsageAdapter {
  public override readonly provider = "opencode" as const;
}
