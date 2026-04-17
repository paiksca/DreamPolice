import { describe, expect, it } from "vitest";
import { applyPrivacyPolicy } from "./privacy.js";
import type { PromotionCandidateSlice, PromotionDiff } from "./types.js";

function makeDiff(overrides: Partial<PromotionCandidateSlice>[] = []): PromotionDiff {
  const base: PromotionCandidateSlice = {
    key: "k1",
    sourcePath: "notes/a.md",
    memoryPath: "memory/long-term.md",
    startLine: 10,
    endLine: 12,
    score: 0.9,
    recallCount: 3,
    snippet: "nothing sensitive",
  };
  const candidates = overrides.length === 0 ? [base] : overrides.map((o) => ({ ...base, ...o }));
  return {
    memoryPath: "memory/long-term.md",
    appliedAt: "2026-04-16T00:00:00Z",
    candidates,
    rawBlock: candidates.map((c) => c.snippet).join("\n"),
  };
}

const SENSITIVITY = {
  tags: ["secret", "private"],
  pathPatterns: [],
  onSensitive: "redact" as const,
};

describe("applyPrivacyPolicy", () => {
  it("passes clean content through unchanged", () => {
    const decision = applyPrivacyPolicy(makeDiff(), SENSITIVITY);
    expect(decision.kind).toBe("allow");
  });

  it("redacts emails by default", () => {
    const decision = applyPrivacyPolicy(
      makeDiff([{ snippet: "contact alice@example.com for details" }]),
      SENSITIVITY,
    );
    expect(decision.kind).toBe("redact");
    if (decision.kind !== "redact") {
      return;
    }
    expect(decision.diff.candidates[0].snippet).not.toContain("alice@example.com");
    expect(decision.diff.candidates[0].snippet).toContain("<REDACTED:email>");
  });

  it("redacts API tokens", () => {
    const decision = applyPrivacyPolicy(
      makeDiff([{ snippet: "token sk-aaaaaaaaaaaaaaaaaaaa leaked" }]),
      SENSITIVITY,
    );
    expect(decision.kind).toBe("redact");
    if (decision.kind !== "redact") {
      return;
    }
    expect(decision.diff.candidates[0].snippet).not.toContain("sk-aaaaaaaaaaaaaaaaaaaa");
  });

  it("skips when onSensitive=skip and a tag marker is present", () => {
    const decision = applyPrivacyPolicy(
      makeDiff([{ snippet: "<!-- tag:secret --> classified note" }]),
      { ...SENSITIVITY, onSensitive: "skip" },
    );
    expect(decision.kind).toBe("skip");
  });

  it("flags when onSensitive=flag and a tag marker is present", () => {
    const decision = applyPrivacyPolicy(makeDiff([{ snippet: "<!-- tag:private --> personal" }]), {
      ...SENSITIVITY,
      onSensitive: "flag",
    });
    expect(decision.kind).toBe("flag");
  });

  it("skips when sourcePath matches a blocked glob", () => {
    const decision = applyPrivacyPolicy(
      makeDiff([{ sourcePath: "journal/secret/2026.md", snippet: "benign text" }]),
      { ...SENSITIVITY, pathPatterns: ["journal/secret/**"], onSensitive: "skip" },
    );
    expect(decision.kind).toBe("skip");
  });

  it("never leaks the original token substring when redacting", () => {
    const secret = "sk-supersecret1234567890";
    const decision = applyPrivacyPolicy(
      makeDiff([{ snippet: `use ${secret} to authenticate` }]),
      SENSITIVITY,
    );
    expect(decision.kind).toBe("redact");
    if (decision.kind !== "redact") {
      return;
    }
    expect(JSON.stringify(decision.diff)).not.toContain(secret);
  });
});
