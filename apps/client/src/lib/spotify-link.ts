/**
 * Extract Spotify track ID from a URL like https://open.spotify.com/track/ABC123
 */
function extractSpotifyTrackId(url: string): string | null {
  try {
    const u = new URL(url);
    const match = u.pathname.match(/\/track\/([a-zA-Z0-9]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Open a Spotify URL, preferring the native app via spotify: URI.
 * On mobile, tries the native URI first with a fallback to web.
 * On desktop, opens web URL directly.
 */
export function openSpotify(url: string) {
  const trackId = extractSpotifyTrackId(url);
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

  if (trackId && isMobile) {
    const appUri = `spotify:track:${trackId}`;
    const fallbackTimer = setTimeout(() => {
      window.open(url, "_blank", "noopener,noreferrer");
    }, 500);

    window.location.href = appUri;

    const onBlur = () => {
      clearTimeout(fallbackTimer);
      window.removeEventListener("blur", onBlur);
    };
    window.addEventListener("blur", onBlur);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
