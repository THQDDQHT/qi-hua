import type { ReactNode } from "react";

import { AgentPanel } from "@/components/agent/agent-panel";
import { AppTopNav } from "@/components/layout/app-top-nav";
import { LocalDataNotice } from "@/components/layout/local-data-notice";
import { PublicMobileBottomNav } from "@/components/layout/public-mobile-bottom-nav";
import { appCapabilities } from "@/lib/app-mode";

export default function UserLayout({ children }: { children: ReactNode }) {
    return (
        <div className="flex h-dvh overflow-hidden bg-background text-foreground">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <AppTopNav />
                <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
                <PublicMobileBottomNav />
            </div>
            {appCapabilities.agent ? <AgentPanel /> : null}
            <LocalDataNotice />
        </div>
    );
}
