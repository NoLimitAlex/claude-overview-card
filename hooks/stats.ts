// Pure helpers that turn ~/.claude/stats-cache.json into the card's numbers.

export type Range = 'all' | '30d' | '7d'

export type StatsCache = {
  dailyActivity?: { date: string; messageCount: number; sessionCount: number }[]
  dailyModelTokens?: { date: string; tokensByModel: Record<string, number> }[]
  totalSessions?: number
  totalMessages?: number
  hourCounts?: Record<string, number>
  lastComputedDate?: string
}

// The part of scripts/recent-stats.mjs's output the card merges in.
export type Recent = {
  cutoff: string
  sessions: number
  dailyActivity: { date: string; messageCount: number; sessionCount: number }[]
  dailyModelTokens: { date: string; tokensByModel: Record<string, number> }[]
  hourCounts: Record<string, number>
}

// Adds the days counted from the logs to what the cache already holds.
// Days after the cache's last computed date come from the logs alone.
export function mergeRecent(cache: StatsCache, recent: Recent | null | undefined): StatsCache {
  if (!recent || recent.cutoff !== (cache.lastComputedDate ?? '')) return cache
  const keep = <T extends { date: string }>(rows: T[] | undefined) => (rows ?? []).filter(r => r.date <= recent.cutoff)
  const hours: Record<string, number> = { ...(cache.hourCounts ?? {}) }
  for (const [h, n] of Object.entries(recent.hourCounts)) hours[h] = (hours[h] ?? 0) + n
  const added = recent.dailyActivity.reduce((sum, d) => sum + d.messageCount, 0)
  return {
    ...cache,
    dailyActivity: [...keep(cache.dailyActivity), ...recent.dailyActivity],
    dailyModelTokens: [...keep(cache.dailyModelTokens), ...recent.dailyModelTokens],
    totalSessions: cache.totalSessions === undefined ? undefined : cache.totalSessions + recent.sessions,
    totalMessages: cache.totalMessages === undefined ? undefined : cache.totalMessages + added,
    hourCounts: hours,
  }
}

// The other computers' usage, added up (scripts/sync.mjs).
export type Others = {
  dailyActivity: { date: string; messageCount: number; sessionCount: number }[]
  dailyModelTokens: { date: string; tokensByModel: Record<string, number> }[]
  totalSessions: number
  totalMessages: number
  hourCounts: Record<string, number>
}

// Adds the other computers' days and totals to this computer's, day by day.
export function mergeOthers(s: StatsCache, others: Others | null | undefined): StatsCache {
  if (!others) return s
  const activity = new Map<string, { date: string; messageCount: number; sessionCount: number }>()
  for (const d of [...(s.dailyActivity ?? []), ...others.dailyActivity]) {
    const held = activity.get(d.date) ?? { date: d.date, messageCount: 0, sessionCount: 0 }
    activity.set(d.date, { date: d.date, messageCount: held.messageCount + d.messageCount, sessionCount: held.sessionCount + d.sessionCount })
  }
  const tokens = new Map<string, Record<string, number>>()
  for (const d of [...(s.dailyModelTokens ?? []), ...others.dailyModelTokens]) {
    const held = { ...(tokens.get(d.date) ?? {}) }
    for (const [m, n] of Object.entries(d.tokensByModel)) held[m] = (held[m] ?? 0) + n
    tokens.set(d.date, held)
  }
  const hours: Record<string, number> = { ...(s.hourCounts ?? {}) }
  for (const [h, n] of Object.entries(others.hourCounts)) hours[h] = (hours[h] ?? 0) + n
  const byDate = <T extends { date: string }>(a: T, b: T) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
  return {
    ...s,
    dailyActivity: [...activity.values()].sort(byDate),
    dailyModelTokens: [...tokens.entries()].map(([date, tokensByModel]) => ({ date, tokensByModel })).sort(byDate),
    totalSessions: (s.totalSessions ?? 0) + others.totalSessions,
    totalMessages: (s.totalMessages ?? 0) + others.totalMessages,
    hourCounts: hours,
  }
}

export type Summary = {
  sessions: number
  messages: number
  tokens: number
  activeDays: number
  peakHour: string | undefined
  favoriteModel: string | undefined
  byModel: { model: string; tokens: number }[]
  perDay: Record<string, number>
}

// Roughly how many tokens the novel Dune comes to, as the old card compared.
export const DUNE_TOKENS = 232_000

export function dayKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export function addDays(d: Date, n: number): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  out.setDate(out.getDate() + n)
  return out
}

