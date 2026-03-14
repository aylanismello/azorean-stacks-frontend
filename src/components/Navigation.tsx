"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useRef, useEffect } from "react";
import { useAuth } from "./AuthProvider";
import { useSpotify } from "./SpotifyProvider";
import { useTheme } from "./ThemeProvider";

const links = [
  { href: "/stacks", label: "Stacks", icon: "◉" },
  { href: "/approved", label: "Tracks", icon: "✓" },
  { href: "/seeds", label: "Seeds", icon: "◎" },
  { href: "/episodes", label: "Episodes", icon: "▶" },
  { href: "/curators", label: "Curators", icon: "♫" },
  { href: "/stats", label: "Stats", icon: "▤" },
];

// Fewer tabs on mobile — Episodes + Stats move into More sheet
const mobileLinks = [
  { href: "/stacks", label: "Stacks", icon: "◉" },
  { href: "/", label: "Playing", icon: "▶" },
  { href: "/approved", label: "Tracks", icon: "✓" },
  { href: "/seeds", label: "Seeds", icon: "◎" },
];

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button
      onClick={toggle}
      className="w-8 h-8 rounded-full bg-surface-2 border border-surface-3 flex items-center justify-center text-muted hover:text-foreground hover:border-accent/40 transition-all"
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
    >
      {theme === "dark" ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" />
          <line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" />
          <line x1="21" y1="12" x2="23" y2="12" />
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}

