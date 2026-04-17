import { buildPluginConfigSchema, z, type OpenClawPluginConfigSchema } from "../api.js";

export const DEFAULT_AUDIT_FILE = "memory/DREAMS_POLICE.md";
export const DEFAULT_PAUSE_FILE = ".dream-police.paused";
export const DEFAULT_POLL_INTERVAL_MS = 2000;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_ROUNDS = 2;
export const DEFAULT_MIN_APPLIED = 1;
export const DEFAULT_PRIOR_CONTEXT_LINES = 40;
export const DEFAULT_SENSITIVE_TAGS = ["secret", "private", "pii"] as const;
export const DEFAULT_ON_SENSITIVE = "redact" as const;

const ProviderSource = z.strictObject({
  baseUrl: z.string().url().optional(),
  apiKeyEnv: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(1000).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

const DreamPoliceConfigSource = z.strictObject({
  enabled: z.boolean().optional(),
  verifier: z
    .strictObject({
      provider: ProviderSource.optional(),
      corrector: ProviderSource.nullable().optional(),
      priorContextLines: z.number().int().min(0).max(500).optional(),
    })
    .optional(),
  retry: z
    .strictObject({
      maxRounds: z.number().int().min(0).max(5).optional(),
    })
    .optional(),
  scope: z
    .strictObject({
      minApplied: z.number().int().min(1).optional(),
    })
    .optional(),
  sensitivity: z
    .strictObject({
      tags: z.array(z.string()).optional(),
      pathPatterns: z.array(z.string()).optional(),
      onSensitive: z.enum(["skip", "redact", "flag"]).optional(),
    })
    .optional(),
  auditFile: z.string().min(1).optional(),
  pauseFile: z.string().min(1).optional(),
  pollIntervalMs: z.number().int().min(250).optional(),
});

export type DreamPolicePluginConfig = z.infer<typeof DreamPoliceConfigSource>;

type ProviderInput = z.infer<typeof ProviderSource> | null | undefined;

export type DreamPoliceProviderConfig = {
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
  timeoutMs: number;
  headers: Record<string, string>;
};

export type ResolvedDreamPoliceConfig = {
  enabled: boolean;
  verifier: {
    provider: DreamPoliceProviderConfig | null;
    corrector: DreamPoliceProviderConfig | null;
    priorContextLines: number;
  };
  retry: {
    maxRounds: number;
  };
  scope: {
    minApplied: number;
  };
  sensitivity: {
    tags: string[];
    pathPatterns: string[];
    onSensitive: "skip" | "redact" | "flag";
  };
  auditFile: string;
  pauseFile: string;
  pollIntervalMs: number;
};

function resolveProvider(input: ProviderInput): DreamPoliceProviderConfig | null {
  if (!input || !input.baseUrl || !input.apiKeyEnv || !input.model) {
    return null;
  }
  return {
    baseUrl: input.baseUrl.replace(/\/+$/, ""),
    apiKeyEnv: input.apiKeyEnv,
    model: input.model,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    headers: input.headers ?? {},
  };
}

export function resolveDreamPoliceConfig(
  input: DreamPolicePluginConfig | undefined,
): ResolvedDreamPoliceConfig {
  const parsed = input ? DreamPoliceConfigSource.safeParse(input) : null;
  const cfg = parsed?.success ? parsed.data : (input ?? {});

  const providerInput = cfg.verifier?.provider;
  const rawCorrector = cfg.verifier?.corrector;

  const provider = resolveProvider(providerInput);
  let corrector: DreamPoliceProviderConfig | null;
  if (rawCorrector === null) {
    corrector = null;
  } else if (rawCorrector === undefined) {
    corrector = provider;
  } else {
    corrector = resolveProvider(rawCorrector) ?? provider;
  }

  return {
    enabled: cfg.enabled ?? false,
    verifier: {
      provider,
      corrector,
      priorContextLines: cfg.verifier?.priorContextLines ?? DEFAULT_PRIOR_CONTEXT_LINES,
    },
    retry: {
      maxRounds: cfg.retry?.maxRounds ?? DEFAULT_MAX_ROUNDS,
    },
    scope: {
      minApplied: cfg.scope?.minApplied ?? DEFAULT_MIN_APPLIED,
    },
    sensitivity: {
      tags: cfg.sensitivity?.tags ?? [...DEFAULT_SENSITIVE_TAGS],
      pathPatterns: cfg.sensitivity?.pathPatterns ?? [],
      onSensitive: cfg.sensitivity?.onSensitive ?? DEFAULT_ON_SENSITIVE,
    },
    auditFile: cfg.auditFile ?? DEFAULT_AUDIT_FILE,
    pauseFile: cfg.pauseFile ?? DEFAULT_PAUSE_FILE,
    pollIntervalMs: cfg.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
  };
}

const schemaBase = buildPluginConfigSchema(DreamPoliceConfigSource, {
  safeParse(value: unknown) {
    if (value === undefined) {
      return { success: true, data: resolveDreamPoliceConfig(undefined) };
    }
    const result = DreamPoliceConfigSource.safeParse(value);
    if (result.success) {
      return { success: true, data: resolveDreamPoliceConfig(result.data) };
    }
    return {
      success: false,
      error: {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.filter((segment): segment is string | number => {
            const kind = typeof segment;
            return kind === "string" || kind === "number";
          }),
          message: issue.message,
        })),
      },
    };
  },
});

export const dreamPoliceConfigSchema: OpenClawPluginConfigSchema = schemaBase;
