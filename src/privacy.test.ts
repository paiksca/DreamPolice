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

  it("/** glob requires a true segment boundary (journal/secretX/... does not match journal/secret/**)", () => {
    const decision = applyPrivacyPolicy(
      makeDiff([{ sourcePath: "journal/secret-leak/2026.md", snippet: "benign" }]),
      { ...SENSITIVITY, pathPatterns: ["journal/secret/**"], onSensitive: "skip" },
    );
    expect(decision.kind).toBe("allow");
  });

  it("inline * glob does not cross directory separators", () => {
    const decision = applyPrivacyPolicy(
      makeDiff([{ sourcePath: "journal/2026/secret.md", snippet: "benign" }]),
      { ...SENSITIVITY, pathPatterns: ["journal/*.md"], onSensitive: "skip" },
    );
    expect(decision.kind).toBe("allow");
  });

  it("bare ** matches any path including nested ones", () => {
    const decision = applyPrivacyPolicy(
      makeDiff([{ sourcePath: "deep/nested/path/file.md", snippet: "benign" }]),
      { ...SENSITIVITY, pathPatterns: ["**"], onSensitive: "skip" },
    );
    expect(decision.kind).toBe("skip");
  });

  it("inline * glob matches within a single segment", () => {
    const decision = applyPrivacyPolicy(
      makeDiff([{ sourcePath: "journal/secret.md", snippet: "benign" }]),
      { ...SENSITIVITY, pathPatterns: ["journal/*.md"], onSensitive: "skip" },
    );
    expect(decision.kind).toBe("skip");
  });

  it("phone regex does not hang on adversarial whitespace-heavy input", () => {
    const snippet = "1" + " ".repeat(10_000) + "x";
    const started = Date.now();
    const decision = applyPrivacyPolicy(makeDiff([{ snippet }]), SENSITIVITY);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(500);
    expect(decision.kind).toBe("allow");
  });

  it("redacts US-formatted phone numbers but leaves bare digit runs alone", () => {
    const decision = applyPrivacyPolicy(
      makeDiff([{ snippet: "call 555-123-4567 or 1234567890" }]),
      SENSITIVITY,
    );
    expect(decision.kind).toBe("redact");
    if (decision.kind !== "redact") {
      return;
    }
    expect(decision.diff.candidates[0].snippet).toContain("<REDACTED:phone>");
    expect(decision.diff.candidates[0].snippet).toContain("1234567890");
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
