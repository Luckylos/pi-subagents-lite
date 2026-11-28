import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { getSessionContextPercent } from "../agents/usage.ts";
import type { AgentRecord } from "../types.ts";

const CONTEXT_SAMPLE_MAX_AGE_MS = 500;

interface ContextSample {
  key: readonly unknown[];
  sampledAt: number;
  percent: number | null;
}

/** Reuse a recent usage estimate until the session branch or model changes. */
export class ContextSampler {
  private samples = new WeakMap<AgentRecord, ContextSample>();

  delete(agent: AgentRecord): void {
    this.samples.delete(agent);
  }

  read(agent: AgentRecord, session: AgentSession | undefined = agent.execution.session): number | null {
    if (!session) return agent.stats.contextPercent ?? null;

    try {
      const manager = session.sessionManager;
      // Legacy/custom sessions without a cheap branch stamp remain uncached.
      if (!manager?.getLeafId || !manager.getLeafEntry || !manager.getSessionId) {
        return getSessionContextPercent(session);
      }
      const selectedModel = session.model;
      const limitsModel = session.routedModel?.model ?? selectedModel;
      const key = [
        session,
        // oxlint-disable-next-line typescript/unbound-method -- Compare identity without calling it.
        session.getContextUsage,
        // oxlint-disable-next-line typescript/unbound-method -- Compare identity without calling it.
        session.getSessionStats,
        manager,
        manager.getSessionId(),
        manager.getLeafId(),
        manager.getLeafEntry(),
        selectedModel,
        selectedModel?.contextWindow,
        limitsModel,
        limitsModel?.contextWindow,
        agent.stats.compactionCount,
      ];
      const now = Date.now();
      const previous = this.samples.get(agent);
      if (
        previous &&
        now >= previous.sampledAt &&
        now - previous.sampledAt < CONTEXT_SAMPLE_MAX_AGE_MS &&
        key.length === previous.key.length &&
        key.every((value, i) => Object.is(value, previous.key[i]))
      ) {
        return previous.percent;
      }
      const percent = getSessionContextPercent(session);
      // Leaf/model changes refresh immediately. The age limit also refreshes
      // unversioned in-place changes; this is bounded sampling, not a promise
      // that the SDK's mutable records have a complete revision key.
      this.samples.set(agent, { key, sampledAt: now, percent });
      return percent;
    } catch {
      this.samples.delete(agent);
      return getSessionContextPercent(session);
    }
  }
}
