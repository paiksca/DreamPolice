import { createServer, type Server } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendMemoryHostEvent } from "../api.js";
import { resolveDreamPoliceConfig } from "./config.js";
import { processPromotionEvent } from "./pipeline.js";
import { JournalTailer } from "./tailer.js";

type Critique = {
  verdict: "accepted" | "needs_revision" | "unsalvageable";
  issues: Array<{
    claim: string;
    location: { memoryPath: string; startLine: number; endLine: number };
    reason: string;
    severity: "info" | "warn" | "error";
    suggestedAction:
      | { kind: "remove" }
      | { kind: "rewrite"; replacement: string }
      | { kind: "annotate"; note: string };
  }>;
  rationale: string;
  confidence: number;
};

function mockVerifierResponses(): Critique[] {
  return [
    {
      verdict: "needs_revision",
      issues: [
        {
          claim: "the sky is green",
          location: { memoryPath: "memory/long-term.md", startLine: 7, endLine: 7 },
          reason: "the sky is blue, not green; unsupported claim",
          severity: "error",
          suggestedAction: { kind: "remove" },
        },
      ],
      rationale: "one unsupported claim (sky is green); remove it",
      confidence: 0.95,
    },
    {
      verdict: "accepted",
      issues: [],
      rationale: "remaining claims are supported",
      confidence: 0.9,
    },
  ];
}

describe("dream-police end-to-end smoke", () => {
  let workspaceDir: string;
  let server: Server;
  let port: number;
  let callCount = 0;
  let requestedBodies: string[] = [];

  beforeAll(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "dream-police-smoke-"));
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(
      path.join(memoryDir, "long-term.md"),
      [
        "# Long-term memory",
        "",
        "## Notes",
        "- Earlier factual note",
        "",
        "## Promoted 2026-04-16",
        "- the sky is green",
        "- water freezes at 0C",
        "",
      ].join("\n"),
      "utf8",
    );

    const responses = mockVerifierResponses();
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        requestedBodies.push(Buffer.concat(chunks).toString("utf8"));
        const critique = responses[Math.min(callCount, responses.length - 1)];
        callCount += 1;
        const body = JSON.stringify({
          choices: [{ message: { content: JSON.stringify(critique) } }],
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("smoke: server did not bind to a port");
    }
    port = address.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it(
    "tails a real journal, corrects the memory file, and accepts on re-verify",
    async () => {
      await appendMemoryHostEvent(workspaceDir, {
        type: "memory.promotion.applied",
        timestamp: new Date().toISOString(),
        memoryPath: "memory/long-term.md",
        applied: 1,
        candidates: [
          {
            key: "smoke-k1",
            path: "source.md",
            startLine: 7,
            endLine: 7,
            score: 0.9,
            recallCount: 3,
          },
        ],
      });

      process.env.DREAM_POLICE_SMOKE_KEY = "smoke-key-value";
      const config = resolveDreamPoliceConfig({
        enabled: true,
        verifier: {
          provider: {
            baseUrl: `http://127.0.0.1:${port}/v1`,
            apiKeyEnv: "DREAM_POLICE_SMOKE_KEY",
            model: "smoke-model",
          },
        },
        retry: { maxRounds: 2 },
        pollIntervalMs: 200,
      });

      const logger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      };

      const tailer = new JournalTailer({
        workspaceDir,
        pollIntervalMs: 200,
        pauseFile: ".dream-police.paused",
        logger,
        handler: async (event) => {
          await processPromotionEvent({
            workspaceDir,
            config,
            event,
            logger,
          });
        },
      });

      const processed = await tailer.poll();
      expect(processed).toBe(1);

      const afterMemory = await fs.readFile(
        path.join(workspaceDir, "memory", "long-term.md"),
        "utf8",
      );
      expect(afterMemory).not.toContain("the sky is green");
      expect(afterMemory).toContain("water freezes at 0C");

      const cursorPath = path.join(
        workspaceDir,
        "memory",
        ".dreams",
        ".dream-police.cursor",
      );
      const cursorRaw = await fs.readFile(cursorPath, "utf8");
      const cursor = JSON.parse(cursorRaw) as { offset: number; lastTimestamp: string };
      expect(cursor.offset).toBeGreaterThan(0);
      expect(cursor.lastTimestamp.length).toBeGreaterThan(0);

      expect(callCount).toBeGreaterThanOrEqual(2);
      expect(requestedBodies[0]).toContain("the sky is green");

      const auditPath = path.join(workspaceDir, "memory", "DREAMS_POLICE.md");
      const auditExists = await fs
        .access(auditPath)
        .then(() => true)
        .catch(() => false);
      expect(auditExists).toBe(false);
    },
    15_000,
  );
});
