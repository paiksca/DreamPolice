import type { ResolvedDreamPoliceConfig } from "./config.js";
import type { PromotionCandidateSlice, PromotionDiff } from "./types.js";

export type PrivacyDecision =
  | { kind: "allow"; diff: PromotionDiff }
  | { kind: "redact"; diff: PromotionDiff; redactedFields: string[] }
  | { kind: "skip"; reason: string }
  | { kind: "flag"; diff: PromotionDiff; reason: string };

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_REGEX = /\+?\d[\d\s().-]{7,}\d/g;
const TOKEN_REGEX = /\b(?:sk|pk|rk|api)[-_][A-Za-z0-9]{16,}\b/g;

function buildTagMatcher(tags: string[]): RegExp | null {
  if (tags.length === 0) {
    return null;
  }
  const escaped = tags.map((tag) => tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`<!--\\s*tag:(?:${escaped.join("|")})\\s*-->`, "i");
}

function matchesPathPattern(pathPatterns: string[], sourcePath: string): boolean {
  for (const pattern of pathPatterns) {
    if (pattern.length === 0) {
      continue;
    }
    if (sourcePath === pattern) {
      return true;
    }
    if (pattern.endsWith("/**") && sourcePath.startsWith(pattern.slice(0, -3))) {
      return true;
    }
    if (pattern.includes("*")) {
      const regex = new RegExp(
        "^" +
          pattern
            .split("*")
            .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
            .join(".*") +
          "$",
      );
      if (regex.test(sourcePath)) {
        return true;
      }
    }
  }
  return false;
}

function redactString(input: string): string {
  return input
    .replace(EMAIL_REGEX, "<REDACTED:email>")
    .replace(TOKEN_REGEX, "<REDACTED:token>")
    .replace(PHONE_REGEX, "<REDACTED:phone>");
}

function redactCandidate(candidate: PromotionCandidateSlice): {
  candidate: PromotionCandidateSlice;
  changed: boolean;
} {
  const redacted = redactString(candidate.snippet);
  return {
    candidate: redacted === candidate.snippet ? candidate : { ...candidate, snippet: redacted },
    changed: redacted !== candidate.snippet,
  };
}

export function applyPrivacyPolicy(
  diff: PromotionDiff,
  cfg: ResolvedDreamPoliceConfig["sensitivity"],
): PrivacyDecision {
  const tagMatcher = buildTagMatcher(cfg.tags);
  const taggedCandidates =
    cfg.tags.length > 0
      ? diff.candidates.filter((candidate) =>
          tagMatcher ? tagMatcher.test(candidate.snippet) : false,
        )
      : [];
  const blockedByPath = diff.candidates.some((candidate) =>
    matchesPathPattern(cfg.pathPatterns, candidate.sourcePath),
  );

  if (blockedByPath || taggedCandidates.length > 0) {
    if (cfg.onSensitive === "skip") {
      const reason = blockedByPath
        ? "source path matches a sensitive pattern"
        : "candidate contains a sensitive tag marker";
      return { kind: "skip", reason };
    }
    if (cfg.onSensitive === "flag") {
      return {
        kind: "flag",
        diff,
        reason: blockedByPath
          ? "source path matches a sensitive pattern"
          : "candidate contains a sensitive tag marker",
      };
    }
  }

  if (cfg.onSensitive === "skip") {
    return { kind: "allow", diff };
  }

  const redactedFields: string[] = [];
  const redactedCandidates = diff.candidates.map((candidate) => {
    const { candidate: next, changed } = redactCandidate(candidate);
    if (changed) {
      redactedFields.push(candidate.key);
    }
    return next;
  });

  const redactedBlock = redactString(diff.rawBlock);
  if (redactedFields.length === 0 && redactedBlock === diff.rawBlock) {
    return { kind: "allow", diff };
  }
  return {
    kind: "redact",
    diff: { ...diff, candidates: redactedCandidates, rawBlock: redactedBlock },
    redactedFields,
  };
}
