import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete("spotify_refresh_token");
  response.cookies.delete("spotify_access_token");
  response.cookies.delete("spotify_token_expires");
  return response;
}
