import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionCost, SessionRateLimit } from 'claude-code'

import type { OverviewCountError, OverviewLimits, OverviewRecent, OverviewRange, OverviewTab } from '../types'
import {
  dayKey,
  dayTotals,
  modelTotals,
  duneLine,
  formatCount,
  grid,
  mergeRecent,
  rangeStart,
  rasterCells,
  summarize,
  svgSource,
  withCommas,
  modelName,
} from './stats'
import type { StatsCache, Summary } from './stats'
import { lifetimeNote, meterColors, money, smoothBar, usageBlocks, usageSvg } from './usage-view'
import type { Block, Meter } from './usage-view'

const PANE = 'overview'
const range = atom({ plugin: 'overview-card', key: 'range' } as const, 'all' as OverviewRange)
const tab = atom({ plugin: 'overview-card', key: 'tab' } as const, 'overview' as OverviewTab)
// The shape tag changes whenever the counter's output does, so numbers saved by an
// older version are ignored instead of shown without the newer fields.
const recent = atom({ plugin: 'overview-card', key: 'recent' } as const, null as OverviewRecent | null, { shape: 'counts-v4' })
const limits = atom({ plugin: 'overview-card', key: 'limits' } as const, null as OverviewLimits | null)
const countError = atom({ plugin: 'overview-card', key: 'countError' } as const, null as OverviewCountError | null)
const REFRESH_MS = 10 * 60 * 1000
// After a turn the logs are recounted, at most this often.
const TURN_REFRESH_MS = 60 * 1000
// Counts older than this are redone as soon as the card is drawn, so a chat that
// sat idle (or slept with the PC) catches up the moment you look at it.
const STALE_MS = 2 * 60 * 1000
let lastCount = 0

