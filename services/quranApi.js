// ─────────────────────────────────────────────
//  Quran API Service
//  Uses api.quran.com v4 — free, no key needed
// ─────────────────────────────────────────────

const BASE = 'https://api.quran.com/api/v4';  // CHANGED: removed trailing space

/**
 * Fetch all 114 surahs with name + meta
 */
export async function fetchSurahs() {
  const res = await fetch(`${BASE}/chapters?language=en`);
  if (!res.ok) throw new Error('Failed to fetch surahs');
  const data = await res.json();
  return data.chapters;
}

/**
 * Fetch all verses for a given surah (chapter number 1–114)
 */
export async function fetchVerses(chapterNumber) {
  const res = await fetch(
    `${BASE}/verses/by_chapter/${chapterNumber}` +
    `?language=en&words=true&translations=131&per_page=300&fields=text_uthmani`
  );
  if (!res.ok) throw new Error('Failed to fetch verses');
  const data = await res.json();
  return data.verses;
}

/**
 * Get audio URL for a specific verse
 * verseKey format: "1:1" → "001001.mp3"
 */
export async function fetchVerseAudioUrl(verseKey) {
  const [chapter, verse] = verseKey.split(':');
  const padded = String(chapter).padStart(3, '0') + String(verse).padStart(3, '0');
  return `https://verses.quran.com/Alafasy/mp3/${padded}.mp3`;  // CHANGED: removed space after mp3/
}