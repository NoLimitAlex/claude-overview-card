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
// A summary is well under 100 KB; anything far bigger is not one of ours.
const MAX_SUMMARY_BYTES = 5 * 1024 * 1024
// Names that would reach an object's prototype if used as keys.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
// A plain count: finite, not negative, and below anything a person could use.
const num = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e15 ? v : 0)
const isRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v)

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
      const file = path.join(folder, name)
      if (fs.statSync(file).size > MAX_SUMMARY_BYTES) continue
      s = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    if (!isRecord(s) || s.version !== SUMMARY_VERSION || typeof s.computer !== 'string' || s.computer === self) continue
    if (!isRecord(s.days) || (s.slices !== undefined && !isRecord(s.slices))) continue
    const held = newest.get(s.computer)
    if (!held || String(s.updatedAt) > String(held.updatedAt)) newest.set(s.computer, s)
  }
  return [...newest.values()]
}

// Adds counts by name, ignoring anything that isn't a plain count under a plain name.
const add = (into, from) => {
  if (!isRecord(from)) return into
  for (const [k, v] of Object.entries(from)) {
    if (UNSAFE_KEYS.has(k) || k.length > 100) continue
    into[k] = (into[k] || 0) + num(v)
  }
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
    for (const [date, d] of Object.entries(s.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isRecord(d)) continue
      const into = (days[date] ??= { messageCount: 0, sessionCount: 0, tokensByModel: {} })
      into.messageCount += num(d.messageCount)
      into.sessionCount += num(d.sessionCount)
      add(into.tokensByModel, d.tokensByModel)
      if (typeof d.usd === 'number' && date >= weekStart) costByDay[date] = (costByDay[date] || 0) + num(d.usd)
    }
    add(hourCounts, s.hourCounts)
    totalSessions += num(s.totalSessions)
    totalMessages += num(s.totalMessages)
    lifetimeUsd += num(s.lifetimeUsd)
    const first = typeof s.firstSessionDate === 'string' && !Number.isNaN(Date.parse(s.firstSessionDate)) ? s.firstSessionDate : null
    if (first && (!firstSessionDate || first < firstSessionDate)) firstSessionDate = first
    for (const [at, slice] of Object.entries(s.slices ?? {})) {
      const start = Number(at)
      if (!Number.isFinite(start) || !isRecord(slice)) continue
      for (const [name, w] of Object.entries(windows)) {
        if (start < w.start) continue
        const t = windowTotals[name]
        t.messageCount += num(slice.m)
        t.usd += num(slice.usd)
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
