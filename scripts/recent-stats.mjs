// Counts the days Claude Code's stats-cache.json has not covered yet, straight
// from the session logs, using the same rules the cache uses:
// messages are user, assistant, attachment and system rows; tokens are every
// assistant row's input + output + cache read + cache write; rows are counted
// once by uuid; a session counts on the day its first row was written.
// It also totals one session (all of its days) when its id is given, and prices
// everything at Claude API list prices (scripts/pricing.mjs): each day of the last
// week, the session, and the lifetime total.
// Limit windows given as name=ISO start (5h=..., 7d=...) are totalled too.
// With sync=<folder>, this computer's summary is written there and the other
// computers' summaries are added in (scripts/sync.mjs).
// Usage: node recent-stats.mjs <claude config dir> [session id] [name=start ...] [sync=folder]
import fs from 'node:fs'
import path from 'node:path'

import { priceUsd } from './pricing.mjs'
import { SLICE_MS, SUMMARY_VERSION, combineOthers, computerName, readOthers, writeSummary } from './sync.mjs'

const dir = process.argv[2]
const sessionId = process.argv[3] ?? ''
// The limit windows to total, by name, from their start times.
const windows = {}
let syncFolder = ''
for (const arg of process.argv.slice(4)) {
  const at = arg.indexOf('=')
  if (arg.slice(0, at) === 'sync') {
    syncFolder = arg.slice(at + 1)
    continue
  }
  const start = Date.parse(arg.slice(at + 1))
  if (at > 0 && !Number.isNaN(start)) windows[arg.slice(0, at)] = { start, messageCount: 0, tokensByModel: {}, usd: 0 }
}
const windowStarts = Object.values(windows).map(w => w.start)
const session = { messageCount: 0, tokensByModel: {} }
const MESSAGE_TYPES = new Set(['user', 'assistant', 'attachment', 'system'])

const localDay = ts => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

let cutoff = ''
let cache = {}
try {
  cache = JSON.parse(fs.readFileSync(path.join(dir, 'stats-cache.json'), 'utf8'))
  cutoff = cache.lastComputedDate ?? ''
} catch {}

// Costs are priced per day for the last 7 days, so those logs are read too.
const now = new Date()
const weekStartDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6)
const weekStart = localDay(weekStartDate)
const cutoffStart = cutoff ? new Date(`${cutoff}T00:00:00`).getTime() : 0
// The last 8 days are also kept in 10-minute slices for the sync summary, so
// another computer can total any limit window from them.
const slicesFrom = Math.floor((now.getTime() - 8 * 86400_000) / SLICE_MS) * SLICE_MS
// Only logs written after the earliest of those can hold rows we need.
const since = Math.min(cutoffStart, weekStartDate.getTime(), slicesFrom, ...windowStarts)

