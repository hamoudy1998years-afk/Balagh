const VIDEO_FORM_ID = '1FAIpQLSd5BmQeM3iJZP4BWoFa3cN4If96Sh51I7U25qzpdE5l89iyNA';
const BUG_FORM_ID = '1FAIpQLSf0GzFM47jGFXkwXQ9szJ3HsJl37-qE0TJmHDz1rZYpWxCCjQ';
const VIDEO_ENTRY_ID = 'entry.1153529868';
const BUG_ENTRY_ID = 'entry.1541127783';

export async function submitVideoFeedback(wantsVideos) {
  try {
    const formData = new URLSearchParams();
    formData.append(VIDEO_ENTRY_ID, wantsVideos ? "Yes, I'd watch that" : 'Not really interested');

    const response = await fetch(`https://docs.google.com/forms/d/e/${VIDEO_FORM_ID}/formResponse`, {
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

export async function submitBugReport(message) {
  try {
    const formData = new URLSearchParams();
    formData.append(BUG_ENTRY_ID, message);

    const response = await fetch(`https://docs.google.com/forms/d/e/${BUG_FORM_ID}/formResponse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString(),
    });

    console.log('[BugReport] Status:', response.status);
  } catch (e) {
    console.log('[BugReport] Error:', e.message);
  }
}