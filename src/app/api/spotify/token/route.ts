import { NextResponse, type NextRequest } from "next/server";

const TOKEN_URL = "https://accounts.spotify.com/api/token";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const refreshToken = request.cookies.get("spotify_refresh_token")?.value;

  if (!refreshToken) {
    return NextResponse.json({ connected: false }, { status: 200 });
  }

  const accessToken = request.cookies.get("spotify_access_token")?.value;
  const expiresStr = request.cookies.get("spotify_token_expires")?.value;
  const expiresAt = expiresStr ? Number(expiresStr) : 0;

  // If token is still valid (with 60s buffer), return it
  if (accessToken && expiresAt > Date.now() + 60_000) {
    return NextResponse.json({
      connected: true,
      access_token: accessToken,
      expires_at: expiresAt,
    });
  }

  // Refresh the token
  const clientId = process.env.SPOTIFY_CLIENT_ID!;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET!;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
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
    // Refresh token is invalid — clear everything
    const response = NextResponse.json({ connected: false }, { status: 200 });
    response.cookies.delete("spotify_refresh_token");
    response.cookies.delete("spotify_access_token");
    response.cookies.delete("spotify_token_expires");
    return response;
  }

  const tokens = await tokenRes.json();
  const newExpiresAt = Date.now() + (tokens.expires_in || 3600) * 1000;

  const response = NextResponse.json({
    connected: true,
    access_token: tokens.access_token,
    expires_at: newExpiresAt,
  });

  response.cookies.set("spotify_access_token", tokens.access_token, {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: tokens.expires_in || 3600,
    path: "/",
  });

  response.cookies.set("spotify_token_expires", String(newExpiresAt), {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: tokens.expires_in || 3600,
    path: "/",
  });

  // Update refresh token if Spotify sent a new one
  if (tokens.refresh_token) {
    response.cookies.set("spotify_refresh_token", tokens.refresh_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 365,
      path: "/",
    });
  }

  return response;
}