const walk = d => {
  let entries = []
  try {
    entries = fs.readdirSync(d, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.flatMap(e => {
    const p = path.join(d, e.name)
    if (e.isDirectory()) return walk(p)
    if (!e.name.endsWith('.jsonl')) return []
    try {
      return fs.statSync(p).mtimeMs >= since ? [p] : []
    } catch {
      return []
    }
  })
}

const days = {}
const day = d => (days[d] ??= { messageCount: 0, sessionCount: 0, tokensByModel: {} })
const seen = new Set()
const firstSeen = {}
const costByDay = {}
const slices = {}
const slice = at => (slices[Math.floor(at / SLICE_MS) * SLICE_MS] ??= { m: 0, usd: 0, t: {} })
let recentUsd = 0
let sessionUsd = 0
let write5m = 0
let write1h = 0
const unpriced = new Set()

for (const file of walk(path.join(dir, 'projects'))) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    continue
  }
  for (const line of text.split('\n')) {
    if (!line) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (!row.timestamp) continue
    if (row.sessionId && (!firstSeen[row.sessionId] || row.timestamp < firstSeen[row.sessionId])) {
      firstSeen[row.sessionId] = row.timestamp
    }
    if (!MESSAGE_TYPES.has(row.type)) continue
    const key = row.uuid ?? line
    if (seen.has(key)) continue
    seen.add(key)
    const u = row.type === 'assistant' ? row.message?.usage : undefined
    const model = row.message?.model
    const tokens = u && model && model !== '<synthetic>'
      ? (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
      : 0
    const d = localDay(row.timestamp)
    const isSession = sessionId !== '' && row.sessionId === sessionId
    const at = Date.parse(row.timestamp)
    const inWindows = Object.values(windows).filter(w => at >= w.start)
    for (const w of inWindows) {
      w.messageCount++
      if (tokens) w.tokensByModel[model] = (w.tokensByModel[model] || 0) + tokens
    }
    const sl = at >= slicesFrom ? slice(at) : undefined
    if (sl) {
      sl.m++
      if (tokens) sl.t[model] = (sl.t[model] || 0) + tokens
    }
    if (isSession) {
      session.messageCount++
      if (tokens) session.tokensByModel[model] = (session.tokensByModel[model] || 0) + tokens
    }
    if (tokens) {
      const written = u.cache_creation_input_tokens || 0
      const split = u.cache_creation ?? {}
      const w1 = split.ephemeral_1h_input_tokens ?? 0
      const w5 = split.ephemeral_5m_input_tokens ?? Math.max(0, written - w1)
      write5m += w5
      write1h += w1
      const usd = priceUsd(model, {
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        read: u.cache_read_input_tokens || 0,
        write5m: w5,
        write1h: w1,
        webSearches: u.server_tool_use?.web_search_requests || 0,
      }, { isFast: u.speed === 'fast' })
      if (usd === undefined) unpriced.add(model)
      else {
        if (d >= weekStart) costByDay[d] = (costByDay[d] || 0) + usd
        if (d > cutoff) recentUsd += usd
        if (isSession) sessionUsd += usd
        for (const w of inWindows) w.usd += usd
        if (sl) sl.usd += usd
      }
    }
    if (d <= cutoff) continue
    const r = day(d)
    r.messageCount++
    if (tokens) r.tokensByModel[model] = (r.tokensByModel[model] || 0) + tokens
  }
}

const hourCounts = {}
let sessions = 0
for (const ts of Object.values(firstSeen)) {
  const d = localDay(ts)
  if (d <= cutoff) continue
  day(d).sessionCount++
  sessions++
  const h = String(new Date(ts).getHours())
  hourCounts[h] = (hourCounts[h] || 0) + 1
}

// Lifetime: the cache's per-model totals up to its cutoff, then the days after it.
// The cache does not say how its cache writes split between the 5-minute and
// 1-hour prices, so they are split the way the logs read here split them.
const writes = write5m + write1h
const share1h = writes > 0 ? write1h / writes : 1
let cachedUsd = 0
for (const [model, m] of Object.entries(cache.modelUsage ?? {})) {
  const created = m.cacheCreationInputTokens || 0
  const usd = priceUsd(model, {
    input: m.inputTokens || 0,
    output: m.outputTokens || 0,
    read: m.cacheReadInputTokens || 0,
    write5m: created * (1 - share1h),
    write1h: created * share1h,
    webSearches: m.webSearchRequests || 0,
  })
  if (usd === undefined) unpriced.add(model)
  else cachedUsd += usd
}

const sorted = Object.keys(days).sort()
const lifetimeUsd = cachedUsd + recentUsd
const recentMessages = sorted.reduce((n, d) => n + days[d].messageCount, 0)

// Sync: write this computer's whole history as one summary, then add the others.
const sync = { folder: syncFolder || null, computer: computerName(), computers: [], error: null }
let others = null
if (syncFolder) {
  try {
    const allDays = {}
    for (const d of cache.dailyActivity ?? []) {
      if (d.date > cutoff) continue
      allDays[d.date] = { messageCount: d.messageCount || 0, sessionCount: d.sessionCount || 0, tokensByModel: {} }
    }
    for (const d of cache.dailyModelTokens ?? []) {
      if (d.date > cutoff) continue
      ;(allDays[d.date] ??= { messageCount: 0, sessionCount: 0, tokensByModel: {} }).tokensByModel = { ...d.tokensByModel }
    }
    for (const d of sorted) allDays[d] = { ...days[d], tokensByModel: { ...days[d].tokensByModel } }
    for (const [d, usd] of Object.entries(costByDay)) if (allDays[d]) allDays[d].usd = usd
    const cachedHours = { ...(cache.hourCounts ?? {}) }
    for (const [h, n] of Object.entries(hourCounts)) cachedHours[h] = (cachedHours[h] || 0) + n
    writeSummary(syncFolder, {
      version: SUMMARY_VERSION,
      computer: sync.computer,
      updatedAt: new Date().toISOString(),
      firstSessionDate: cache.firstSessionDate ?? null,
      totalSessions: (cache.totalSessions ?? 0) + sessions,
      totalMessages: (cache.totalMessages ?? 0) + recentMessages,
      hourCounts: cachedHours,
      lifetimeUsd,
      days: allDays,
      slices,
    })
    const found = readOthers(syncFolder, sync.computer)
    if (found.length > 0) others = combineOthers(found, { weekStart, windows })
    sync.computers = [{ name: sync.computer, updatedAt: new Date().toISOString() }, ...(others?.computers ?? [])]
  } catch (err) {
    sync.error = String(err?.message ?? err).slice(0, 160)
  }
}

// Windows, costs and lifetime count every synced computer; "session" stays this chat.
if (others) {
  for (const [name, t] of Object.entries(others.windowTotals)) {
    const w = windows[name]
    w.messageCount += t.messageCount
    w.usd += t.usd
    for (const [m, n] of Object.entries(t.tokensByModel)) w.tokensByModel[m] = (w.tokensByModel[m] || 0) + n
  }
  for (const [d, usd] of Object.entries(others.costByDay)) costByDay[d] = (costByDay[d] || 0) + usd
}
const firstSession = [cache.firstSessionDate, others?.firstSessionDate].filter(Boolean).sort()[0] ?? null

process.stdout.write(
  JSON.stringify({
    cutoff,
    sessions,
    dailyActivity: sorted.map(d => ({ date: d, messageCount: days[d].messageCount, sessionCount: days[d].sessionCount })),
    dailyModelTokens: sorted.map(d => ({ date: d, tokensByModel: days[d].tokensByModel })),
    hourCounts,
    session,
    windows: Object.fromEntries(
      Object.entries(windows).map(([name, w]) => [name, { ...w, start: new Date(w.start).toISOString() }]),
    ),
    cost: {
      byDay: costByDay,
      sessionUsd,
      lifetimeUsd: lifetimeUsd + (others?.lifetimeUsd ?? 0),
      since: firstSession,
      unpriced: [...unpriced].filter(m => m !== '<synthetic>'),
    },
    others: others && {
      computers: others.computers,
      dailyActivity: others.dailyActivity,
      dailyModelTokens: others.dailyModelTokens,
      totalSessions: others.totalSessions,
      totalMessages: others.totalMessages,
      hourCounts: others.hourCounts,
    },
    sync,
  }),
)