function AccountMenu() {
  const { user, signOut } = useAuth();
  const spotify = useSpotify();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  if (!user) return null;

  const initial = (user.email?.[0] || "?").toUpperCase();

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen(!open)}
        className="w-8 h-8 rounded-full bg-surface-2 border border-surface-3 flex items-center justify-center text-xs font-medium text-muted hover:text-foreground hover:border-accent/40 transition-all"
        title="Account"
      >
        {initial}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-56 bg-surface-1 border border-surface-3 rounded-xl shadow-2xl overflow-hidden z-50">
          {/* User info */}
          <div className="px-4 py-3 border-b border-surface-2">
            <p className="text-xs text-muted truncate">{user.email}</p>
          </div>

          {/* Spotify connection */}
          <div className="px-2 py-2 border-b border-surface-2">
            {spotify.connected ? (
              <div className="flex items-center justify-between px-2 py-1.5">
                <div className="flex items-center gap-2">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="#1DB954">
                    <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
                  </svg>
                  <span className="text-xs text-green-400">Connected</span>
                </div>
                <button
                  onClick={() => { spotify.disconnect(); setOpen(false); }}
                  className="text-[11px] text-muted hover:text-red-400 transition-colors"
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <button
                onClick={() => { spotify.connect(); setOpen(false); }}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm text-foreground/80 hover:bg-surface-2 transition-colors"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="#1DB954">
                  <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
                </svg>
                Connect Spotify
              </button>
            )}
          </div>

          {/* Sign out */}
          <div className="px-2 py-2">
            <button
              onClick={() => { setOpen(false); signOut(); }}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm text-muted hover:text-red-400 hover:bg-surface-2 transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function Navigation() {
  const pathname = usePathname();

  // Don't show nav on login/signup pages
  if (pathname === "/login" || pathname === "/signup") return null;

  return (
    <>
      {/* Desktop: top bar */}
      <nav className="hidden md:flex items-center justify-between px-6 py-4 border-b border-surface-2">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          <span className="text-accent">the</span> stacks
        </Link>
        <div className="flex items-center gap-1">
          {links.map((link) => {
            const isActive = link.href === "/stacks"
              ? pathname.startsWith("/stacks")
              : pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-surface-2 text-foreground"
                    : "text-muted hover:text-foreground hover:bg-surface-1"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
          <div className="ml-3 border-l border-surface-3 pl-3 flex items-center gap-2">
            <ThemeToggle />
            <AccountMenu />
          </div>
        </div>
      </nav>

      {/* Mobile: bottom tab bar — sits below global player */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-surface-1/95 backdrop-blur-md border-t border-surface-3 flex justify-around py-1.5 px-1 safe-area-bottom">
        {mobileLinks.map((link) => {
          const isActive = link.href === "/stacks"
            ? pathname.startsWith("/stacks")
            : link.href === "/"
            ? pathname === "/"
            : pathname === link.href;
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`flex flex-col items-center gap-0.5 px-4 py-1 rounded-lg text-[11px] transition-colors ${
                isActive
                  ? "text-accent"
                  : "text-muted"
              }`}
            >
              <span className="text-lg">{link.icon}</span>
              <span>{link.label}</span>
            </Link>
          );
        })}
        {/* Mobile account/more button */}
        <MobileAccountButton />
      </nav>
    </>
  );
}

function MobileAccountButton() {
  const { signOut } = useAuth();
  const spotify = useSpotify();
  const { theme, toggle } = useTheme();
  const [open, setOpen] = useState(false);

  // Lock body scroll when bottom sheet is open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = ""; };
    }
  }, [open]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-lg text-xs text-muted"
      >
        <span className="text-base">
          {spotify.connected ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="#1DB954">
              <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
            </svg>
          ) : "⚙"}
        </span>
        <span>More</span>
      </button>

      {/* Bottom sheet */}
      {open && (
        <div className="fixed inset-0 z-[100] flex items-end" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/60" />
          <div
            className="relative w-full bg-surface-1 rounded-t-2xl border-t border-surface-3 pb-safe-area-bottom"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Handle + close button */}
            <div className="flex items-center justify-between px-4 pt-3 pb-1">
              <div className="w-8" />
              <div className="w-10 h-1 rounded-full bg-surface-3" />
              <button
                onClick={() => setOpen(false)}
                className="w-8 h-8 flex items-center justify-center rounded-full text-muted hover:text-foreground hover:bg-surface-3 transition-colors"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <div className="px-4 pb-6 space-y-2">
              {/* Extra pages — only in mobile More sheet */}
              <Link
                href="/episodes"
                onClick={() => setOpen(false)}
                className="w-full flex items-center gap-3 px-4 py-3 bg-surface-2 rounded-xl text-sm text-foreground/80 hover:bg-surface-3 transition-colors"
              >
                <span className="text-base">▶</span>
                Episodes
              </Link>
              <Link
                href="/curators"
                onClick={() => setOpen(false)}
                className="w-full flex items-center gap-3 px-4 py-3 bg-surface-2 rounded-xl text-sm text-foreground/80 hover:bg-surface-3 transition-colors"
              >
                <span className="text-base">♫</span>
                Curators
              </Link>
              <Link
                href="/stats"
                onClick={() => setOpen(false)}
                className="w-full flex items-center gap-3 px-4 py-3 bg-surface-2 rounded-xl text-sm text-foreground/80 hover:bg-surface-3 transition-colors"
              >
                <span className="text-base">▤</span>
                Stats
              </Link>

              {/* Theme toggle */}
              <button
                onClick={() => { toggle(); setOpen(false); }}
                className="w-full flex items-center gap-3 px-4 py-3 bg-surface-2 rounded-xl text-sm text-foreground/80 hover:bg-surface-3 transition-colors"
              >
                <span className="text-base">{theme === "dark" ? "☀" : "☾"}</span>
                {theme === "dark" ? "Light mode" : "Dark mode"}
              </button>

              {/* Spotify */}
              {spotify.connected ? (
                <div className="flex items-center justify-between px-4 py-3 bg-surface-2 rounded-xl">
                  <div className="flex items-center gap-2.5">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="#1DB954">
                      <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
                    </svg>
                    <span className="text-sm text-green-400">Spotify Connected</span>
                  </div>
                  <button
                    onClick={() => { spotify.disconnect(); setOpen(false); }}
                    className="text-xs text-muted hover:text-red-400 transition-colors"
                  >
                    Disconnect
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => { spotify.connect(); setOpen(false); }}
                  className="w-full flex items-center gap-3 px-4 py-3 bg-surface-2 rounded-xl text-sm text-foreground/80 hover:bg-surface-3 transition-colors"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="#1DB954">
                    <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
                  </svg>
                  Connect Spotify
                </button>
              )}

              {/* Sign out */}
              <button
                onClick={() => { setOpen(false); signOut(); }}
                className="w-full flex items-center gap-3 px-4 py-3 bg-surface-2 rounded-xl text-sm text-red-400/80 hover:text-red-400 hover:bg-surface-3 transition-colors"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
                Sign out
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
