import { Copy } from "lucide-react";
import type { ReactNode } from "react";
import { Button, Card, Tag } from "antd";

import { formatPromptDate, type Prompt } from "@/services/api/prompts";
import { cn } from "@/lib/utils";
import { PromptCover } from "./prompt-cover";

export function PromptCard({
    item,
    onOpen,
    onCopy,
    actionLabel = "复制",
    actionIcon = <Copy className="size-3.5" />,
    actionType = "text",
    extraAction,
}: {
    item: Prompt;
    onOpen: () => void;
    onCopy: () => void;
    actionLabel?: string;
    actionIcon?: ReactNode;
    actionType?: "text" | "primary";
    extraAction?: ReactNode;
}) {
    return (
        <Card
            hoverable
            className="overflow-hidden [contain-intrinsic-size:0_160px] [content-visibility:auto] sm:[contain-intrinsic-size:0_400px]"
            styles={{ body: { padding: 0 } }}
        >
            <div className="flex min-h-40 sm:block sm:min-h-0">
                <button type="button" className="w-28 shrink-0 text-left sm:block sm:w-full" onClick={onOpen}>
                    <PromptCover src={item.coverUrl} alt={item.title} className="h-full min-h-40 sm:aspect-[4/3] sm:min-h-0" />
                </button>
                <div className="flex min-w-0 flex-1 flex-col">
                    <button type="button" className="block w-full flex-1 text-left" onClick={onOpen}>
                        <div className="p-3 pb-2 sm:p-4 sm:pb-3">
                            <div className="flex items-start justify-between gap-3">
                                <h2 className="line-clamp-2 text-sm font-semibold text-stone-950 dark:text-stone-100 sm:line-clamp-1">{item.title}</h2>
                                <span className="hidden shrink-0 text-xs text-stone-400 dark:text-stone-500 sm:block">{formatPromptDate(item.updatedAt)}</span>
                            </div>
                            <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-stone-600 dark:text-stone-400 sm:mt-2 sm:line-clamp-3">{item.prompt}</p>
                            <div className="mt-2 flex flex-wrap items-center gap-1 sm:mt-3 sm:gap-1.5">
                                {item.tags.slice(0, 3).map((tag, index) => (
                                    <Tag key={tag} className={cn("m-0 text-[11px]", index > 1 && "hidden sm:inline-flex")}>
                                        {tag}
                                    </Tag>
                                ))}
                                {item.tags.length > 2 ? <span className="text-[11px] text-stone-400 sm:hidden">+{item.tags.length - 2}</span> : null}
                                {item.tags.length > 3 ? <span className="hidden text-[11px] text-stone-400 sm:inline">+{item.tags.length - 3}</span> : null}
                            </div>
                        </div>
                    </button>
                    <div className="flex items-center gap-2 px-3 pb-3 sm:px-4 sm:pb-4">
                        <Button block={actionType === "primary"} type={actionType} size="small" icon={actionIcon} onClick={onCopy}>
                            {actionLabel}
                        </Button>
                        {extraAction}
                    </div>
                </div>
            </div>
        </Card>
    );
}
