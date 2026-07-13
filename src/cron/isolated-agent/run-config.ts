import type { resolveAgentConfig } from "../../agents/agent-scope.js";
import type { AgentDefaultsConfig } from "../../config/types.js";

type ResolvedAgentConfig = NonNullable<ReturnType<typeof resolveAgentConfig>>;

function extractCronAgentDefaultsOverride(agentConfigOverride?: ResolvedAgentConfig) {
  const {
    model: overrideModel,
    sandbox: _agentSandboxOverride,
    memorySearch: _agentMemorySearchOverride,
    ...agentOverrideRest
  } = agentConfigOverride ?? {};
  return {
    overrideModel,
    definedOverrides: Object.fromEntries(
      Object.entries(agentOverrideRest).filter(([, value]) => value !== undefined),
    ) as Partial<AgentDefaultsConfig>,
  };
}

function mergeCronAgentModelOverride(params: {
  defaults: AgentDefaultsConfig;
  overrideModel: ResolvedAgentConfig["model"] | undefined;
}) {
  const nextDefaults: AgentDefaultsConfig = { ...params.defaults };
  const existingModel =
    nextDefaults.model && typeof nextDefaults.model === "object" ? nextDefaults.model : {};
  if (typeof params.overrideModel === "string") {
    nextDefaults.model = { ...existingModel, primary: params.overrideModel };
  } else if (params.overrideModel) {
    nextDefaults.model = { ...existingModel, ...params.overrideModel };
  }
  return nextDefaults;
}

export function buildCronAgentDefaultsConfig(params: {
  defaults?: AgentDefaultsConfig;
  agentConfigOverride?: ResolvedAgentConfig;
}) {
  const { overrideModel, definedOverrides } = extractCronAgentDefaultsOverride(
    params.agentConfigOverride,
  );
  // Keep nested configs owned by agent-aware resolvers out of this flattened snapshot.
  // Copying a partial sandbox or memorySearch object into defaults destroys its global
  // fields before the resolver can merge the selected agent's override.
  return mergeCronAgentModelOverride({
    defaults: Object.assign({}, params.defaults, definedOverrides),
    overrideModel,
  });
}