const RANGES: OverviewRange[] = ['all', '30d', '7d']
const RANGE_LABEL: Record<OverviewRange, string> = { all: 'All', '30d': '30d', '7d': '7d' }
const ACCENT = '#4aa8f0'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'overview',
      description: 'Show the usage overview card (sessions, tokens, heatmap)',
    })
    void refreshRecent($)
    void refreshLimits($)
    $.clock.every(REFRESH_MS, () => refreshRecent($))
    void openPane($)
    return next(e)
  })

  // Claude Code measures the session after each turn and whenever a limit moves a point.
  on('session.measure', async ($, e, next) => {
    void storeLimits($, e.rateLimits, e.context, e.cost)
    if (e.changed.includes('rateLimits') || Date.now() - lastCount > TURN_REFRESH_MS) void refreshRecent($)
    return next(e)
  })

  on('command.run', { command: 'overview' }, async $ => {
    void refreshRecent($)
    void refreshLimits($)
    await openPane($)
    return { text: 'Overview card opened. Press Esc at an empty prompt to close it.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(30, e.props.bodyColumns)
    const current = await read($, range)
    const view = await read($, tab)

    const cached = await loadStats($)
    const extra = await read($, recent)
    if (extra === null || Date.now() - extra.checkedAt > STALE_MS) recountSoon($)
    const stats = cached === undefined ? undefined : mergeRecent(cached, extra)
    if (stats === undefined) {
      return (
        <Box flexDirection="column">
          <Text bold>What's up next?</Text>
          <Text dimColor>No usage stats yet. Run /stats once, then open /overview again.</Text>
        </Box>
      )
    }
    const today = new Date()
    const s = summarize(stats, current, today)

    const weeks = Math.max(4, Math.min(Math.floor(width / 2), 53))
    const g = grid(s.perDay, today, weeks)
    let heatmap: JSX.Element
    if (e.surface === 'terminal') {
      const { Raster } = $.ui.resolve(e)
      const r = rasterCells(g)
      heatmap = <Raster key="heatmap" columns={r.columns} rows={r.rows} cells={r.cells} />
    } else if (e.surface === 'desktop') {
      const { Svg } = $.ui.resolve(e)
      heatmap = <Svg source={svgSource(g)} alt={`Activity heatmap, ${s.activeDays} active days`} />
    } else {
      heatmap = <Text dimColor>{s.activeDays} active days</Text>
    }

    const header = (
      <Box flexDirection="row" justifyContent="space-between" width={width}>
        <Box flexDirection="row" gap={1}>
          <Button key="tab-overview" plain hotkey="o" variant={view === 'overview' ? 'primary' : 'secondary'}
            onPress={() => update($, tab, () => 'overview')}>
            <Text bold={view === 'overview'} inverse={view === 'overview'}> Overview </Text>
          </Button>
          <Button key="tab-models" plain hotkey="m" variant={view === 'models' ? 'primary' : 'secondary'}
            onPress={() => update($, tab, () => 'models')}>
            <Text bold={view === 'models'} inverse={view === 'models'}> Models </Text>
          </Button>
        </Box>
        <Box flexDirection="row" gap={1}>
          {RANGES.map(r => (
            <Button key={`range-${r}`} plain onPress={() => update($, range, () => r)}>
              <Text bold={r === current} inverse={r === current} dimColor={r !== current}> {RANGE_LABEL[r]} </Text>
            </Button>
          ))}
        </Box>
      </Box>
    )

    const tile = (key: string, label: string, value: string, tileWidth: number) => (
      <Box key={key} flexDirection="column" borderStyle="round" borderDimColor paddingX={1} width={tileWidth}>
        <Text dimColor wrap="truncate-end">{label}</Text>
        <Text bold wrap="truncate-end">{value}</Text>
      </Box>
    )

    const body =
      view === 'overview' ? overviewBody() : modelsBody(s)

    function overviewBody() {
      const tileWidth = Math.floor((width - 2) / 3)
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            {tile('sessions', 'Sessions', withCommas(s.sessions), tileWidth)}
            {tile('messages', 'Messages', withCommas(s.messages), tileWidth)}
            {tile('tokens', 'Total tokens', formatCount(s.tokens), tileWidth)}
          </Box>
          <Box flexDirection="row" gap={1}>
            {tile('days', 'Active days', String(s.activeDays), tileWidth)}
            {tile('peak', 'Peak hour', s.peakHour ?? '-', tileWidth)}
            {tile('favorite', 'Favorite model', s.favoriteModel ?? '-', tileWidth)}
          </Box>
          <Box marginTop={1}>{heatmap}</Box>
          <Box marginTop={1}>
            <Text dimColor>{duneLine(s.tokens)}</Text>
          </Box>
        </Box>
      )
    }

    function modelsBody(sum: Summary) {
      if (sum.byModel.length === 0) return <Text dimColor>No model usage in this range.</Text>
      const top = sum.byModel[0]?.tokens ?? 1
      const nameWidth = 14
      const valueWidth = 8
      const barRoom = Math.max(6, width - nameWidth - valueWidth - 10)
      return (
        <Box flexDirection="column" marginTop={1}>
          {sum.byModel.map(m => {
            const share = sum.tokens > 0 ? Math.round((m.tokens / sum.tokens) * 100) : 0
            const bar = '█'.repeat(Math.max(1, Math.round((m.tokens / top) * barRoom)))
            return (
              <Box key={m.model} flexDirection="row" gap={1}>
                <Box width={nameWidth}><Text wrap="truncate-end">{modelName(m.model)}</Text></Box>
                <Box width={valueWidth}><Text bold>{formatCount(m.tokens)}</Text></Box>
                <Text color={ACCENT}>{bar}</Text>
                <Text dimColor>{share}%</Text>
              </Box>
            )
          })}
        </Box>
      )
    }

    const meters = await read($, limits)
    const now = new Date()
    const mine = extra?.session
    const sessionModels = modelTotals(mine?.tokensByModel ?? {})
    const week = summarize(stats, '7d', now)
    const cost = extra?.cost
    const weekStart = rangeStart('7d', now) ?? ''
    const weekUsd = cost === undefined ? undefined : Object.entries(cost.byDay).reduce((n, [d, usd]) => (d >= weekStart ? n + usd : n), 0)
    const todayKey = dayKey(now)
    const lifetime = cost === undefined ? undefined : { usd: cost.lifetimeUsd, since: cost.since }
    const failed = await read($, countError)
    const windowTotals = (name: string) => {
      const w = extra?.windows?.[name]
      return w === undefined ? undefined : { messages: w.messageCount, ...modelTotals(w.tokensByModel), costUsd: w.usd, start: w.start }
    }
    const blocks = usageBlocks({
      rateLimits: meters?.rateLimits ?? [],
      context: meters ? { percent: meters.contextPercent, tokens: meters.contextTokens, window: meters.contextWindow } : undefined,
      today: { ...dayTotals(stats, todayKey), costUsd: cost === undefined ? undefined : cost.byDay[todayKey] ?? 0 },
      week: { messages: week.messages, tokens: week.tokens, byModel: week.byModel, costUsd: weekUsd },
      fiveHour: windowTotals('5h'),
      weekly: windowTotals('7d'),
      session: mine === undefined ? undefined : { messages: mine.messageCount, ...sessionModels, costUsd: cost?.sessionUsd },
      countError: failed?.reason,
      now,
    })

    let usage: JSX.Element
    if (e.surface === 'desktop') {
      const { Svg } = $.ui.resolve(e)
      const summary = blocks.flatMap(b => b.meters.map(m => `${m.label} ${m.percent === undefined ? 'waiting' : `${Math.round(m.percent)}%`}`)).join(', ')
      usage = <Svg source={usageSvg(blocks, lifetime, updatedLabel(extra?.checkedAt))} alt={`Usage: ${summary}`} />
    } else {
      const labelWidth = 22
      const barWidth = Math.max(12, Math.min(48, width - labelWidth - 30))
      const meterRow = (m: Meter) => {
        const bar = smoothBar(m.percent ?? 0, barWidth)
        const color = meterColors(m.percent ?? 0)[1]
        return (
          <Box key={`meter-${m.key}`} flexDirection="column">
            <Box flexDirection="row" justifyContent="space-between" width={labelWidth + barWidth + 1}>
              <Text bold>{m.label}</Text>
              <Text dimColor>{m.percent === undefined ? m.note : `${Math.round(m.percent)}%${m.note ? ` · ${m.note}` : ''}`}</Text>
            </Box>
            <Box flexDirection="row">
              <Text color={color}>{bar.filled}</Text>
              {bar.partial !== '' && <Text color={color} backgroundColor="#34343a">{bar.partial}</Text>}
              <Text backgroundColor="#34343a">{' '.repeat(bar.rest)}</Text>
            </Box>
          </Box>
        )
      }
      const divider = (key: string) => (
        <Box key={key} flexDirection="column">
          <Text dimColor>│</Text>
          <Text dimColor>│</Text>
        </Box>
      )
      const cellRow = (b: Block, bi: number) => {
        const cellWidth = Math.max(10, Math.floor((labelWidth + barWidth) / Math.max(1, b.cells.length)) - 1)
        const row: JSX.Element[] = [divider(`div-${bi}-start`)]
        b.cells.forEach((c, ci) => {
          row.push(
            <Box key={`cell-${bi}-${ci}`} flexDirection="column" paddingX={1} width={cellWidth}>
              <Text dimColor wrap="truncate-end">{c.label}</Text>
              <Text bold wrap="truncate-end">{c.value}</Text>
            </Box>,
          )
          row.push(divider(`div-${bi}-${ci}`))
        })
        return <Box flexDirection="row">{row}</Box>
      }
      usage = (
        <Box flexDirection="column">
          {lifetime !== undefined && (
            <Box flexDirection="column">
              <Text dimColor bold>LIFETIME API VALUE</Text>
              <Text bold color="#58b4ff">{money(lifetime.usd)}</Text>
              <Text dimColor>{lifetimeNote(lifetime.since)} · {updatedLabel(extra?.checkedAt)}</Text>
            </Box>
          )}
          {blocks.map((b, bi) => (
            <Box key={`block-${bi}`} flexDirection="column" marginTop={1}>
              {b.meters.map(meterRow)}
              <Box marginTop={1} flexDirection="row" justifyContent="space-between" width={labelWidth + barWidth + 1}>
                <Text dimColor bold>{b.title.toUpperCase()}</Text>
                {b.note !== undefined && <Text dimColor>{b.note}</Text>}
              </Box>
              {cellRow(b, bi)}
            </Box>
          ))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" width={width}>
        <Text bold>What's up next?</Text>
        <Box marginTop={1}>{header}</Box>
        <Box marginTop={1}>{body}</Box>
        <Box marginTop={1}>{usage}</Box>
      </Box>
    )
  })
}

async function storeLimits(
  $: EngineInterface,
  rateLimits: readonly SessionRateLimit[],
  context: SessionContextUsage,
  cost: SessionCost | undefined,
): Promise<void> {
  await update($, limits, () => ({
    rateLimits: rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
    contextTokens: context.tokens,
    contextWindow: context.window,
    contextPercent: context.percent,
    costUsd: cost?.usd,
    at: Date.now(),
  }))
}

// The plain usage call is free: it reads what the status line already has.
async function refreshLimits($: EngineInterface): Promise<void> {
  try {
    const usage = await $.session.usage()
    await storeLimits($, usage.rateLimits, usage.context, usage.cost)
  } catch {
    // No reading yet; the measure hook fills it in after the first turn.
  }
}

function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: 'Overview', closeOnEscape: true, rows: 52 })
}

