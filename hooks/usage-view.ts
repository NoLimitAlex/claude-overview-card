// The usage section of the card: limit meters, each followed by the numbers that
// belong to it. Built once as plain data, then drawn as an SVG on the desktop
// and as text on the terminal.

import { formatCount, limitLabel, limitOrder, modelName, resetLabel, withCommas } from './stats'

export type Lifetime = { usd: number; since: string | null; computers?: number }

export type Cell = { label: string; value: string }
export type Meter = { key: string; label: string; percent: number | undefined; note: string }
export type Block = { meters: Meter[]; title: string; note?: string; cells: Cell[] }

type Totals = { messages: number; tokens: number; byModel: { model: string; tokens: number }[]; costUsd?: number }

export type UsageInput = {
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  context?: { percent?: number; tokens?: number; window: number }
  today: Totals
  week: Totals
  // Totals since the 5-hour and weekly windows began, once the limits are known.
  fiveHour?: Totals & { start: string }
  weekly?: Totals & { start: string }
  session?: Totals
  // Why the logs could not be counted, shown in place of the session's numbers.
  countError?: string
  now: Date
}

// $0.42, $136.66, $2,579.73
export function money(usd: number): string {
  const [whole = '0', cents = '00'] = usd.toFixed(2).split('.')
  return `$${withCommas(Number(whole))}.${cents}`
}

const cellsFor = (t: Totals): Cell[] => [
  { label: 'Messages', value: withCommas(t.messages) },
  { label: 'Tokens', value: formatCount(t.tokens) },
  ...(t.costUsd === undefined ? [] : [{ label: 'API value', value: money(t.costUsd) }]),
  ...t.byModel.slice(0, 3).map(m => ({ label: modelName(m.model), value: formatCount(m.tokens) })),
]

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function lifetimeNote(since: string | null, computers = 1): string {
  const d = since ? new Date(since) : undefined
  const from = d && !Number.isNaN(d.getTime()) ? `Since ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} · ` : ''
  const across = computers > 1 ? ` · ${computers} computers` : ''
  return `${from}what your usage would cost at Claude API prices${across}`
}

// 5-hour limit with today's numbers, the weekly limits with the last 7 days,
// the context window with this session.
export function usageBlocks(u: UsageInput): Block[] {
  const windows = [...u.rateLimits].sort((a, b) => limitOrder(a.kind) - limitOrder(b.kind))
  const toMeter = (w: { kind: string; percentUsed: number; resetsAt?: string }): Meter => ({
    key: w.kind,
    label: limitLabel(w.kind),
    percent: w.percentUsed,
    note: resetLabel(w.resetsAt, u.now),
  })
  const five = windows.filter(w => w.kind === 'five_hour').map(toMeter)
  const weekly = windows.filter(w => w.kind.startsWith('seven_day')).map(toMeter)
  const other = windows.filter(w => w.kind !== 'five_hour' && !w.kind.startsWith('seven_day')).map(toMeter)
  const waiting = (key: string, label: string): Meter => ({ key, label, percent: undefined, note: 'after your first message' })

  const context: Meter =
    u.context?.percent === undefined
      ? waiting('context', 'Context window')
      : {
          key: 'context',
          label: 'Context window',
          percent: u.context.percent,
          note: u.context.tokens === undefined ? '' : `${formatCount(u.context.tokens)} of ${formatCount(u.context.window)}`,
        }

  const sessionCells = u.session ? cellsFor(u.session) : [{ label: 'Messages', value: u.countError ? '–' : '…' }]
  const since = (iso: string) => resetLabel(iso, u.now).replace(/^resets /, 'since ')

  return [
    u.fiveHour
      ? { meters: five, title: 'This 5-hour window', note: since(u.fiveHour.start), cells: cellsFor(u.fiveHour) }
      : { meters: five.length ? five : [waiting('five_hour', '5-hour limit')], title: 'Today', cells: cellsFor(u.today) },
    u.weekly
      ? { meters: [...weekly, ...other], title: 'This week\u2019s window', note: since(u.weekly.start), cells: cellsFor(u.weekly) }
      : { meters: [...(weekly.length ? weekly : [waiting('seven_day', 'Weekly · all models')]), ...other], title: 'Last 7 days', cells: cellsFor(u.week) },
    { meters: [context], title: 'This session', note: u.countError ? `couldn't count: ${u.countError}` : 'this chat only', cells: sessionCells.slice(0, 6) },
  ]
}

