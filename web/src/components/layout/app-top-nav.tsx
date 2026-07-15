import { Bot, Menu } from "lucide-react";
import { Button, Tooltip } from "antd";
import { Link, useLocation } from "react-router-dom";

import { navigationTools, type NavigationToolSlug } from "@/constant/navigation-tools";
import { AppConfigModal } from "@/components/layout/app-config-modal";
import { MobileNavDrawer } from "@/components/layout/mobile-nav-drawer";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { appCapabilities } from "@/lib/app-mode";
import { cn } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";
import { useAgentStore } from "@/stores/use-agent-store";
import { useConfigStore } from "@/stores/use-config-store";

export function AppTopNav() {
    const { pathname } = useLocation();
    const [mobileNavOpen, setMobileNavOpen] = useState(false);
    const autoConnectRef = useRef(false);
    const agentToken = useAgentStore((state) => state.token);
    const agentEnabled = useAgentStore((state) => state.enabled);
    const agentConnected = useAgentStore((state) => state.connected);
    const connectAgent = useAgentStore((state) => state.connectAgent);
    const togglePanel = useAgentStore((state) => state.togglePanel);
    const panelOpen = useAgentStore((state) => state.panelOpen);
    const hideHeader = /^\/canvas\/[^/]+/.test(pathname);
    const slug = pathname.split("/").filter(Boolean)[0];
    const activeToolSlug = navigationTools.some((tool) => tool.slug === slug) ? (slug as NavigationToolSlug) : undefined;

    useEffect(() => {
        if (!appCapabilities.agent || autoConnectRef.current || agentEnabled || agentConnected || !agentToken.trim()) return;
        autoConnectRef.current = true;
        connectAgent();
    }, [agentConnected, agentEnabled, agentToken, connectAgent]);

    return (
        <>
            {!hideHeader ? (
                <header className="sticky top-0 z-20 shrink-0 border-b border-stone-200 bg-background/90 pt-[env(safe-area-inset-top)] backdrop-blur-xl dark:border-stone-800">
                    <div className="mx-auto flex h-14 max-w-7xl items-stretch justify-between gap-3 px-3 sm:px-4 md:gap-5 md:px-6">
                        <div className="flex min-w-0 items-center">
                            <Link to="/" className="flex h-full shrink-0 items-center gap-2 text-sm font-semibold leading-none tracking-tight text-stone-950 transition hover:text-stone-600 dark:text-stone-100 dark:hover:text-stone-300">
                                <span
                                    className="size-5 shrink-0 bg-current"
                                    style={{
                                        mask: "url(/logo.svg) center / contain no-repeat",
                                        WebkitMask: "url(/logo.svg) center / contain no-repeat",
                                    }}
                                />
                                <span className="text-base font-medium">啟画</span>
                            </Link>

                            <button
                                type="button"
                                className="ml-2 inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-stone-600 transition hover:text-stone-950 active:bg-stone-100 md:hidden dark:text-stone-300 dark:hover:text-white dark:active:bg-stone-800"
                                onClick={() => setMobileNavOpen(true)}
                                aria-label="打开导航菜单"
                                title="导航菜单"
                            >
                                <Menu className="size-5" />
                            </button>

                            <nav className="hide-scrollbar ml-8 hidden h-14 min-w-0 items-center gap-7 overflow-x-auto md:flex">
                                {navigationTools.map((tool) => {
                                    const Icon = tool.icon;
                                    const active = tool.slug === activeToolSlug;
                                    return (
                                        <Link
                                            key={tool.slug}
                                            to={`/${tool.slug}`}
                                            aria-current={active ? "page" : undefined}
                                            className={cn(
                                                "relative flex h-14 shrink-0 items-center gap-2 text-sm leading-6 transition after:absolute after:inset-x-0 after:bottom-0 after:h-px",
                                                active
                                                    ? "font-medium text-stone-950 after:bg-stone-950 dark:text-stone-100 dark:after:bg-stone-100"
                                                    : "text-stone-500 after:bg-transparent hover:text-stone-950 dark:text-stone-400 dark:hover:text-stone-100",
                                            )}
                                        >
                                            <Icon className="size-4" />
                                            <span className="truncate">{tool.label}</span>
                                        </Link>
                                    );
                                })}
                            </nav>
                        </div>

                        <div className="my-auto flex h-9 min-w-0 items-center justify-end gap-2 justify-self-end whitespace-nowrap">
                            {appCapabilities.agent ? (
                                <>
                                    <CodexStatusButton />
                                    <Tooltip title={panelOpen ? "收起 Agent" : "打开 Agent"}>
                                        <Button type="text" shape="circle" className="!h-11 !w-11 !min-w-11 md:!h-8 md:!w-8 md:!min-w-8" icon={<Bot className="size-4" />} onClick={togglePanel} aria-label="打开 Agent" />
                                    </Tooltip>
                                </>
                            ) : null}
                            <UserStatusActions showConfig={appCapabilities.channelConfig} minimal={!appCapabilities.channelConfig} />
                        </div>
                    </div>
                </header>
            ) : null}

            <MobileNavDrawer open={mobileNavOpen} activeToolSlug={activeToolSlug} onClose={() => setMobileNavOpen(false)} />
            {appCapabilities.channelConfig ? <AppConfigModal /> : null}
        </>
    );
}

function CodexStatusButton() {
    const connected = useAgentStore((state) => state.connected);
    const enabled = useAgentStore((state) => state.enabled);
    const activity = useAgentStore((state) => state.activity);
    const connectError = useAgentStore((state) => state.connectError);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const color = connectError ? "#dc2626" : connected ? "#16a34a" : enabled ? "#d97706" : "currentColor";
    const title = connectError || (connected ? activity || "Codex 已连接" : enabled ? "Codex 连接中" : "Codex 未连接");
    return (
        <Tooltip title={title}>
            <Button type="text" shape="circle" className="relative !h-11 !w-11 !min-w-11 md:!h-8 md:!w-8 md:!min-w-8" onClick={() => openConfigDialog(false, "codex")} aria-label="Codex 连接状态">
                <span className="mx-auto block size-4" style={{ background: color, WebkitMask: "url(/icons/openai.svg) center / contain no-repeat", mask: "url(/icons/openai.svg) center / contain no-repeat" }} />
                <span className="absolute right-1 top-1 size-2 rounded-full border border-background" style={{ background: color }} />
            </Button>
        </Tooltip>
    );
}
