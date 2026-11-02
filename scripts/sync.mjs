// Usage sync between computers through a shared folder (OneDrive, Dropbox, ...).
//
// Each computer writes one summary of its own usage to <folder>/<computer>.usage.json:
// totals per day, lifetime totals, and 10-minute slices of the last 8 days, so
// the others can total any limit window. Only numbers are written, never chats,
// code or file names. Each computer then adds up the summaries of the others.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const SUMMARY_VERSION = 1
export const SLICE_MS = 10 * 60 * 1000
const SUFFIX = '.usage.json'

export function computerName() {
  return os.hostname().replace(/[^A-Za-z0-9_.-]/g, '_') || 'computer'
}

// Writes this computer's summary next to a temporary file first, so a sync
// client never uploads half a file.
export function writeSummary(folder, summary) {
  fs.mkdirSync(folder, { recursive: true })
  const target = path.join(folder, `${summary.computer}${SUFFIX}`)
  const temp = `${target}.tmp-${process.pid}`
  fs.writeFileSync(temp, JSON.stringify(summary))
  fs.renameSync(temp, target)
}

// Every other computer's newest summary. A sync client may leave conflict copies
// (two files for one computer), so each computer counts once, by its newest file.
export function readOthers(folder, self) {
  let names = []
  try {
    names = fs.readdirSync(folder)
  } catch {
    return []
  }
  const newest = new Map()
  for (const name of names) {
    if (!name.endsWith(SUFFIX)) continue
    let s
    try {
      s = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8'))
    } catch {
      continue
    }
    if (s?.version !== SUMMARY_VERSION || typeof s.computer !== 'string' || s.computer === self) continue
    const held = newest.get(s.computer)
    if (!held || String(s.updatedAt) > String(held.updatedAt)) newest.set(s.computer, s)
  }
  return [...newest.values()]
}

const add = (into, from) => {
  for (const [k, v] of Object.entries(from ?? {})) into[k] = (into[k] || 0) + v
  return into
}

// The other computers added together, in the shapes the card merges.
export function combineOthers(others, { weekStart, windows }) {
  const days = {}
  const hourCounts = {}
  const windowTotals = {}
  for (const name of Object.keys(windows)) windowTotals[name] = { messageCount: 0, tokensByModel: {}, usd: 0 }
  let totalSessions = 0
  let totalMessages = 0
  let lifetimeUsd = 0
  let firstSessionDate = null
  const costByDay = {}

  for (const s of others) {
    for (const [date, d] of Object.entries(s.days ?? {})) {
      const into = (days[date] ??= { messageCount: 0, sessionCount: 0, tokensByModel: {} })
      into.messageCount += d.messageCount || 0
      into.sessionCount += d.sessionCount || 0
      add(into.tokensByModel, d.tokensByModel)
      if (typeof d.usd === 'number' && date >= weekStart) costByDay[date] = (costByDay[date] || 0) + d.usd
    }
    add(hourCounts, s.hourCounts)
    totalSessions += s.totalSessions || 0
    totalMessages += s.totalMessages || 0
    lifetimeUsd += s.lifetimeUsd || 0
    if (s.firstSessionDate && (!firstSessionDate || s.firstSessionDate < firstSessionDate)) firstSessionDate = s.firstSessionDate
    for (const [at, slice] of Object.entries(s.slices ?? {})) {
      const start = Number(at)
      for (const [name, w] of Object.entries(windows)) {
        if (start < w.start) continue
        const t = windowTotals[name]
        t.messageCount += slice.m || 0
        t.usd += slice.usd || 0
        add(t.tokensByModel, slice.t)
      }
    }
  }

  const sorted = Object.keys(days).sort()
  return {
    computers: others.map(s => ({ name: s.computer, updatedAt: s.updatedAt })),
    dailyActivity: sorted.map(d => ({ date: d, messageCount: days[d].messageCount, sessionCount: days[d].sessionCount })),
    dailyModelTokens: sorted.map(d => ({ date: d, tokensByModel: days[d].tokensByModel })),
    totalSessions,
    totalMessages,
    hourCounts,
    lifetimeUsd,
    firstSessionDate,
    costByDay,
    windowTotals,
  }
}
