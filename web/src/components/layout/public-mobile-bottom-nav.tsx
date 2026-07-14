import { ImagePlus, Images, Maximize2 } from "lucide-react";
import { Link, useLocation } from "react-router-dom";

import { appMode } from "@/lib/app-mode";
import { cn } from "@/lib/utils";

const items = [
    { to: "/image", label: "生图", icon: ImagePlus },
    { to: "/canvas", label: "画布", icon: Maximize2 },
    { to: "/assets", label: "素材", icon: Images },
] as const;

export function PublicMobileBottomNav() {
    const { pathname } = useLocation();

    if (appMode !== "public" || /^\/canvas\/[^/]+/.test(pathname)) return null;

    return (
        <nav
            aria-label="主要导航"
            className="shrink-0 border-t border-stone-200 bg-background/95 backdrop-blur-xl md:hidden dark:border-stone-800"
            style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        >
            <div className="mx-auto grid h-16 max-w-md grid-cols-3 px-3">
                {items.map(({ to, label, icon: Icon }) => {
                    const active = pathname === to || (to === "/canvas" && pathname.startsWith("/canvas"));
                    return (
                        <Link
                            key={to}
                            to={to}
                            aria-current={active ? "page" : undefined}
                            className={cn(
                                "mx-1 flex min-h-11 min-w-11 flex-col items-center justify-center gap-1 rounded-xl text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-500 active:bg-stone-100 dark:active:bg-stone-800",
                                active ? "font-medium text-stone-950 dark:text-stone-100" : "text-stone-500 dark:text-stone-400",
                            )}
                        >
                            <Icon className="size-5" aria-hidden="true" />
                            <span>{label}</span>
                        </Link>
                    );
                })}
            </div>
        </nav>
    );
}
