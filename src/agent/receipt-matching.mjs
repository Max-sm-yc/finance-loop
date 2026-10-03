const GENERIC_WORDS = new Set([
  'a', 'an', 'and', 'assorted', 'bag', 'bags', 'beverage', 'beverages', 'box', 'boxes', 'can', 'cans',
  'candy', 'count', 'ct', 'drink', 'drinks', 'ea', 'each', 'fl', 'for', 'full', 'item', 'items',
  'of', 'oz', 'pack', 'packs', 'pk', 'per', 'size', 'soft', 'with'
]);

function normalizedWords(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/&/g, ' and ')
    .match(/[a-z0-9]+/g) ?? [];
}

function normalizedIdentifier(value) {
  return String(value ?? '').toLocaleLowerCase().replace(/[^a-z0-9]/g, '');
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
 * @returns {Array<{candidate: {catalogObjectId: string, name: string, sku: string | null, currency: string}, exactNameMatch: boolean, nameWordsMatch: boolean, identifierMatch: boolean, sharedWords: number, score: number}>}
 */
export function rankReceiptCatalogCandidates(description, candidates, currency) {
  const queryWords = normalizedWords(description);
  const queryContentWords = queryWords.filter(word => !GENERIC_WORDS.has(word));
  if (!queryWords.length || !Array.isArray(candidates)) return [];
  const normalizedDescription = queryWords.join(' ');
  const queryIdentifier = normalizedIdentifier(description);
  return candidates
    .filter(candidate => candidate && candidate.currency === currency)
    .map(candidate => {
      const nameWords = normalizedWords(candidate.name);
      const candidateContentWords = nameWords.filter(word => !GENERIC_WORDS.has(word));
      const querySet = new Set(queryContentWords);
      const sharedWords = [...new Set(candidateContentWords)].filter(word => querySet.has(word)).length;
      const nameWordsMatch = wordMatch(queryContentWords, candidateContentWords);
      const exactNameMatch = normalizedDescription === nameWords.join(' ');
      const identifierMatch = [candidate.sku, candidate.catalogObjectId]
        .some(value => queryIdentifier && queryIdentifier === normalizedIdentifier(value));
      const score = identifierMatch ? 1 : sharedWords / Math.sqrt(Math.max(querySet.size, 1) * Math.max(new Set(candidateContentWords).size, 1));
      return { candidate, exactNameMatch, nameWordsMatch, identifierMatch, sharedWords, score };
    })
    .filter(result => result.identifierMatch || result.exactNameMatch || result.nameWordsMatch ||
      result.sharedWords >= 2 || (queryContentWords.length === 1 && result.sharedWords === 1))
    .sort((left, right) => Number(right.identifierMatch) - Number(left.identifierMatch) ||
      Number(right.exactNameMatch) - Number(left.exactNameMatch) ||
      Number(right.nameWordsMatch) - Number(left.nameWordsMatch) || right.score - left.score ||
      String(left.candidate.name ?? '').localeCompare(String(right.candidate.name ?? '')) ||
      String(left.candidate.catalogObjectId ?? '').localeCompare(String(right.candidate.catalogObjectId ?? '')))
    .slice(0, 100);
}
