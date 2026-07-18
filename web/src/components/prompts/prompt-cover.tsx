import { ImageOff } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

export function PromptCover({ src, alt, className, imageClassName }: { src: string; alt: string; className?: string; imageClassName?: string }) {
    const [failedSrc, setFailedSrc] = useState("");

    return (
        <div className={cn("relative overflow-hidden bg-stone-100 dark:bg-stone-900", className)}>
            {src && failedSrc !== src ? (
                <img src={src} alt={alt} loading="lazy" decoding="async" className={cn("h-full w-full object-cover", imageClassName)} onError={() => setFailedSrc(src)} />
            ) : (
                <div className="flex h-full min-h-24 w-full flex-col items-center justify-center gap-2 bg-[radial-gradient(#d6d3d1_1px,transparent_1px)] [background-size:12px_12px] text-stone-400 dark:bg-[radial-gradient(#44403c_1px,transparent_1px)] dark:text-stone-500">
                    <ImageOff className="size-5" />
                    <span className="text-xs">暂无预览图</span>
                </div>
            )}
        </div>
    );
}
