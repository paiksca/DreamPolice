import type { ResolvedDreamPoliceConfig } from "./config.js";
import type { PromotionCandidateSlice, PromotionDiff } from "./types.js";

export type PrivacyDecision =
  | { kind: "allow"; diff: PromotionDiff }
  | { kind: "redact"; diff: PromotionDiff; redactedFields: string[] }
  | { kind: "skip"; reason: string }
  | { kind: "flag"; diff: PromotionDiff; reason: string };

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// Two bounded forms, neither with overlapping-class quantifiers that could
// cause catastrophic backtracking: E.164-ish (+ with 7–15 digits) and
// US-style formatted numbers with explicit separators.
const PHONE_REGEX = /\+\d{7,15}\b|\b\d{3}[-. ]\d{3}[-. ]\d{4}\b|\b\(\d{3}\)\s?\d{3}[-. ]\d{4}\b/g;
const TOKEN_REGEX = /\b(?:sk|pk|rk|api)[-_][A-Za-z0-9]{16,}\b/g;

function buildTagMatcher(tags: string[]): RegExp | null {
  if (tags.length === 0) {
    return null;
  }
  const escaped = tags.map((tag) => tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`<!--\\s*tag:(?:${escaped.join("|")})\\s*-->`, "i");
}

/**
 * Returns true iff `sourcePath` is inside the directory named by `prefix`.
 * "Inside" means equal to the prefix OR the prefix plus a `/` and more path.
 * Prevents `journal/secret` from matching `journal/secret-private`.
 */
function isWithinPrefix(sourcePath: string, prefix: string): boolean {
  if (prefix.length === 0) return false;
  if (sourcePath === prefix) return true;
  const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return sourcePath.startsWith(normalized);
}

function matchesPathPattern(pathPatterns: string[], sourcePath: string): boolean {
  for (const pattern of pathPatterns) {
    if (pattern.length === 0) continue;
    if (sourcePath === pattern) return true;
    // Whole-tree match: `**` alone means "anything", including nested paths.
    if (pattern === "**") return true;
    if (pattern.endsWith("/**")) {
      if (isWithinPrefix(sourcePath, pattern.slice(0, -3))) return true;
      continue;
    }
    if (pattern.includes("*")) {
      const escaped = pattern
        .split("*")
        .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*");
      const regex = new RegExp(`^${escaped}$`);
      if (regex.test(sourcePath)) return true;
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
    const reason = blockedByPath
      ? "source path matches a sensitive pattern"
      : "candidate contains a sensitive tag marker";
    if (cfg.onSensitive === "skip") {
      return { kind: "skip", reason };
    }
    if (cfg.onSensitive === "flag") {
      return { kind: "flag", diff, reason };
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