async function configDir($: EngineInterface): Promise<string | undefined> {
  const fromEnv = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return fromEnv ?? (home === undefined ? undefined : `${home}/.claude`)
}

// Counts the days stats-cache.json has not covered yet (it stops at yesterday and
// only refreshes when /stats runs) by running the bundled script with Node.
// Drawing may not write state, so the recount runs from a timer right after.
function recountSoon($: EngineInterface): void {
  if (Date.now() - lastCount < 30_000) return
  lastCount = Date.now()
  try {
    $.clock.after(1, () => void refreshRecent($))
  } catch {
    // The next turn or the 10-minute timer recounts instead.
  }
}

// "updated just now", "updated 4 min ago", "updated 2 h ago"
function updatedLabel(at: number | undefined): string {
  if (at === undefined) return 'counting…'
  const minutes = Math.floor((Date.now() - at) / 60_000)
  if (minutes < 1) return 'updated just now'
  if (minutes < 60) return `updated ${minutes} min ago`
  return `updated ${Math.floor(minutes / 60)} h ago`
}

async function refreshRecent($: EngineInterface): Promise<void> {
  const dir = await configDir($)
  if (dir === undefined) return
  lastCount = Date.now()
  try {
    const sessionId = await $.session.id()
    // Each limit window began its length before it resets.
    const windowArgs: string[] = []
    try {
      const usage = await $.session.usage()
      for (const w of usage.rateLimits) {
        const length = w.kind === 'five_hour' ? 5 * 3600_000 : w.kind === 'seven_day' ? 7 * 86400_000 : 0
        const resets = w.resetsAt === undefined ? NaN : Date.parse(w.resetsAt)
        if (length > 0 && !Number.isNaN(resets)) {
          windowArgs.push(`${w.kind === 'five_hour' ? '5h' : '7d'}=${new Date(resets - length).toISOString()}`)
        }
      }
    } catch {
      // No limit reading yet: the card shows today and the last 7 days instead.
    }
    // Run from the config folder: the session's own folder may be gone (the
    // desktop app moves its scratch folders), and Windows will not start a
    // program from a folder that does not exist.
    const run = await $.process.run(
      ['node', `${$.plugin.root}/scripts/recent-stats.mjs`, dir, sessionId, ...windowArgs],
      { cwd: dir, timeoutMs: 60_000 },
    )
    if (run.exitCode !== 0) {
      const last = run.stderr.trim().split(/\r?\n/).pop()
      throw new Error(last !== undefined && last !== '' ? last : `node exited ${run.exitCode}`)
    }
    const counted = JSON.parse(run.stdout) as Omit<OverviewRecent, 'checkedAt'>
    await update($, recent, () => ({ ...counted, checkedAt: Date.now() }))
    await update($, countError, () => null)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    await update($, countError, () => ({ reason: reason.slice(0, 120), at: Date.now() }))
  }
}

async function loadStats($: EngineInterface): Promise<StatsCache | undefined> {
  const dir = await configDir($)
  if (dir === undefined) return undefined
  try {
    const text = await $.fs.read(`${dir}/stats-cache.json`)
    return JSON.parse(String(text)) as StatsCache
  } catch {
    return undefined
  }
}
