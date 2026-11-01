// Claude API list prices in USD per million tokens, from
// https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-10-23).
// [base input, 5-minute cache write, 1-hour cache write, cache read, output]
const TABLE = [
  [/^claude-(fable|mythos)-5-1/, [10, 12.5, 20, 0.25, 50]],
  [/^claude-(fable|mythos)-5/, [10, 12.5, 20, 1, 50]],
  [/^claude-opus-5-5/, [4, 5, 8, 0.2, 20]],
  [/^claude-opus-(5|4-8|4-7|4-6|4-5)/, [5, 6.25, 10, 0.5, 25]],
  [/^claude-opus-4/, [15, 18.75, 30, 1.5, 75]],
  [/^claude-sonnet-5-5/, [2, 2.5, 4, 0.1, 10]],
  [/^claude-sonnet-5/, [2, 2.5, 4, 0.2, 10]],
  [/^claude-sonnet-4/, [3, 3.75, 6, 0.3, 15]],
  [/^claude-haiku-4-5/, [1, 1.25, 2, 0.1, 5]],
  [/^claude-(3-5-)?haiku/, [0.8, 1, 1.6, 0.08, 4]],
]
const HAIKU_55 = { short: [0.1, 0.125, 0.2, 0.01, 0.5], long: [0.5, 0.625, 1, 0.05, 2.5] }
export const WEB_SEARCH_USD = 0.01

// The rates for a model; Haiku 5.5 depends on the request's prompt length.
export function ratesFor(model, promptTokens = 0) {
  if (/^claude-haiku-5-5/.test(model)) return promptTokens > 100_000 ? HAIKU_55.long : HAIKU_55.short
  for (const [re, rates] of TABLE) if (re.test(model)) return rates
  return undefined
}

// One request's API price from its token counts; fast mode bills at twice the rates.
export function priceUsd(model, t, { isFast = false } = {}) {
  const prompt = t.input + t.read + t.write5m + t.write1h
  const r = ratesFor(model, prompt)
  if (!r) return undefined
  const [inp, w5, w1, rd, out] = r
  const usd = (t.input * inp + t.write5m * w5 + t.write1h * w1 + t.read * rd + t.output * out) / 1e6
  return (isFast ? usd * 2 : usd) + (t.webSearches ?? 0) * WEB_SEARCH_USD
}