// Blue while there is room, orange from 70%, red from 90%.
export function meterColors(percent: number): [string, string] {
  if (percent >= 90) return ['#d93a3a', '#ff5a5a']
  if (percent >= 70) return ['#e8730c', '#ff9a3c']
  return ['#1f6fd6', '#4da3ff']
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Colors as classes, so the drawing has no background of its own and sits on
// whatever the panel behind it is: light marks on the dark theme, dark marks on
// the light one. Tracks and lines are translucent, so they take the panel's tone.
const STYLE = `<style>
.title{fill:#f2f2f2}.value{fill:#ffffff}.label{fill:#8e8e93}.section{fill:#6e6e73}
.track{fill:#ffffff;fill-opacity:.08}.rule{stroke:#ffffff;stroke-opacity:.1}
@media (prefers-color-scheme: light){
.title{fill:#1c1c1e}.value{fill:#000000}.label{fill:#6e6e73}.section{fill:#8e8e93}
.track{fill:#000000;fill-opacity:.07}.rule{stroke:#000000;stroke-opacity:.1}}
</style>`

// The desktop drawing: no panel of its own, smooth rounded bars, and each
// block's numbers in cells marked off by thin lines at their sides only.
export function usageSvg(blocks: Block[], lifetime?: Lifetime, updated?: string, width = 760): string {
  const pad = 0
  const inner = width - pad * 2
  const font = `font-family="Segoe UI, -apple-system, system-ui, sans-serif"`
  const parts: string[] = []
  let y = 4

  parts.push(`<defs>`)
  blocks.forEach((b, bi) =>
    b.meters.forEach((m, mi) => {
      const [from, to] = meterColors(m.percent ?? 0)
      parts.push(`<linearGradient id="g${bi}-${mi}" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient>`)
    }),
  )
  parts.push(`</defs>`)

  if (lifetime) {
    parts.push(`<text x="${pad}" y="${y + 10}" ${font} font-size="11" font-weight="600" letter-spacing="0.6" class="section">LIFETIME API VALUE</text>`)
    if (updated) parts.push(`<text x="${width - pad}" y="${y + 10}" ${font} font-size="11" class="section" text-anchor="end">${esc(updated)}</text>`)
    parts.push(`<text x="${pad}" y="${y + 44}" ${font} font-size="30" font-weight="700" class="value">${esc(money(lifetime.usd))}</text>`)
    parts.push(`<text x="${pad}" y="${y + 64}" ${font} font-size="12" class="label">${esc(lifetimeNote(lifetime.since, lifetime.computers))}</text>`)
    y += 72
    parts.push(`<line x1="${pad}" y1="${y + 8}" x2="${width - pad}" y2="${y + 8}" class="rule" stroke-width="1"/>`)
    y += 26
  }

  blocks.forEach((b, bi) => {
    if (bi > 0) y += 26
    b.meters.forEach((m, mi) => {
      if (mi > 0) y += 16
      const right = m.percent === undefined ? m.note : `${Math.round(m.percent)}%${m.note ? ` · ${m.note}` : ''}`
      parts.push(`<text x="${pad}" y="${y + 13}" ${font} font-size="14" font-weight="600" class="title">${esc(m.label)}</text>`)
      parts.push(`<text x="${width - pad}" y="${y + 13}" ${font} font-size="13" class="label" text-anchor="end">${esc(right)}</text>`)
      const barY = y + 24
      parts.push(`<rect x="${pad}" y="${barY}" width="${inner}" height="8" rx="4" class="track"/>`)
      if (m.percent !== undefined && m.percent > 0) {
        const w = Math.max(8, (Math.min(100, m.percent) / 100) * inner)
        parts.push(`<rect x="${pad}" y="${barY}" width="${w.toFixed(1)}" height="8" rx="4" fill="url(#g${bi}-${mi})"/>`)
      }
      y = barY + 8
    })

    y += 18
    parts.push(`<text x="${pad}" y="${y + 10}" ${font} font-size="11" font-weight="600" letter-spacing="0.6" class="section">${esc(b.title.toUpperCase())}</text>`)
    if (b.note) parts.push(`<text x="${width - pad}" y="${y + 10}" ${font} font-size="11" class="section" text-anchor="end">${esc(b.note)}</text>`)
    y += 18
    const cellH = 44
    const n = Math.max(1, b.cells.length)
    const cellW = inner / n
    b.cells.forEach((c, ci) => {
      const x = pad + ci * cellW
      parts.push(`<text x="${(x + 12).toFixed(1)}" y="${y + 16}" ${font} font-size="12" class="label">${esc(c.label)}</text>`)
      parts.push(`<text x="${(x + 12).toFixed(1)}" y="${y + 37}" ${font} font-size="18" font-weight="700" class="value">${esc(c.value)}</text>`)
    })
    for (let i = 0; i <= n; i++) {
      const x = Math.min(width - 0.5, Math.max(0.5, pad + i * cellW)).toFixed(1)
      parts.push(`<line x1="${x}" y1="${y}" x2="${x}" y2="${y + cellH}" class="rule" stroke-width="1"/>`)
    }
    y += cellH
  })

  const height = y + 4
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMinYMin meet">${STYLE}${parts.join('')}</svg>`
}

// The terminal's bar: whole blocks, then one partial block in eighths, on a dim track.
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
export function smoothBar(percent: number, width: number): { filled: string; partial: string; rest: number } {
  const cells = (Math.max(0, Math.min(100, percent)) / 100) * width
  const whole = Math.floor(cells)
  const eighth = Math.round((cells - whole) * 8)
  if (eighth === 8) return { filled: '█'.repeat(whole + 1), partial: '', rest: Math.max(0, width - whole - 1) }
  const partial = EIGHTHS[eighth] ?? ''
  return { filled: '█'.repeat(whole), partial, rest: Math.max(0, width - whole - (partial ? 1 : 0)) }
}
