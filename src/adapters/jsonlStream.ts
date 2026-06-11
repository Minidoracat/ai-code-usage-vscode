import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";

export const tailWindowBytes = 4_096;

export type JsonlStreamResult = {
  /** Byte offset just past the last complete (newline-terminated) line. */
  parsedBytes: number;
  /** Number of newline-terminated lines consumed. */
  lineCount: number;
  /** Whether any non-whitespace content was seen, including a partial tail. */
  sawContent: boolean;
  /** Unterminated trailing bytes after the last newline, if any. */
  partialTail?: string;
  /** sha256 of the last min(4096, consumed) bytes ending at parsedBytes. */
  tailHash: string;
};

/**
 * Streams a JSONL file line by line with byte-accurate offsets. Lines are
 * split on \n at the byte level (safe for UTF-8) and stripped of trailing \r.
 * The unterminated tail, if present, is returned instead of being emitted so
 * callers can decide whether to process it (full parse parity) or wait for the
 * writer to finish the line (incremental parse).
 */
export async function streamJsonlLines(
  filePath: string,
  onLine: (line: string, lineNumber: number) => void,
  options: { start?: number; lineNumberBase?: number } = {},
): Promise<JsonlStreamResult> {
  const start = options.start ?? 0;
  let lineNumber = options.lineNumberBase ?? 0;
  let parsedBytes = start;
  let sawContent = false;
  let pending: Buffer = Buffer.alloc(0);
  // Seed the rolling window with the bytes preceding `start` so a short
  // appended segment still hashes the full window ending at parsedBytes.
  let tailWindow: Buffer = start > 0 ? await readWindowBefore(filePath, start) : Buffer.alloc(0);

  const appendTailWindow = (consumed: Buffer): void => {
    tailWindow = Buffer.concat([tailWindow, consumed]);
    if (tailWindow.length > tailWindowBytes) {
      tailWindow = tailWindow.subarray(tailWindow.length - tailWindowBytes);
    }
  };

  const stream = createReadStream(filePath, start > 0 ? { start } : {});
  for await (const chunk of stream) {
    pending = pending.length === 0 ? (chunk as Buffer) : Buffer.concat([pending, chunk as Buffer]);
    let lineStart = 0;
    let newlineIndex = pending.indexOf(10, lineStart);
    while (newlineIndex !== -1) {
      const lineBytes = pending.subarray(lineStart, newlineIndex);
      const line = decodeLine(lineBytes);
      lineNumber += 1;
      if (line.trim()) {
        sawContent = true;
      }
      onLine(line, lineNumber);
      lineStart = newlineIndex + 1;
      newlineIndex = pending.indexOf(10, lineStart);
    }
    if (lineStart > 0) {
      appendTailWindow(pending.subarray(0, lineStart));
      parsedBytes += lineStart;
      pending = Buffer.from(pending.subarray(lineStart));
    }
  }

  let partialTail: string | undefined;
  if (pending.length > 0) {
    const tailText = decodeLine(pending);
    if (tailText.trim()) {
      sawContent = true;
      partialTail = tailText;
    }
  }

  return {
    parsedBytes,
    lineCount: lineNumber - (options.lineNumberBase ?? 0),
    sawContent,
    partialTail,
    tailHash: sha256Hex(tailWindow),
  };
}

/** Verifies that the bytes leading up to parsedBytes still match tailHash. */
export async function tailMatches(filePath: string, parsedBytes: number, tailHash: string): Promise<boolean> {
  const windowSize = Math.min(tailWindowBytes, parsedBytes);
  if (windowSize <= 0) {
    return parsedBytes === 0;
  }
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(windowSize);
    const { bytesRead } = await handle.read(buffer, 0, windowSize, parsedBytes - windowSize);
    if (bytesRead !== windowSize) {
      return false;
    }
    return sha256Hex(buffer) === tailHash;
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

async function readWindowBefore(filePath: string, end: number): Promise<Buffer> {
  const windowSize = Math.min(tailWindowBytes, end);
  if (windowSize <= 0) {
    return Buffer.alloc(0);
  }
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(windowSize);
    const { bytesRead } = await handle.read(buffer, 0, windowSize, end - windowSize);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function decodeLine(bytes: Buffer): string {
  const trimmed = bytes.length > 0 && bytes[bytes.length - 1] === 13 ? bytes.subarray(0, bytes.length - 1) : bytes;
  return trimmed.toString("utf8");
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}
