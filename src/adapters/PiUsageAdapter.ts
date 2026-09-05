import { JsonUsageAdapter } from "./JsonUsageAdapter";

/**
 * pi coding agent session transcripts (written by omp, the pi CLI, and the
 * vscode-pi extension). Each message line carries the billed usage:
 *
 *   {"type":"message","id":...,"parentId":...,"timestamp":"<ISO>",
 *    "message":{"role":"assistant","provider":"anthropic","model":"claude-opus-5",
 *               "usage":{"input","output","cacheRead","cacheWrite","totalTokens",
 *                        "cost":{"input","output","cacheRead","cacheWrite","total" (USD)}}}}
 *
 * JsonUsageAdapter already resolves model via `message.model`, tokens via
 * `message.usage`, timestamps via the line-level ISO `timestamp`, and the
 * imported USD cost via `message.usage.cost.total`. This adapter only fixes
 * the provider identity.
 */
export class PiUsageAdapter extends JsonUsageAdapter {
  public override readonly provider = "pi" as const;
}
