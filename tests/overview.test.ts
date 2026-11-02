import { describe, expect, mock, test } from 'claude-code/testing'

import { money, smoothBar, usageBlocks, usageSvg } from '../hooks/usage-view'
import { priceUsd } from '../scripts/pricing.mjs'
import { mergeOthers } from '../hooks/stats'
import { lifetimeNote } from '../hooks/usage-view'
import { dayTotals, duneLine, limitLabel, meterBar, mergeRecent, modelName, resetLabel, summarize } from '../hooks/stats'

const today = new Date()
const iso = (daysAgo: number) => {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const STATS = {
  dailyActivity: [
    { date: iso(60), messageCount: 100, sessionCount: 2 },
    { date: iso(10), messageCount: 50, sessionCount: 1 },
    { date: iso(2), messageCount: 20, sessionCount: 1 },
  ],
  dailyModelTokens: [
    { date: iso(60), tokensByModel: { 'claude-opus-5': 900_000_000 } },
    { date: iso(2), tokensByModel: { 'claude-fable-5-1': 100_000_000 } },
  ],
  totalSessions: 4,
  totalMessages: 170,
  hourCounts: { '20': 6, '9': 1 },
}

const PANE = { title: 'Overview', isFocused: false, bodyColumns: 80, placement: 'inline' } as const

describe('stats', () => {
  test('ranges filter days, tokens and the favorite model', async () => {
    const all = summarize(STATS, 'all', today)
    expect(all.sessions).toBe(4)
    expect(all.tokens).toBe(1_000_000_000)
    expect(all.favoriteModel).toBe('Opus 5')
    expect(all.peakHour).toBe('8 PM')
    const week = summarize(STATS, '7d', today)
    expect(week.messages).toBe(20)
    expect(week.favoriteModel).toBe('Fable 5.1')
    expect(summarize(STATS, '30d', today).activeDays).toBe(2)
  })

  test('days counted from the logs are added after the cache stops', async () => {
    const cache = { ...STATS, lastComputedDate: iso(3) }
    const recent = {
      cutoff: iso(3),
      sessions: 1,
      dailyActivity: [{ date: iso(0), messageCount: 30, sessionCount: 1 }],
      dailyModelTokens: [{ date: iso(0), tokensByModel: { 'claude-opus-5-5': 5_000_000 } }],
      hourCounts: { '20': 1 },
    }
    const merged = mergeRecent(cache, recent)
    const week = summarize(merged, '7d', today)
    expect(week.messages).toBe(30)
    expect(week.tokens).toBe(5_000_000)
    expect(summarize(merged, 'all', today).sessions).toBe(5)
    expect(merged.totalMessages).toBe(200)
    // a count made against an older cache is ignored once the cache moves on
    expect(mergeRecent({ ...cache, lastComputedDate: iso(1) }, recent)).toEqual({ ...cache, lastComputedDate: iso(1) })
  })

  test('limit windows get readable names and meters', async () => {
    expect(limitLabel('five_hour')).toBe('5-hour limit')
    expect(limitLabel('seven_day')).toBe('Weekly · all models')
    expect(limitLabel('seven_day_fable')).toBe('Weekly · Fable')
    expect(limitLabel('seven_day_opus')).toBe('Weekly · Opus')
    const bar = meterBar(25, 20)
    expect(bar.filled.length).toBe(5)
    expect(bar.empty.length).toBe(15)
    const now = new Date(2026, 9, 23, 12, 0)
    expect(resetLabel(new Date(2026, 9, 23, 21, 40).toISOString(), now)).toBe('resets 9:40 PM')
    expect(resetLabel(new Date(2026, 9, 24, 19, 0).toISOString(), now)).toBe('resets Sat 7:00 PM')
  })

  test('each limit is followed by its own numbers', async () => {
    const blocks = usageBlocks({
      rateLimits: [
        { kind: 'seven_day_fable', percentUsed: 27 },
        { kind: 'five_hour', percentUsed: 38 },
        { kind: 'seven_day', percentUsed: 24 },
      ],
      context: { percent: 21, tokens: 213_000, window: 1_000_000 },
      today: { messages: 204, tokens: 44_000_000, byModel: [{ model: 'claude-fable-5-1', tokens: 38_000_000 }], costUsd: 136.66 },
      week: { messages: 4491, tokens: 857_000_000, byModel: [] },
      now: new Date(),
    })
    expect(blocks.map(b => b.title)).toEqual(['Today', 'Last 7 days', 'This session'])
    expect(blocks[0]?.meters.map(m => m.label)).toEqual(['5-hour limit'])
    expect(blocks[1]?.meters.map(m => m.label)).toEqual(['Weekly · all models', 'Weekly · Fable'])
    expect(blocks[2]?.meters[0]?.note).toBe('213K of 1M')
    expect(blocks[0]?.cells.map(c => c.label)).toEqual(['Messages', 'Tokens', 'API value', 'Fable 5.1'])
    expect(blocks[0]?.cells[2]?.value).toBe('$136.66')
    expect(blocks[1]?.cells.map(c => c.label)).toEqual(['Messages', 'Tokens'])
    expect(usageSvg(blocks)).toContain('Weekly · Fable')
    const withLifetime = usageSvg(blocks, { usd: 2579.73, since: '2026-06-23T09:39:15.314Z' })
    expect(withLifetime).toContain('LIFETIME API VALUE')
    expect(withLifetime).toContain('$2,579.73')
    expect(withLifetime).toContain('Since Jun 23, 2026')
    const waiting = usageBlocks({ rateLimits: [], today: { messages: 0, tokens: 0, byModel: [] }, week: { messages: 0, tokens: 0, byModel: [] }, now: new Date() })
    expect(waiting[0]?.meters[0]?.percent).toBeUndefined()
  })

  test('the limit windows get their own numbers once the limits are known', async () => {
    const now = new Date(2026, 9, 23, 18, 0)
    const blocks = usageBlocks({
      rateLimits: [{ kind: 'five_hour', percentUsed: 38 }, { kind: 'seven_day', percentUsed: 24 }],
      today: { messages: 1, tokens: 1, byModel: [] },
      week: { messages: 2, tokens: 2, byModel: [] },
      fiveHour: { messages: 1102, tokens: 178_000_000, byModel: [], costUsd: 145.38, start: new Date(2026, 9, 23, 14, 55).toISOString() },
      weekly: { messages: 7100, tokens: 1_300_000_000, byModel: [], costUsd: 1013.72, start: new Date(2026, 9, 18, 17, 55).toISOString() },
      countError: 'spawn node ENOENT',
      now,
    })
    expect(blocks[0]?.title).toBe('This 5-hour window')
    expect(blocks[0]?.note).toBe('since 2:55 PM')
    expect(blocks[0]?.cells.find(c => c.label === 'API value')?.value).toBe('$145.38')
    expect(blocks[1]?.title).toBe('This week’s window')
    expect(blocks[1]?.note).toBe('since Sun 5:55 PM')
    expect(blocks[2]?.note).toBe("couldn't count: spawn node ENOENT")
    expect(blocks[2]?.cells[0]?.value).toBe('–')
  })

  test("another computer's usage is added day by day", async () => {
    const others = {
      dailyActivity: [
        { date: iso(2), messageCount: 5, sessionCount: 1 },
        { date: iso(1), messageCount: 7, sessionCount: 0 },
      ],
      dailyModelTokens: [{ date: iso(2), tokensByModel: { 'claude-fable-5-1': 1_000_000, 'claude-opus-5-5': 50 } }],
      totalSessions: 3,
      totalMessages: 12,
      hourCounts: { '20': 2, '9': 4 },
    }
    const merged = mergeOthers(STATS, others)
    expect(dayTotals(merged, iso(2)).messages).toBe(25)
    expect(dayTotals(merged, iso(2)).tokens).toBe(101_000_050)
    expect(dayTotals(merged, iso(1)).messages).toBe(7)
    expect(merged.totalSessions).toBe(7)
    expect(merged.totalMessages).toBe(182)
    expect(summarize(merged, 'all', today).peakHour).toBe('8 PM')
    expect(merged.dailyActivity?.map(d => d.date)).toEqual([...merged.dailyActivity!.map(d => d.date)].sort())
    expect(mergeOthers(STATS, null)).toBe(STATS)
    expect(lifetimeNote(null, 2)).toBe('what your usage would cost at Claude API prices · 2 computers')
    expect(lifetimeNote(null, 1)).toBe('what your usage would cost at Claude API prices')
  })

  test('replies are priced at Claude API list prices', async () => {
    const million = { input: 1e6, output: 0, read: 0, write5m: 0, write1h: 0 }
    expect(priceUsd('claude-opus-5-5', million)).toBe(4)
    expect(priceUsd('claude-fable-5-1', { ...million, input: 0, read: 1e6 })).toBe(0.25)
    expect(priceUsd('claude-opus-5', { ...million, input: 0, write1h: 1e6 })).toBe(10)
    expect(priceUsd('claude-sonnet-4-6', { ...million, input: 0, output: 1e6 })).toBe(15)
    expect(priceUsd('claude-haiku-5-5', { ...million, input: 200_000 })).toBe(0.1)
    expect(priceUsd('claude-opus-5-5', { ...million, webSearches: 100 })).toBe(5)
    expect(priceUsd('claude-opus-5-5', million, { isFast: true })).toBe(8)
    expect(priceUsd('some-other-model', million)).toBeUndefined()
    expect(money(0.4)).toBe('$0.40')
    expect(money(1234567.891)).toBe('$1,234,567.89')
  })

  test('the terminal bar fills in eighths of a cell', async () => {
    expect(smoothBar(50, 10)).toEqual({ filled: '█████', partial: '', rest: 5 })
    expect(smoothBar(55, 10)).toEqual({ filled: '█████', partial: '▌', rest: 4 })
    expect(smoothBar(100, 10)).toEqual({ filled: '██████████', partial: '', rest: 0 })
  })

  test("today's totals come from the merged days", async () => {
    const t = dayTotals(STATS, iso(2))
    expect(t.messages).toBe(20)
    expect(t.tokens).toBe(100_000_000)
    expect(t.byModel[0]?.model).toBe('claude-fable-5-1')
  })

  test('names and the Dune line read like the old card', async () => {
    expect(modelName('claude-opus-4-8')).toBe('Opus 4.8')
    expect(duneLine(1_000_000_000)).toBe("You've used ~4,300x more tokens than Dune.")
  })
})

test('the card draws on the terminal and the desktop and its buttons switch views', async ($, on) => {
  mock.env(on, { USERPROFILE: 'C:/Users/test' })
  on('fs.read', async () => ({ value: JSON.stringify(STATS) }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'overview-card', surface, component: 'Pane', requestId: 'overview', props: PANE })
    expect(await ui.find({ text: /Sessions/ })).toBeDefined()
    if (surface === 'terminal') {
      expect(await ui.find({ text: /5-hour limit/ })).toBeDefined()
      expect(await ui.find({ text: /TODAY/ })).toBeDefined()
      expect(await ui.find({ text: /THIS SESSION/ })).toBeDefined()
    } else {
      const svgs = await ui.findAll({ type: 'Svg' })
      expect(svgs.some(svg => String(svg.props.source).includes('5-hour limit'))).toBe(true)
    }
    expect(await ui.find({ text: /4,300x more tokens than Dune/ })).toBeDefined()
    expect(await ui.find({ key: 'heatmap' }) ?? (await ui.find({ type: 'Svg' }))).toBeDefined()
    await ui.press({ key: 'tab-models' })
    expect(await ui.find({ text: /Opus 5/ })).toBeDefined()
    await ui.press({ key: 'range-7d' })
    expect(await ui.find({ text: /Fable 5.1/ })).toBeDefined()
    expect(await ui.find({ text: /^Opus 5$/ })).toBeUndefined()
    await ui.press({ key: 'tab-overview' })
    await ui.press({ key: 'range-all' })
    await ui.unmount()
  }
})

test('with no stats file the card says how to get one', async ($, on) => {
  mock.env(on, { USERPROFILE: 'C:/Users/test' })
  on('fs.read', async () => {
    throw new Error('ENOENT')
  })
  const ui = await $.ui.mount({ plugin: 'overview-card', surface: 'terminal', component: 'Pane', requestId: 'overview', props: PANE })
  expect(await ui.find({ text: /Run \/stats once/ })).toBeDefined()
  await ui.unmount()
})

test('drawing the card with no fresh numbers starts a recount', async ($, on) => {
  mock.env(on, { USERPROFILE: 'C:/Users/test' })
  on('fs.read', async () => ({ value: JSON.stringify(STATS) }))
  // The test world has no Node to run, so the recount fails, and that failure is
  // the sign it ran: the card then names the reason under This session.
  const clock = mock.clock(on, { now: Date.now() })
  const ui = await $.ui.mount({ plugin: 'overview-card', surface: 'terminal', component: 'Pane', requestId: 'overview', props: PANE })
  expect(await ui.find({ text: /couldn't count/ })).toBeUndefined()
  await clock.advance(50)
  expect(await ui.find({ text: /couldn't count/ })).toBeDefined()
  await ui.unmount()
})