export function rangeStart(range: Range, today: Date): string | undefined {
  if (range === 'all') return undefined
  return dayKey(addDays(today, range === '30d' ? -29 : -6))
}

export function summarize(s: StatsCache, range: Range, today: Date): Summary {
  const from = rangeStart(range, today)
  const inRange = (date: string) => from === undefined || date >= from
  const days = (s.dailyActivity ?? []).filter(d => inRange(d.date))
  const perDay: Record<string, number> = {}
  let sessions = 0
  let messages = 0
  for (const d of days) {
    perDay[d.date] = (perDay[d.date] ?? 0) + d.messageCount
    sessions += d.sessionCount
    messages += d.messageCount
  }
  if (range === 'all') {
    sessions = s.totalSessions ?? sessions
    messages = s.totalMessages ?? messages
  }
  const models: Record<string, number> = {}
  let tokens = 0
  for (const d of s.dailyModelTokens ?? []) {
    if (!inRange(d.date)) continue
    for (const [model, n] of Object.entries(d.tokensByModel)) {
      models[model] = (models[model] ?? 0) + n
      tokens += n
    }
  }
  const byModel = Object.entries(models)
    .map(([model, n]) => ({ model, tokens: n }))
    .sort((a, b) => b.tokens - a.tokens)
  let peak: string | undefined
  let peakCount = 0
  for (const [hour, n] of Object.entries(s.hourCounts ?? {})) {
    if (n > peakCount) {
      peak = hour
      peakCount = n
    }
  }
  return {
    sessions,
    messages,
    tokens,
    activeDays: days.filter(d => d.messageCount > 0).length,
    peakHour: peak === undefined ? undefined : formatHour(Number(peak)),
    favoriteModel: byModel[0] ? modelName(byModel[0].model) : undefined,
    byModel,
    perDay,
  }
}

export function formatHour(h: number): string {
  const suffix = h < 12 ? 'AM' : 'PM'
  const twelve = h % 12 === 0 ? 12 : h % 12
  return `${twelve} ${suffix}`
}

// claude-opus-5 -> Opus 5, claude-fable-5-1 -> Fable 5.1
export function modelName(id: string): string {
  const parts = id.replace(/^claude-/, '').replace(/-\d{8}$/, '').split('-')
  const family = parts[0] ?? id
  const version = parts.slice(1).join('.')
  const name = family.charAt(0).toUpperCase() + family.slice(1)
  return version ? `${name} ${version}` : name
}

export function formatCount(n: number): string {
  const units: [number, string][] = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ]
  for (const [size, unit] of units) {
    if (n >= size) {
      const v = n / size
      return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10}${unit}`
    }
  }
  return String(n)
}

export function withCommas(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function duneLine(tokens: number): string {
  if (tokens < DUNE_TOKENS) return "You haven't out-read Dune yet. Keep going."
  const times = tokens / DUNE_TOKENS
  const shown = times >= 100 ? withCommas(Math.round(times / 100) * 100) : String(Math.round(times))
  return `You've used ~${shown}x more tokens than Dune.`
}

// Heatmap colors: empty, then four levels of blue, brightest for the busiest days.
export const LEVEL_COLORS = [0x3a3a3f, 0x1b4f7f, 0x1f78c8, 0x4aa8f0, 0xc4e6ff]
const DEFAULT = 0x01000000
const SQUARE = 0x25a0 // ■
const SPACE = 0x20

export function level(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0
  const r = count / max
  if (r > 0.75) return 4
  if (r > 0.5) return 3
  if (r > 0.25) return 2
  return 1
}

export type Grid = { weeks: number; start: Date; levels: number[][] }

// A GitHub-style grid: one column per week, Sunday at the top, today in the last column.
export function grid(perDay: Record<string, number>, today: Date, weeks: number): Grid {
  const lastSunday = addDays(today, -today.getDay())
  const start = addDays(lastSunday, -(weeks - 1) * 7)
  const max = Math.max(0, ...Object.values(perDay))
  const todayKey = dayKey(today)
  const levels: number[][] = []
  for (let r = 0; r < 7; r++) {
    const row: number[] = []
    for (let w = 0; w < weeks; w++) {
      const key = dayKey(addDays(start, w * 7 + r))
      row.push(key > todayKey ? -1 : level(perDay[key] ?? 0, max))
    }
    levels.push(row)
  }
  return { weeks, start, levels }
}

