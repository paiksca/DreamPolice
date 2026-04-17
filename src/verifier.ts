import { z } from "../api.js";
import type { DreamPoliceProviderConfig } from "./config.js";
import type { PromotionDiff, VerifierCritique, VerifierError, VerifierIssue } from "./types.js";

const IssueSchema = z.object({
  claim: z.string(),
  location: z.object({
    memoryPath: z.string(),
    startLine: z.number().int().nonnegative(),
    endLine: z.number().int().nonnegative(),
  }),
  reason: z.string(),
  severity: z.enum(["info", "warn", "error"]),
  suggestedAction: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("remove") }),
    z.object({ kind: z.literal("rewrite"), replacement: z.string() }),
    z.object({ kind: z.literal("annotate"), note: z.string() }),
  ]),
});

const CritiqueSchema = z.object({
  verdict: z.enum(["accepted", "needs_revision", "unsalvageable"]),
  issues: z.array(IssueSchema),
  rationale: z.string().max(4000),
  confidence: z.number().min(0).max(1),
});

export type VerifyResult =
  | { ok: true; critique: VerifierCritique }
  | { ok: false; error: VerifierError };

export type VerifierFetchFn = (url: string, init: RequestInit) => Promise<Response>;

export type VerifierDeps = {
  fetch?: VerifierFetchFn;
  readEnv?: (name: string) => string | undefined;
  now?: () => number;
};

export type VerifyParams = {
  diff: PromotionDiff;
  provider: DreamPoliceProviderConfig;
  priorContext: string;
  critiqueContext?: { lastCritique: VerifierCritique; roundsUsed: number };
};

const SYSTEM_PROMPT = [
  "You are Dream Police, an independent reviewer of memory consolidations produced by another AI.",
  "The agent being reviewed wrote notes into a long-term memory file. Your job is to decide whether each newly promoted claim is supported by its cited source and is internally consistent with the rest of the file.",
  "Only raise issues you can justify. Do not invent problems.",
  "Grade confidence honestly: low confidence should not produce hard remove/rewrite actions.",
  "Respond with JSON only, matching the schema the user provides. No prose outside JSON.",
].join(" ");

function buildPrompt(params: VerifyParams): string {
  const header = [
    `memoryPath: ${params.diff.memoryPath}`,
    `appliedAt: ${params.diff.appliedAt}`,
    `candidateCount: ${params.diff.candidates.length}`,
  ].join("\n");

  const candidates = params.diff.candidates
    .map((candidate, index) => {
      return [
        `### Candidate ${index + 1} (key=${candidate.key})`,
        `source: ${candidate.sourcePath}`,
        `range: ${candidate.startLine}-${candidate.endLine}`,
        `score: ${candidate.score.toFixed(3)} recallCount: ${candidate.recallCount}`,
        "snippet:",
        candidate.snippet,
      ].join("\n");
    })
    .join("\n\n");

  const priorSection = params.priorContext
    ? ["## Prior memory tail (read-only context)", params.priorContext].join("\n")
    : "";

  const critiqueSection = params.critiqueContext
    ? [
        "## Prior review",
        `round: ${params.critiqueContext.roundsUsed}`,
        `previous verdict: ${params.critiqueContext.lastCritique.verdict}`,
        `previous rationale: ${params.critiqueContext.lastCritique.rationale}`,
        "The dreamer has attempted a revision. Re-evaluate from scratch.",
      ].join("\n")
    : "";

  const schemaHint = [
    "## Output Schema",
    "Return a single JSON object with these fields:",
    '  verdict: "accepted" | "needs_revision" | "unsalvageable"',
    '  issues: array of { claim, location: {memoryPath,startLine,endLine}, reason, severity: "info"|"warn"|"error", suggestedAction: {kind:"remove"} | {kind:"rewrite", replacement} | {kind:"annotate", note} }',
    "  rationale: short text summary",
    "  confidence: number in [0,1]",
    'If verdict is "accepted" then issues MUST be empty.',
    'If verdict is "needs_revision" then issues MUST contain at least one "warn" or "error".',
  ].join("\n");

  return [header, "## Promoted Candidates", candidates, priorSection, critiqueSection, schemaHint]
    .filter((section) => section.length > 0)
    .join("\n\n");
}

function parseCritique(text: string): VerifierCritique | null {
  try {
    const parsed = JSON.parse(text);
    const result = CritiqueSchema.safeParse(parsed);
    if (!result.success) {
      return null;
    }
    return normalizeCritique(result.data);
  } catch {
    return null;
  }
}

function normalizeCritique(critique: VerifierCritique): VerifierCritique {
  const normalizedIssues: VerifierIssue[] = [...critique.issues].toSorted((a, b) => {
    if (a.location.memoryPath !== b.location.memoryPath) {
      return a.location.memoryPath.localeCompare(b.location.memoryPath);
    }
    if (a.location.startLine !== b.location.startLine) {
      return a.location.startLine - b.location.startLine;
    }
    return a.location.endLine - b.location.endLine;
  });
  const normalized: VerifierCritique = {
    verdict: critique.verdict,
    issues: normalizedIssues,
    rationale: critique.rationale,
    confidence: critique.confidence,
  };
  if (normalized.verdict === "accepted") {
    normalized.issues = [];
  }
  return normalized;
}

type ChatMessage = { role: "system" | "user"; content: string };

async function postChat(
  provider: DreamPoliceProviderConfig,
  apiKey: string,
  messages: ChatMessage[],
  fetchImpl: VerifierFetchFn,
): Promise<VerifyResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), provider.timeoutMs);
  try {
    const response = await fetchImpl(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        ...provider.headers,
      },
      body: JSON.stringify({
        model: provider.model,
        messages,
        temperature: 0.1,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, error: { code: "http_error", status: response.status } };
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = payload.choices?.[0]?.message?.content ?? "";
    const critique = parseCritique(text);
    if (!critique) {
      return { ok: false, error: { code: "bad_json" } };
    }
    return { ok: true, critique };
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") {
      return { ok: false, error: { code: "timeout" } };
    }
    return {
      ok: false,
      error: { code: "network", detail: err instanceof Error ? err.message : String(err) },
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyPromotion(
  params: VerifyParams,
  deps: VerifierDeps = {},
): Promise<VerifyResult> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    return { ok: false, error: { code: "network", detail: "no fetch implementation available" } };
  }
  const readEnv = deps.readEnv ?? ((name: string) => process.env[name]);
  const apiKey = readEnv(params.provider.apiKeyEnv);
  if (!apiKey) {
    return {
      ok: false,
      error: { code: "network", detail: `env var ${params.provider.apiKeyEnv} is not set` },
    };
  }

  const prompt = buildPrompt(params);
  const initial = await postChat(
    params.provider,
    apiKey,
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    fetchImpl,
  );
  if (initial.ok || initial.error.code !== "bad_json") {
    return initial;
  }

  const retry = await postChat(
    params.provider,
    apiKey,
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
      {
        role: "user",
        content:
          "Your previous response was not valid JSON matching the schema. Return ONLY a single JSON object matching the schema described above.",
      },
    ],
    fetchImpl,
  );
  if (retry.ok) {
    return retry;
  }
  if (retry.error.code === "bad_json") {
    return {
      ok: true,
      critique: {
        verdict: "unsalvageable",
        issues: [],
        rationale: "verifier returned malformed JSON twice; declaring unsalvageable",
        confidence: 0,
      },
    };
  }
  return retry;
}
