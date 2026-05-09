import { JsonUsageAdapter } from "./JsonUsageAdapter";

export class CodexUsageAdapter extends JsonUsageAdapter {
  public readonly provider = "codex" as const;
}
