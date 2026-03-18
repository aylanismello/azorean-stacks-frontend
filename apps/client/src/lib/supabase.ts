import { createClient, SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Use `any` for DB generic since we don't have generated types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UntypedClient = SupabaseClient<any, "public", any>;

// Client-side: anon key, safe for browser (legacy — prefer createBrowserClient for auth)
export const supabase: UntypedClient = createClient(supabaseUrl, supabaseAnonKey);

// Server-side only: service role key for agent/API operations (bypasses RLS)
let _serviceClient: UntypedClient | null = null;
export function getServiceClient(): UntypedClient {
  if (_serviceClient) return _serviceClient;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  }
  _serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    global: {
      fetch: ((url: Parameters<typeof fetch>[0], options: Parameters<typeof fetch>[1] = {}) => {
        return fetch(url, { ...options, cache: "no-store" as RequestCache });
      }) as typeof fetch,
    },
  });
  return _serviceClient;
}
