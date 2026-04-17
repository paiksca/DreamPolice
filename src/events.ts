import fs from "node:fs/promises";
import path from "node:path";

export type DreamPoliceEvent =
  | {
      type: "dreamPolice.verified";
      timestamp: string;
      memoryPath: string;
      candidateKeys: string[];
      verdict: "accepted" | "needs_revision" | "unsalvageable";
      confidence: number;
      rounds: number;
    }
  | {
      type: "dreamPolice.corrected";
      timestamp: string;
      memoryPath: string;
      candidateKeys: string[];
      round: number;
      appliedEditCount: number;
    }
  | {
      type: "dreamPolice.flagged";
      timestamp: string;
      memoryPath: string;
      candidateKeys: string[];
      reason: string;
      rationale: string;
    }
  | {
      type: "dreamPolice.skipped";
      timestamp: string;
      memoryPath: string;
      reason: string;
    }
  | {
      type: "dreamPolice.circuitTripped";
      timestamp: string;
      consecutiveErrors: number;
      threshold: number;
    };

export type EventEmitterDeps = {
  appendFile?: (absolutePath: string, content: string) => Promise<void>;
  mkdir?: (absolutePath: string) => Promise<void>;
};

const defaultAppend = (p: string, c: string): Promise<void> => fs.appendFile(p, c, "utf8");
const defaultMkdir = (p: string): Promise<void> =>
  fs.mkdir(p, { recursive: true }).then(() => undefined);

export async function emitDreamPoliceEvent(params: {
  workspaceDir: string;
  relativeFile: string;
  event: DreamPoliceEvent;
  deps?: EventEmitterDeps;
}): Promise<void> {
  const appendFile = params.deps?.appendFile ?? defaultAppend;
  const mkdir = params.deps?.mkdir ?? defaultMkdir;
  const absolutePath = path.isAbsolute(params.relativeFile)
    ? params.relativeFile
    : path.resolve(params.workspaceDir, params.relativeFile);
  await mkdir(path.dirname(absolutePath));
  await appendFile(absolutePath, JSON.stringify(params.event) + "\n");
}
