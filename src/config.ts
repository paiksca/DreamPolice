import { buildPluginConfigSchema, z, type OpenClawPluginConfigSchema } from "../api.js";

export const DEFAULT_AUDIT_FILE = "memory/DREAMS_POLICE.md";
export const DEFAULT_HISTORY_FILE = "memory/DREAMS_LOG.md";
export const DEFAULT_EVENT_LOG_RELATIVE = "memory/.dreams/.dream-police/events.jsonl";
export const DEFAULT_SNAPSHOT_DIR_RELATIVE = "memory/.dreams/.dream-police/snapshots";
export const DEFAULT_PAUSE_FILE = ".dream-police.paused";
export const DEFAULT_POLL_INTERVAL_MS = 2000;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_ROUNDS = 2;
export const DEFAULT_MIN_APPLIED = 1;
export const DEFAULT_PRIOR_CONTEXT_LINES = 40;
export const DEFAULT_SNAPSHOT_KEEP = 20;
export const DEFAULT_CIRCUIT_THRESHOLD = 5;
export const DEFAULT_SENSITIVE_TAGS = ["secret", "private", "pii"] as const;
export const DEFAULT_ON_SENSITIVE = "redact" as const;
export const DEFAULT_QUORUM_POLICY = "conservative" as const;

const ProviderSource = z.strictObject({
  baseUrl: z.string().url().optional(),
  apiKeyEnv: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(1000).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

const DreamPoliceConfigSource = z.strictObject({
  enabled: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  verifier: z
    .strictObject({
      provider: ProviderSource.optional(),
      corrector: ProviderSource.nullable().optional(),
      priorContextLines: z.number().int().min(0).max(500).optional(),
      systemPromptOverride: z.string().min(1).max(10_000).optional(),
      quorum: z
        .strictObject({
          providers: z.array(ProviderSource).optional(),
          policy: z.enum(["conservative", "majority", "unanimous"]).optional(),
        })
        .optional(),
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
  history: z
    .strictObject({
      enabled: z.boolean().optional(),
      file: z.string().min(1).optional(),
      logAccepted: z.boolean().optional(),
    })
    .optional(),
  snapshots: z
    .strictObject({
      enabled: z.boolean().optional(),
      dir: z.string().min(1).optional(),
      keep: z.number().int().min(1).max(1000).optional(),
    })
    .optional(),
  circuitBreaker: z
    .strictObject({
      enabled: z.boolean().optional(),
      threshold: z.number().int().min(1).max(100).optional(),
    })
    .optional(),
  events: z
    .strictObject({
      enabled: z.boolean().optional(),
      file: z.string().min(1).optional(),
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

export type QuorumPolicy = "conservative" | "majority" | "unanimous";

export type ResolvedDreamPoliceConfig = {
  enabled: boolean;
  dryRun: boolean;
  verifier: {
    provider: DreamPoliceProviderConfig | null;
    corrector: DreamPoliceProviderConfig | null;
    priorContextLines: number;
    systemPromptOverride: string | null;
    quorum: {
      providers: DreamPoliceProviderConfig[];
      policy: QuorumPolicy;
    };
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
  history: {
    enabled: boolean;
    file: string;
    logAccepted: boolean;
  };
  snapshots: {
    enabled: boolean;
    dir: string;
    keep: number;
  };
  circuitBreaker: {
    enabled: boolean;
    threshold: number;
  };
  events: {
    enabled: boolean;
    file: string;
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

  const quorumProviders: DreamPoliceProviderConfig[] = [];
  for (const entry of cfg.verifier?.quorum?.providers ?? []) {
    const resolved = resolveProvider(entry);
    if (resolved) quorumProviders.push(resolved);
  }

  return {
    enabled: cfg.enabled ?? false,
    dryRun: cfg.dryRun ?? false,
    verifier: {
      provider,
      corrector,
      priorContextLines: cfg.verifier?.priorContextLines ?? DEFAULT_PRIOR_CONTEXT_LINES,
      systemPromptOverride: cfg.verifier?.systemPromptOverride ?? null,
      quorum: {
        providers: quorumProviders,
        policy: cfg.verifier?.quorum?.policy ?? DEFAULT_QUORUM_POLICY,
      },
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
    history: {
      enabled: cfg.history?.enabled ?? false,
      file: cfg.history?.file ?? DEFAULT_HISTORY_FILE,
      logAccepted: cfg.history?.logAccepted ?? true,
    },
    snapshots: {
      enabled: cfg.snapshots?.enabled ?? true,
      dir: cfg.snapshots?.dir ?? DEFAULT_SNAPSHOT_DIR_RELATIVE,
      keep: cfg.snapshots?.keep ?? DEFAULT_SNAPSHOT_KEEP,
    },
    circuitBreaker: {
      enabled: cfg.circuitBreaker?.enabled ?? true,
      threshold: cfg.circuitBreaker?.threshold ?? DEFAULT_CIRCUIT_THRESHOLD,
    },
    events: {
      enabled: cfg.events?.enabled ?? false,
      file: cfg.events?.file ?? DEFAULT_EVENT_LOG_RELATIVE,
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
