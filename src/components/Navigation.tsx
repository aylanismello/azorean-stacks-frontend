"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Stack", icon: "◉" },
  { href: "/approved", label: "Approved", icon: "✓" },
  { href: "/seeds", label: "Seeds", icon: "◎" },
  { href: "/stats", label: "Stats", icon: "▤" },
];

export function Navigation() {
  const pathname = usePathname();

  return (
    <>
      {/* Desktop: top bar */}
      <nav className="hidden md:flex items-center justify-between px-6 py-4 border-b border-surface-2">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          <span className="text-accent">the</span> stacks
        </Link>
        <div className="flex gap-1">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                pathname === link.href
                  ? "bg-surface-2 text-white"
                  : "text-muted hover:text-white hover:bg-surface-1"
              }`}
            >
              {link.label}
            </Link>
          ))}
        </div>
      </nav>

      {/* Mobile: bottom tab bar */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-surface-1/95 backdrop-blur-md border-t border-surface-3 flex justify-around py-2 px-2 safe-area-bottom">
        {links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={`flex flex-col items-center gap-0.5 px-4 py-1.5 rounded-lg text-xs transition-colors ${
              pathname === link.href
                ? "text-accent"
                : "text-muted"
            }`}
          >
            <span className="text-base">{link.icon}</span>
            <span>{link.label}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}
