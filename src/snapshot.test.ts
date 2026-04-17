import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  captureSnapshot,
  listSnapshots,
  parseSnapshotFilename,
  pruneSnapshots,
  restoreSnapshot,
  slugifyMemoryPath,
  unslugifyMemoryPath,
} from "./snapshot.js";

describe("slugifyMemoryPath / unslugifyMemoryPath round-trip", () => {
  it.each([
    "memory/long-term.md",
    "memory/dreams/2026-04-17.md",
    "some.deep/nested/path/with-dots.md",
    "flat.md",
  ])("round-trips %s through the slug encoding", (memoryPath) => {
    expect(unslugifyMemoryPath(slugifyMemoryPath(memoryPath))).toBe(memoryPath);
  });

  it("parses a snapshot filename back into memoryPath and timestamp", () => {
    const parsed = parseSnapshotFilename(
      "memory~long-term.md__2026-04-17T00-00-00-000Z.snap",
    );
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.memoryPath).toBe("memory/long-term.md");
    expect(parsed.timestamp).toBe("2026-04-17T00-00-00-000Z");
  });

  it("returns null for non-snapshot filenames", () => {
    expect(parseSnapshotFilename("foo.bar.txt")).toBeNull();
    expect(parseSnapshotFilename("no-separator.snap")).toBeNull();
  });
});

describe("snapshot (real fs)", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dream-police-snap-"));
    await fs.mkdir(path.join(tmp, "memory"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("captures a snapshot of an existing memory file", async () => {
    await fs.writeFile(path.join(tmp, "memory", "long-term.md"), "# v1\n", "utf8");
    const snapPath = await captureSnapshot({
      workspaceDir: tmp,
      memoryPath: "memory/long-term.md",
      snapshotDir: "memory/.dreams/.dream-police/snapshots",
    });
    expect(snapPath).not.toBeNull();
    if (!snapPath) return;
    const contents = await fs.readFile(snapPath, "utf8");
    expect(contents).toBe("# v1\n");
  });

  it("returns null when the memory file does not exist", async () => {
    const snapPath = await captureSnapshot({
      workspaceDir: tmp,
      memoryPath: "memory/missing.md",
      snapshotDir: "memory/.dreams/.dream-police/snapshots",
    });
    expect(snapPath).toBeNull();
  });

  it("restores a snapshot back into place", async () => {
    await fs.writeFile(path.join(tmp, "memory", "long-term.md"), "# original\n", "utf8");
    const snapPath = await captureSnapshot({
      workspaceDir: tmp,
      memoryPath: "memory/long-term.md",
      snapshotDir: "memory/.dreams/.dream-police/snapshots",
    });
    if (!snapPath) throw new Error("snapshot failed");
    await fs.writeFile(path.join(tmp, "memory", "long-term.md"), "# mutated\n", "utf8");
    await restoreSnapshot({
      workspaceDir: tmp,
      snapshotAbsolutePath: snapPath,
      memoryPath: "memory/long-term.md",
    });
    const contents = await fs.readFile(path.join(tmp, "memory", "long-term.md"), "utf8");
    expect(contents).toBe("# original\n");
  });

  it("lists and prunes snapshots by mtime", async () => {
    await fs.writeFile(path.join(tmp, "memory", "long-term.md"), "# v\n", "utf8");
    const snaps: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const snapPath = await captureSnapshot({
        workspaceDir: tmp,
        memoryPath: "memory/long-term.md",
        snapshotDir: "memory/.dreams/.dream-police/snapshots",
        now: () => new Date(2026, 3, 17, 0, 0, i),
      });
      if (!snapPath) throw new Error("snapshot failed");
      snaps.push(snapPath);
      // bump mtime
      const base = Date.now() + i * 1000;
      await fs.utimes(snapPath, base / 1000, base / 1000);
    }
    const listed = await listSnapshots({
      workspaceDir: tmp,
      snapshotDir: "memory/.dreams/.dream-police/snapshots",
      memoryPath: "memory/long-term.md",
    });
    expect(listed.length).toBe(4);
    const pruned = await pruneSnapshots({
      workspaceDir: tmp,
      snapshotDir: "memory/.dreams/.dream-police/snapshots",
      keep: 2,
      memoryPath: "memory/long-term.md",
    });
    expect(pruned).toBe(2);
    const afterPrune = await listSnapshots({
      workspaceDir: tmp,
      snapshotDir: "memory/.dreams/.dream-police/snapshots",
      memoryPath: "memory/long-term.md",
    });
    expect(afterPrune.length).toBe(2);
  });
});
