const FORM_ID = '1FAIpQLSd5BmQeM3iJZP4BWoFa3cN4If96Sh51I7U25qzpdE5l89iyNA';
const ENTRY_ID = 'entry.1153529868';

export async function submitVideoFeedback(wantsVideos) {
  try {
    const formData = new URLSearchParams();
    formData.append(ENTRY_ID, wantsVideos ? "Yes, I'd watch that" : 'Not really interested');

    const response = await fetch(`https://docs.google.com/forms/d/e/${FORM_ID}/formResponse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString(),
    });

    console.log('[Feedback] Status code:', response.status);
    const text = await response.text();
    console.log('[Feedback] Response length:', text.length);
  } catch (e) {
    console.log('[Feedback] Error:', e.message);
  }
}