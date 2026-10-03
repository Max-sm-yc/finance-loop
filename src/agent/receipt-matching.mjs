function normalizedWords(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/&/g, ' and ')
    .match(/[a-z0-9]+/g) ?? [];
}

function wordMatch(descriptionWords, candidateWords) {
  if (candidateWords.length < 2) return false;
  const descriptionSet = new Set(descriptionWords);
  return candidateWords.every(word => descriptionSet.has(word));
}

/** Rank same-currency catalog items for a human to verify and select.
 * @param {string} description
 * @param {Array<{catalogObjectId: string, name: string, sku: string | null, currency: string}>} candidates
 * @param {string} currency
 * @returns {Array<{candidate: {catalogObjectId: string, name: string, sku: string | null, currency: string}, exactNameMatch: boolean, nameWordsMatch: boolean, sharedWords: number, score: number}>}
 */
export function rankReceiptCatalogCandidates(description, candidates, currency) {
  const queryWords = normalizedWords(description);
  if (!queryWords.length || !Array.isArray(candidates)) return [];
  const querySet = new Set(queryWords);
  const normalizedDescription = queryWords.join(' ');
  return candidates
    .filter(candidate => candidate && candidate.currency === currency)
    .map(candidate => {
      const candidateWords = normalizedWords(`${candidate.name ?? ''} ${candidate.sku ?? ''} ${candidate.catalogObjectId ?? ''}`);
      const candidateSet = new Set(candidateWords);
      const sharedWords = [...querySet].filter(word => candidateSet.has(word)).length;
      const normalizedName = normalizedWords(candidate.name);
      const nameWordsMatch = wordMatch(queryWords, normalizedName);
      const exactNameMatch = normalizedDescription === normalizedName.join(' ');
      return {
        candidate,
        exactNameMatch,
        nameWordsMatch,
        sharedWords,
        score: sharedWords / Math.sqrt(Math.max(querySet.size, 1) * Math.max(candidateSet.size, 1))
      };
    })
    .filter(result => result.nameWordsMatch || result.sharedWords >= 2 || (querySet.size <= 2 && result.sharedWords >= 1))
    .sort((left, right) => Number(right.exactNameMatch) - Number(left.exactNameMatch) ||
      Number(right.nameWordsMatch) - Number(left.nameWordsMatch) || right.score - left.score ||
      String(left.candidate.name ?? '').localeCompare(String(right.candidate.name ?? '')) || String(left.candidate.catalogObjectId ?? '').localeCompare(String(right.candidate.catalogObjectId ?? '')))
    .slice(0, 100);
}
