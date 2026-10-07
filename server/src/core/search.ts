const SPLIT = /[\s/:_,()-]+/;

export function words(text: string): string[] {
  return text.toLowerCase().split(SPLIT).filter(Boolean);
}

export function matchScore(query: string, id: string, name: string): number | null {
  const terms = words(query);
  if (terms.length === 0) return 0;
  const parts = [...words(id), ...words(name)];
  const compact = `${id} ${name}`.toLowerCase().replace(/[\s/:_.,()-]+/g, "");
  let score = 0;
  for (const t of terms) {
    if (parts.includes(t)) score += 3;
    else if (parts.some((p) => p.startsWith(t))) score += 2;
    else if (t.length >= 3 && compact.includes(t)) score += 1;
    else return null;
  }
  return score;
}
