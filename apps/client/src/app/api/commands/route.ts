import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const supabase = getServiceClient();
    const { type, payload } = await request.json();

    if (!type) {
      return NextResponse.json({ error: "type is required" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("commands")
      .insert({ type, payload: payload || {} })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json(data, { status: 201 });
  } catch (error) {
    console.error("Error creating command:", error);
    return NextResponse.json({ error: "Failed to create command" }, { status: 500 });
  }
}