// Packs the grid for the terminal's Raster: each day is a square plus a gap column.
export function rasterCells(g: Grid): { cells: string; columns: number; rows: number } {
  const columns = g.weeks * 2
  const words = new Uint32Array(columns * 7 * 3)
  let i = 0
  for (let r = 0; r < 7; r++) {
    for (let w = 0; w < g.weeks; w++) {
      const lv = g.levels[r]?.[w] ?? -1
      words.set(lv < 0 ? [SPACE, DEFAULT, DEFAULT] : [SQUARE, LEVEL_COLORS[lv] ?? DEFAULT, DEFAULT], i)
      i += 3
      words.set([SPACE, DEFAULT, DEFAULT], i)
      i += 3
    }
  }
  return { cells: toBase64(new Uint8Array(words.buffer)), columns, rows: 7 }
}

// The same grid as an SVG for the desktop surface.
export function svgSource(g: Grid): string {
  const size = 11
  const gap = 3
  const step = size + gap
  const rects: string[] = []
  for (let r = 0; r < 7; r++) {
    for (let w = 0; w < g.weeks; w++) {
      const lv = g.levels[r]?.[w] ?? -1
      if (lv < 0) continue
      const color = '#' + (LEVEL_COLORS[lv] ?? 0).toString(16).padStart(6, '0')
      const paint = lv === 0 ? 'class="empty"' : `fill="${color}"`
      rects.push(`<rect x="${w * step}" y="${r * step}" width="${size}" height="${size}" rx="2" ${paint}/>`)
    }
  }
  const width = g.weeks * step - gap
  const height = 7 * step - gap
  const style = '<style>.empty{fill:#ffffff;fill-opacity:.08}@media (prefers-color-scheme: light){.empty{fill:#000000;fill-opacity:.07}}</style>'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${style}${rects.join('')}</svg>`
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// Standard padded base64, written out so it works whether or not toBase64 exists.
export function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const n = (a << 16) | (b << 8) | c
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63)
    out += i + 1 < bytes.length ? B64.charAt((n >> 6) & 63) : '='
    out += i + 2 < bytes.length ? B64.charAt(n & 63) : '='
  }
  return out
}

export type DayTotals = { messages: number; sessions: number; tokens: number; byModel: { model: string; tokens: number }[] }

// One day's numbers from the merged stats.
export function dayTotals(s: StatsCache, date: string): DayTotals {
  const act = (s.dailyActivity ?? []).find(d => d.date === date)
  const tok = (s.dailyModelTokens ?? []).find(d => d.date === date)
  return { messages: act?.messageCount ?? 0, sessions: act?.sessionCount ?? 0, ...modelTotals(tok?.tokensByModel ?? {}) }
}

export function modelTotals(byModel: Record<string, number>): { tokens: number; byModel: { model: string; tokens: number }[] } {
  const rows = Object.entries(byModel)
    .map(([model, tokens]) => ({ model, tokens }))
    .filter(r => r.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
  return { tokens: rows.reduce((n, r) => n + r.tokens, 0), byModel: rows }
}

// five_hour -> 5-hour limit, seven_day -> Weekly · all models, seven_day_fable -> Weekly · Fable
export function limitLabel(kind: string): string {
  if (kind === 'five_hour') return '5-hour limit'
  if (kind === 'seven_day') return 'Weekly · all models'
  if (kind === 'spend_limit') return 'Spend limit'
  const weekly = /^seven_day_(.+)$/.exec(kind)
  if (weekly?.[1]) return `Weekly · ${modelName(weekly[1].replace(/_/g, '-'))}`
  const words = kind.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

// Five-hour first, then the weekly windows, then anything else.
export function limitOrder(kind: string): number {
  if (kind === 'five_hour') return 0
  if (kind === 'seven_day') return 1
  if (kind.startsWith('seven_day')) return 2
  return 3
}

export function meterBar(percent: number, width: number): { filled: string; empty: string } {
  const p = Math.max(0, Math.min(100, percent))
  const n = Math.round((p / 100) * width)
  return { filled: '█'.repeat(n), empty: '░'.repeat(Math.max(0, width - n)) }
}

export function meterColor(percent: number): string {
  if (percent >= 90) return '#e06c75'
  if (percent >= 70) return '#e5c07b'
  return '#4aa8f0'
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function clockTime(d: Date): string {
  const h = d.getHours()
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? 'AM' : 'PM'}`
}

// "resets 9:40 PM" today, "resets Sat 7:00 PM" later in the week.
export function resetLabel(iso: string | undefined, now: Date): string {
  if (!iso) return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const sameDay = dayKey(at) === dayKey(now)
  return `resets ${sameDay ? '' : `${WEEKDAYS[at.getDay()]} `}${clockTime(at)}`
}
