// Ranking for the palette view: fuzzy match on label and description, plus a
// bonus for commands used recently.

const DAY_MS = 86_400_000;
// A just-used command gets this much, halving every day since. An exact
// substring hit scores 100+, so recency reorders comparable matches but never
// lifts a scattered fuzzy hit above a real one.
const RECENCY_WEIGHT = 30;
const WORD_BREAK = /[\s\p{P}\p{S}]/u;

function atWordStart(text, index) {
  return index === 0 || WORD_BREAK.test(text[index - 1]);
}

// Score of one query token against one text; null when it does not match.
// shortcut: greedy left-to-right subsequence, not fzf's optimal alignment;
// good enough for 36 short labels, revisit if rankings feel wrong.
export function fuzzyScore(token, text) {
  const haystack = String(text ?? '').toLowerCase();
  const needle = String(token ?? '').toLowerCase();
  if (needle.length === 0) return 0;
  const exact = haystack.indexOf(needle);
  if (exact >= 0) {
    return 100 + needle.length * 3 - Math.min(exact, 20) + (atWordStart(haystack, exact) ? 20 : 0);
  }
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const character of needle) {
    const at = haystack.indexOf(character, from);
    if (at < 0) return null;
    score += 1 + (at === previous + 1 ? 3 : 0) + (atWordStart(haystack, at) ? 2 : 0);
    previous = at;
    from = at + character.length;
  }
  return score;
}

// Every whitespace-separated token must match the label or the description, as
// in fzf's extended search. The label counts double: it is the name.
export function rankCommands(commands, query, usage = {}, now = Date.now()) {
  const tokens = String(query ?? '').trim().split(/\s+/u).filter(Boolean);
  const scored = [];
  (commands ?? []).forEach((command, index) => {
    let match = 0;
    for (const token of tokens) {
      const label = fuzzyScore(token, command.label);
      const description = fuzzyScore(token, command.description);
      if (label === null && description === null) return;
      match += Math.max(label ?? -Infinity, (description ?? -Infinity) / 2);
    }
    const used = Number(usage?.[command.id]);
    const lastUsed = Number.isFinite(used) && used > 0 ? used : 0;
    const recency = lastUsed > 0 ? RECENCY_WEIGHT * 0.5 ** (Math.max(0, now - lastUsed) / DAY_MS) : 0;
    scored.push({ command, score: match + recency, lastUsed, index });
  });
  return scored
    .sort((a, b) => b.score - a.score || b.lastUsed - a.lastUsed || a.index - b.index)
    .map((entry) => entry.command);
}
