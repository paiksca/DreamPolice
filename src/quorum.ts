import type { DreamPoliceProviderConfig, QuorumPolicy } from "./config.js";
import type { VerifyParams, VerifyResult, VerifierDeps } from "./verifier.js";
import { verifyPromotion } from "./verifier.js";
import type { VerifierCritique, VerifierIssue } from "./types.js";

export type QuorumParams = Omit<VerifyParams, "provider"> & {
  providers: DreamPoliceProviderConfig[];
  policy: QuorumPolicy;
};

type VoterResult = {
  provider: DreamPoliceProviderConfig;
  outcome: VerifyResult;
};

/**
 * Combine N parallel verifier votes into a single critique.
 *
 * Policies:
 *   - "unanimous" — only `accepted` if every voter accepts; else the most
 *     severe verdict wins (unsalvageable > needs_revision > accepted).
 *   - "majority" — the verdict with a strict majority wins; ties collapse to
 *     the more conservative verdict.
 *   - "conservative" (default) — the most severe verdict wins, biased toward
 *     `unsalvageable` then `needs_revision`. Any `unsalvageable` = flag.
 *
 * Regardless of policy, the returned `issues` list is the deduplicated union
 * of every dissenter's issues (so the corrector can address all of them).
 */
export async function verifyWithQuorum(
  params: QuorumParams,
  deps: VerifierDeps = {},
): Promise<VerifyResult> {
  if (params.providers.length === 0) {
    return { ok: false, error: { code: "network", detail: "quorum has no providers" } };
  }
  const votes: VoterResult[] = await Promise.all(
    params.providers.map(async (provider) => ({
      provider,
      outcome: await verifyPromotion({ ...params, provider }, deps),
    })),
  );
  const okVotes = votes.filter((v): v is { provider: DreamPoliceProviderConfig; outcome: { ok: true; critique: VerifierCritique } } => v.outcome.ok);
  if (okVotes.length === 0) {
    // All voters errored. Return the first error so the caller can see a real
    // code; the others are silently dropped.
    const first = votes[0].outcome;
    if (first.ok) {
      // Impossible given okVotes.length === 0, but appease TS.
      return { ok: false, error: { code: "network", detail: "quorum: unreachable" } };
    }
    return first;
  }

  const critiques = okVotes.map((v) => v.outcome.critique);
  const verdict = combineVerdicts(
    critiques.map((c) => c.verdict),
    params.policy,
  );
  const issues = mergeIssues(critiques);
  const confidence = averageConfidence(critiques);
  const rationale = renderQuorumRationale(critiques, verdict);
  const critique: VerifierCritique = {
    verdict,
    issues: verdict === "accepted" ? [] : issues,
    rationale,
    confidence,
  };
  return { ok: true, critique };
}

function severity(verdict: VerifierCritique["verdict"]): number {
  switch (verdict) {
    case "unsalvageable":
      return 2;
    case "needs_revision":
      return 1;
    default:
      return 0;
  }
}

function combineVerdicts(
  verdicts: VerifierCritique["verdict"][],
  policy: QuorumPolicy,
): VerifierCritique["verdict"] {
  if (verdicts.length === 0) return "unsalvageable";
  if (policy === "unanimous") {
    return verdicts.every((v) => v === "accepted")
      ? "accepted"
      : verdicts.reduce((a, b) => (severity(b) > severity(a) ? b : a));
  }
  if (policy === "majority") {
    const counts = new Map<VerifierCritique["verdict"], number>();
    for (const v of verdicts) counts.set(v, (counts.get(v) ?? 0) + 1);
    let best: VerifierCritique["verdict"] = "accepted";
    let bestCount = 0;
    for (const [v, c] of counts) {
      if (c > bestCount || (c === bestCount && severity(v) > severity(best))) {
        best = v;
        bestCount = c;
      }
    }
    return best;
  }
  // conservative: most severe verdict wins.
  return verdicts.reduce((a, b) => (severity(b) > severity(a) ? b : a));
}

function mergeIssues(critiques: VerifierCritique[]): VerifierIssue[] {
  const byKey = new Map<string, VerifierIssue>();
  for (const c of critiques) {
    for (const issue of c.issues) {
      const key = `${issue.location.memoryPath}:${issue.location.startLine}-${issue.location.endLine}:${issue.claim}`;
      if (!byKey.has(key)) byKey.set(key, issue);
    }
  }
  return [...byKey.values()].toSorted((a, b) => {
    if (a.location.memoryPath !== b.location.memoryPath) {
      return a.location.memoryPath.localeCompare(b.location.memoryPath);
    }
    if (a.location.startLine !== b.location.startLine) {
      return a.location.startLine - b.location.startLine;
    }
    return a.location.endLine - b.location.endLine;
  });
}

function averageConfidence(critiques: VerifierCritique[]): number {
  if (critiques.length === 0) return 0;
  const sum = critiques.reduce((acc, c) => acc + c.confidence, 0);
  return sum / critiques.length;
}

function renderQuorumRationale(
  critiques: VerifierCritique[],
  verdict: VerifierCritique["verdict"],
): string {
  const breakdown = critiques
    .map((c, i) => `[v${i + 1}] ${c.verdict} (${c.confidence.toFixed(2)}): ${c.rationale}`)
    .join(" | ");
  return `quorum verdict=${verdict} n=${critiques.length} · ${breakdown}`;
}
