"use client";

import type { LucideIcon } from "lucide-react";
import { Activity, ClipboardCheck, Droplets, Info, LayoutDashboard, Menu, ShieldBan, Skull, createLucideIcon } from "lucide-react";

const LighthouseIcon = createLucideIcon("lighthouse", [
  ["path", { d: "M10 22V8l2-6 2 6v14", key: "tower" }],
  ["path", { d: "M7 22h10", key: "base" }],
  ["path", { d: "M9 12h6", key: "band1" }],
  ["path", { d: "M9 16h6", key: "band2" }],
  ["circle", { cx: "12", cy: "5", r: "1.5", key: "light" }],
  ["path", { d: "M6 4l3.5 1M18 4l-3.5 1", key: "beams" }],
]);
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "./theme-toggle";

const NAV_ITEMS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/stability-index", label: "Stability Index", icon: LighthouseIcon },
  { href: "/risk-lab", label: "Risk Lab", icon: ClipboardCheck },
  { href: "/peg-tracker", label: "Peg Tracker", icon: Activity },
  { href: "/blacklist", label: "Freeze Tracker", icon: ShieldBan },
  { href: "/liquidity", label: "Liquidity", icon: Droplets },
  { href: "/cemetery", label: "Cemetery", icon: Skull },
  { href: "/about", label: "About", icon: Info },
];

export function Header() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container mx-auto flex h-14 items-center justify-between px-4">
        <div className="flex items-center gap-4">
          <Link href="/" className="flex items-center gap-3 font-semibold">
            <Image src="/pharos-icon.png" alt="Pharos" width={32} height={32} className="rounded-lg" priority />
            <span className="text-lg font-mono uppercase tracking-[0.2em]">PHAROS</span>
          </Link>
          {/* Desktop nav */}
          <div className="hidden sm:flex items-center gap-4">
            <div className="h-5 w-px bg-border" />
            <nav aria-label="Main navigation" className="flex items-center gap-1">
              {NAV_ITEMS.map((item) => {
                const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={isActive ? "page" : undefined}
                    className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none ${
                      isActive
                        ? "bg-accent text-foreground font-medium"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>

          {/* Mobile hamburger */}
          <div className="sm:hidden">
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm">
                  <Menu className="h-4 w-4" />
                  <span className="sr-only">Menu</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {NAV_ITEMS.map((item) => {
                  const Icon = item.icon;
                  return (
                    <DropdownMenuItem key={item.href} asChild>
                      <Link href={item.href} className="flex items-center gap-2">
                        <Icon className="h-4 w-4" />
                        {item.label}
                      </Link>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <ThemeToggle />
      </div>
    </header>
  );
}
