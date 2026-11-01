export type OverviewRange = 'all' | '30d' | '7d'
export type OverviewTab = 'overview' | 'models'

// What scripts/recent-stats.mjs counts for the days stats-cache.json has not covered yet.
export type OverviewRecent = {
  cutoff: string
  sessions: number
  dailyActivity: { date: string; messageCount: number; sessionCount: number }[]
  dailyModelTokens: { date: string; tokensByModel: Record<string, number> }[]
  hourCounts: Record<string, number>
  session?: { messageCount: number; tokensByModel: Record<string, number> }
  // Totals since each limit window began, by name (5h, 7d).
  windows?: Record<string, { start: string; messageCount: number; tokensByModel: Record<string, number>; usd: number }>
  // What the usage would cost at Claude API list prices (scripts/pricing.mjs).
  cost?: {
    byDay: Record<string, number>
    sessionUsd: number
    lifetimeUsd: number
    since: string | null
    unpriced: string[]
  }
  checkedAt: number
}

// Why the last count of the logs failed, if it did.
export type OverviewCountError = { reason: string; at: number }

// The plan limits and context window as Claude Code last measured them.
export type OverviewLimits = {
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  contextTokens?: number
  contextWindow: number
  contextPercent?: number
  costUsd?: number
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'overview-card': { range: OverviewRange; tab: OverviewTab; recent: Shaped<OverviewRecent | null>; limits: OverviewLimits | null; countError: OverviewCountError | null }
  }
}
