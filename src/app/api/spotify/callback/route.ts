import { NextResponse, type NextRequest } from "next/server";

const TOKEN_URL = "https://accounts.spotify.com/api/token";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const appUrl = process.env.APP_URL || new URL(request.url).origin;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");
  const storedState = request.cookies.get("spotify_auth_state")?.value;

  if (error || !code || !state || state !== storedState) {
    return NextResponse.redirect(`${appUrl}/?spotify_error=${error || "state_mismatch"}`);
  }

  const clientId = process.env.SPOTIFY_CLIENT_ID!;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET!;
  const redirectUri = process.env.SPOTIFY_REDIRECT_URI
    || `${new URL(request.url).origin}/api/spotify/callback`;

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });

  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: body.toString(),
  });

  if (!tokenRes.ok) {
    return NextResponse.redirect(`${appUrl}/?spotify_error=token_exchange_failed`);
  }

  const tokens = await tokenRes.json();

  const response = NextResponse.redirect(appUrl);

  // Store refresh token in httpOnly cookie (secure)
  response.cookies.set("spotify_refresh_token", tokens.refresh_token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365, // 1 year
    path: "/",
  });

  // Store access token in a regular cookie so client can read it for the SDK
  response.cookies.set("spotify_access_token", tokens.access_token, {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: tokens.expires_in || 3600,
    path: "/",
  });

  // Store expiry time
  const expiresAt = Date.now() + (tokens.expires_in || 3600) * 1000;
  response.cookies.set("spotify_token_expires", String(expiresAt), {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: tokens.expires_in || 3600,
    path: "/",
  });

  // Clear auth state cookie
  response.cookies.delete("spotify_auth_state");

  return response;
}
