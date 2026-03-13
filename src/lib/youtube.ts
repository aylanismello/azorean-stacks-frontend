/**
 * Extract video ID from a YouTube URL.
 * Handles youtube.com/watch?v=, youtu.be/, youtube.com/shorts/, etc.
 */
function extractVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split("/")[0];
    if (u.searchParams.has("v")) return u.searchParams.get("v");
    const shorts = u.pathname.match(/\/shorts\/([^/?]+)/);
    if (shorts) return shorts[1];
  } catch {}
  return null;
}

/**
 * Open a YouTube URL, preferring the native app.
 * On mobile, tries vnd.youtube:// deep link first, falls back to web.
 * On desktop, opens the web URL directly.
 */
export function openYouTube(url: string) {
  const videoId = extractVideoId(url);
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

  if (videoId && isMobile) {
    // Try app deep link — if it fails (app not installed), fall back to web
    const appUrl = `vnd.youtube://${videoId}`;
    const fallbackTimer = setTimeout(() => {
      window.open(url, "_blank", "noopener,noreferrer");
    }, 500);

    window.location.href = appUrl;

    // If the app opened, the page will blur — cancel the fallback
    const onBlur = () => {
      clearTimeout(fallbackTimer);
      window.removeEventListener("blur", onBlur);
    };
    window.addEventListener("blur", onBlur);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
