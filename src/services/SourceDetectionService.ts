import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UsageProvider } from "../domain/types";

const maxProbeDepth = 5;

export type DetectedUsageSource = {
  provider: UsageProvider;
  sourcePath: string;
  files: number;
};

export class SourceDetectionService {
  public constructor(
    private readonly homeDirectory = os.homedir(),
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly platform = process.platform,
    private readonly globalStorageRoot?: string,
  ) {}

  /** First existing candidate wins per provider; later fallbacks for the same provider are skipped. */
  public async detect(): Promise<DetectedUsageSource[]> {
    const candidates = usageSourceCandidates(this.homeDirectory, this.environment, this.platform, this.globalStorageRoot);

    const detected: DetectedUsageSource[] = [];
    for (const candidate of candidates) {
      if (detected.some((source) => source.provider === candidate.provider)) {
        continue;
      }
      const files = await countUsageFiles(candidate.sourcePath, 0);
      if (files > 0) {
        detected.push({ ...candidate, files });
      }
    }
    return detected;
  }
}

/**
 * Candidate usage roots in priority order, deduplicated by path.
 * `globalStorageRoot` is VS Code's `User/globalStorage` directory (parent of
 * this extension's own `globalStorageUri`), used to locate the vscode-pi
 * extension's bundled agent sessions for desktop and remote hosts alike.
 */
export function usageSourceCandidates(
  homeDirectory = os.homedir(),
  environment: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  globalStorageRoot?: string,
): Array<{ provider: UsageProvider; sourcePath: string }> {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const homeRoots = uniqueStrings([
    homeDirectory,
    environment["HOME"],
    environment["USERPROFILE"],
    environment["HOMEDRIVE"] && environment["HOMEPATH"] ? `${environment["HOMEDRIVE"]}${environment["HOMEPATH"]}` : undefined,
  ]).filter((homeRoot) => isNativeUsagePath(homeRoot, platform));

  const piAgentDir = environment["PI_CODING_AGENT_DIR"]?.trim();
  const candidates = [
    ...homeRoots.flatMap((homeRoot) => [
      { provider: "claude" as const, sourcePath: pathApi.join(homeRoot, ".claude", "projects") },
      { provider: "codex" as const, sourcePath: pathApi.join(homeRoot, ".codex", "sessions") },
    ]),
    ...(piAgentDir ? [{ provider: "pi" as const, sourcePath: pathApi.join(piAgentDir, "sessions") }] : []),
    ...homeRoots.flatMap((homeRoot) => [
      { provider: "pi" as const, sourcePath: pathApi.join(homeRoot, ".omp", "agent", "sessions") },
      { provider: "pi" as const, sourcePath: pathApi.join(homeRoot, ".pi", "agent", "sessions") },
    ]),
    ...(globalStorageRoot
      ? [{ provider: "pi" as const, sourcePath: pathApi.join(globalStorageRoot, "cdervis.vscode-pi", "bundled-pi-agent", "sessions") }]
      : []),
  ];
  const seen = new Set<string>();
  return candidates.filter((candidate) => !seen.has(candidate.sourcePath) && seen.add(candidate.sourcePath));
}

export function isNativeUsagePath(value: string | undefined, platform = process.platform): boolean {
  const trimmed = value?.trim();
  if (!trimmed) {
    return false;
  }

  if (platform === "win32") {
    return !trimmed.startsWith("/");
  }

  return !/^[a-zA-Z]:[\\/]/.test(trimmed) && !trimmed.startsWith("\\\\");
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

async function countUsageFiles(sourcePath: string, depth: number): Promise<number> {
  if (depth > maxProbeDepth) {
    return 0;
  }

  try {
    const stat = await fs.stat(sourcePath);
    if (stat.isFile()) {
      return /\.(json|jsonl)$/i.test(sourcePath) ? 1 : 0;
    }
    if (!stat.isDirectory()) {
      return 0;
    }
  } catch {
    return 0;
  }

  let entries;
  try {
    entries = await fs.readdir(sourcePath, { withFileTypes: true });
  } catch {
    return 0;
  }
  let files = 0;
  for (const entry of entries) {
    const fullPath = path.join(sourcePath, entry.name);
    if (entry.isDirectory()) {
      files += await countUsageFiles(fullPath, depth + 1);
    } else if (entry.isFile() && /\.(json|jsonl)$/i.test(entry.name)) {
      files += 1;
    }
  }
  return files;
}
