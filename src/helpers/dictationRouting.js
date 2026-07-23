// Whether the dictation agent can actually run. Mirrors ReasoningService.processText,
// which accepts an empty model only for the cloud ("ektoswhispr") and self-hosted ("lan")
// providers; every other mode (BYOK, local, enterprise) requires an explicit model.
export function resolveDictationAgentReachability({
  useDictationAgent,
  dictationAgentModel,
  isCloudAgent,
  isSelfHostedAgent,
}) {
  if (!useDictationAgent) return false;
  if (isCloudAgent || isSelfHostedAgent) return true;
  return (dictationAgentModel?.trim()?.length ?? 0) > 0;
}

// Decides which reasoning path ("agent" | "cleanup" | "skip") a finished
// dictation takes. A recording started via the voice agent hotkey always takes
// the agent path — no wake word needed — and never falls back to cleanup.
export function resolveDictationRouteKind({
  cleanupReachable,
  agentReachable,
  agentInvoked,
  voiceAgentRequested,
}) {
  if (voiceAgentRequested) {
    return agentReachable ? "agent" : "skip";
  }
  if (agentReachable && agentInvoked) {
    return "agent";
  }
  if (cleanupReachable) {
    return "cleanup";
  }
  return "skip";
}

// Requirement 1a's synchronous gate (see
// docs/specs/active-window-screen-context.md's "Threading OCR text into the
// LLM context" Design section): screen-context capture only ever fires when
// the dictation would actually route through a pass that consumes it —
// either the cleanup LLM is enabled/configured, or the dictation-agent route
// will apply. Deliberately takes only synchronous inputs (no async calls),
// since this decision gates whether `warmupScreenContext()` spawns anything
// at all, and must not itself add latency to hotkey-down.
export function shouldCaptureScreenContext({
  cleanupReachable,
  agentReachable,
  agentInvoked,
  voiceAgentRequested,
}) {
  const routeKind = resolveDictationRouteKind({
    cleanupReachable,
    agentReachable,
    agentInvoked,
    voiceAgentRequested,
  });
  return routeKind === "cleanup" || routeKind === "agent";
}
