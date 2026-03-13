"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase-browser";

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const supabase = createClient();

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (error) {
      setError(error.message);
    } else {
      setSuccess(true);
    }
    setLoading(false);
  };

  const handleGoogleSignup = async () => {
    setLoading(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    if (error) {
      setError(error.message);
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="w-full max-w-sm space-y-4 text-center">
          <h1 className="text-2xl font-bold text-white">Check your email</h1>
          <p className="text-neutral-400">
            We sent a confirmation link to{" "}
            <span className="text-white">{email}</span>. Click it to activate
            your account.
          </p>
          <a
            href="/login"
            className="inline-block text-sm text-[#d4a053] hover:underline"
          >
            Back to login
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight text-white">
            The Stacks
          </h1>
          <p className="mt-2 text-sm text-neutral-400">
            Start digging
          </p>
        </div>

        {error && (
          <div className="rounded-lg bg-red-900/30 border border-red-800/50 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        <form onSubmit={handleSignup} className="space-y-4">
          <div>
            <label htmlFor="email" className="sr-only">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              className="w-full rounded-lg bg-neutral-900 border border-neutral-700 px-4 py-3 text-white placeholder:text-neutral-500 focus:border-[#d4a053] focus:outline-none focus:ring-1 focus:ring-[#d4a053]"
            />
          </div>
          <div>
            <label htmlFor="password" className="sr-only">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password (min 8 characters)"
              className="w-full rounded-lg bg-neutral-900 border border-neutral-700 px-4 py-3 text-white placeholder:text-neutral-500 focus:border-[#d4a053] focus:outline-none focus:ring-1 focus:ring-[#d4a053]"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-[#d4a053] px-4 py-3 font-medium text-black hover:bg-[#c4903f] disabled:opacity-50 transition-colors"
          >
            {loading ? "Creating account..." : "Create account"}
          </button>
        </form>

        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-neutral-700" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-[#0a0a0a] px-2 text-neutral-500">or</span>
          </div>
        </div>

        <button
          onClick={handleGoogleSignup}
          disabled={loading}
          className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-3 font-medium text-white hover:bg-neutral-800 disabled:opacity-50 transition-colors"
        >
          Continue with Google
        </button>

        <p className="text-center text-sm text-neutral-500">
          Already have an account?{" "}
          <a
            href="/login"
            className="text-[#d4a053] hover:underline"
          >
            Sign in
          </a>
        </p>
      </div>
    </div>
  );
}
