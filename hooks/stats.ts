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

// Tokens by kind: input, output, cache read, cache write.
export type Kinds = { i: number; o: number; r: number; w: number }
export type KindsDay = { date: string; byModel: Record<string, Kinds> }

export const kindsSum = (k: Kinds) => k.i + k.o + k.r + k.w

// Each model's tokens by kind over a range, from the days that have them.
export function kindsInRange(days: KindsDay[], from: string | undefined): { byModel: Record<string, Kinds>; total: Kinds } {
  const byModel: Record<string, Kinds> = {}
  const total: Kinds = { i: 0, o: 0, r: 0, w: 0 }
  for (const d of days) {
    if (from !== undefined && d.date < from) continue
    for (const [model, k] of Object.entries(d.byModel)) {
      const into = (byModel[model] ??= { i: 0, o: 0, r: 0, w: 0 })
      for (const p of ['i', 'o', 'r', 'w'] as const) {
        into[p] += k[p]
        total[p] += k[p]
      }
    }
  }
  return { byModel, total }
}

// "350 in · 81.1K out · 22.3M cache read · 379K cache write"
export function kindsLine(k: Kinds): string {
  return `${formatCount(k.i)} in · ${formatCount(k.o)} out · ${formatCount(k.r)} cache read · ${formatCount(k.w)} cache write`
}

export const RANGE_TITLE: Record<Range, string> = { all: 'All time', '30d': 'Last 30 days', '7d': 'Last 7 days' }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// 2026-11-03 -> Nov 3
export function shortDate(key: string): string {
  const [, m, d] = key.split('-')
  return `${MONTHS[Number(m) - 1] ?? ''} ${Number(d)}`
}

export type Bar = { label: string; tokens: number }

// Tokens per day over the range, as at most maxBars bars. Long ranges put several
// days in each bar, counted back from today so the last bar ends today.
export function dailyBars(s: StatsCache, range: Range, today: Date, maxBars: number): Bar[] {
  const perDay: Record<string, number> = {}
  for (const d of s.dailyModelTokens ?? []) {
    perDay[d.date] = (perDay[d.date] ?? 0) + Object.values(d.tokensByModel).reduce((n, v) => n + v, 0)
  }
  const todayKey = dayKey(today)
  const first = Object.keys(perDay).filter(d => (perDay[d] ?? 0) > 0).sort()[0]
  const from = rangeStart(range, today) ?? (first !== undefined && first < todayKey ? first : todayKey)
  const days: string[] = []
  for (let d = new Date(`${from}T00:00:00`); dayKey(d) <= todayKey; d = addDays(d, 1)) days.push(dayKey(d))
  const size = Math.max(1, Math.ceil(days.length / Math.max(1, maxBars)))
  const bars: Bar[] = []
  for (let end = days.length; end > 0; end -= size) {
    const group = days.slice(Math.max(0, end - size), end)
    bars.unshift({ label: shortDate(group[0] ?? todayKey), tokens: group.reduce((n, d) => n + (perDay[d] ?? 0), 0) })
  }
  return bars
}

// The top of the chart's scale: five steps of 1, 2, 2.5 or 5 times a power of ten.
export function chartTop(max: number): number {
  if (max <= 0) return 5
  const raw = max / 5
  const power = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map(f => f * power).find(v => v >= raw) ?? 10 * power
  return step * 5
}

// The bar chart as an SVG for the desktop surface.
export function barsSvg(bars: Bar[]): string {
  const width = 600
  const height = 200
  const left = 44
  const top = 8
  const bottom = 24
  const plotW = width - left - 4
  const plotH = height - top - bottom
  const scale = chartTop(Math.max(0, ...bars.map(b => b.tokens)))
  const parts: string[] = []
  const font = 'font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="11"'
  for (let j = 0; j <= 5; j++) {
    const y = (top + plotH - (j / 5) * plotH).toFixed(1)
    parts.push(`<line x1="${left}" y1="${y}" x2="${width}" y2="${y}" class="rule" stroke-width="1"/>`)
    parts.push(`<text x="${left - 8}" y="${Number(y) + 4}" ${font} class="label" text-anchor="end">${formatCount((scale / 5) * j)}</text>`)
  }
  const slot = plotW / Math.max(1, bars.length)
  const barW = Math.max(2, slot * 0.7)
  const every = Math.max(1, Math.ceil(bars.length / 6))
  bars.forEach((b, i) => {
    const h = (b.tokens / scale) * plotH
    const x = left + 4 + i * slot + (slot - barW) / 2
    if (h > 0) parts.push(`<rect x="${x.toFixed(1)}" y="${(top + plotH - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="2" fill="#4a86e0"/>`)
    if (i % every === 0 || i === bars.length - 1) {
      parts.push(`<text x="${(x + barW / 2).toFixed(1)}" y="${height - 6}" ${font} class="label" text-anchor="middle">${b.label}</text>`)
    }
  })
  const style = '<style>.label{fill:#9a9aa0}.rule{stroke:#ffffff;stroke-opacity:.08}@media (prefers-color-scheme: light){.label{fill:#6a6a70}.rule{stroke:#000000;stroke-opacity:.1}}</style>'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMinYMin meet">${style}${parts.join('')}</svg>`
}

const VERTICAL = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

// The bar chart for the terminal, top row first, in eighths of a cell.
// A day with any tokens shows at least a sliver.
export function columnRows(bars: Bar[], height: number, barWidth: number): string[] {
  const max = Math.max(0, ...bars.map(b => b.tokens))
  const eighths = bars.map(b => (b.tokens > 0 && max > 0 ? Math.max(1, Math.round((b.tokens / max) * height * 8)) : 0))
  const rows: string[] = []
  for (let r = height - 1; r >= 0; r--) {
    rows.push(eighths.map(n => (VERTICAL[Math.max(0, Math.min(8, n - r * 8))] ?? ' ').repeat(barWidth)).join(' '))
  }
  return rows
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
