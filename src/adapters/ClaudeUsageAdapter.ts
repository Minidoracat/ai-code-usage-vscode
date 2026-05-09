import { JsonUsageAdapter } from "./JsonUsageAdapter";

export class ClaudeUsageAdapter extends JsonUsageAdapter {
  public readonly provider = "claude" as const;
}
