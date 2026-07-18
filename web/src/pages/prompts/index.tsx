import { FolderPlus, Search } from "lucide-react";
import { type UIEvent, useDeferredValue, useEffect, useState } from "react";
import { App, Button, Empty, Input, Select, Spin } from "antd";

import { PromptCard } from "@/components/prompts/prompt-card";
import { usePromptList } from "@/components/prompts/use-prompt-list";
import { PromptDetailDialog } from "./components/prompt-detail-dialog";
import { useCopyText } from "@/hooks/use-copy-text";
import { useAssetStore } from "@/stores/use-asset-store";
import { ALL_PROMPTS_OPTION, type Prompt } from "@/services/api/prompts";

export default function PromptsPage() {
    const { message } = App.useApp();
    const [titleKeyword, setTitleKeyword] = useState("");
    const [selectedTags, setSelectedTags] = useState<string[]>([]);
    const [selectedCategory, setSelectedCategory] = useState(ALL_PROMPTS_OPTION);
    const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);
    const deferredKeyword = useDeferredValue(titleKeyword);
    const addAsset = useAssetStore((state) => state.addAsset);
    const copyText = useCopyText();
    const { query, items: promptItems, tags: promptTags, categories: promptCategoryOptions, total: totalPrompts } = usePromptList({ keyword: deferredKeyword, tags: selectedTags, category: selectedCategory });

    useEffect(() => {
        if (query.isError) {
            message.error(query.error instanceof Error ? query.error.message : "获取提示词失败");
        }
    }, [message, query.error, query.isError]);

    const savePromptAsset = (item: Prompt) => {
        addAsset({ kind: "text", title: item.title, coverUrl: item.coverUrl, tags: item.tags, source: item.category, data: { content: item.prompt }, metadata: { source: "prompt-library", promptId: item.id, githubUrl: item.githubUrl } });
        message.success("已加入我的素材");
    };

    const handleListScroll = (event: UIEvent<HTMLDivElement>) => {
        const target = event.currentTarget;
        if (query.hasNextPage && !query.isFetchingNextPage && target.scrollTop + target.clientHeight >= target.scrollHeight - 160) {
            void query.fetchNextPage();
        }
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-stone-800 dark:text-stone-100">
            <main
                className="min-h-0 flex-1 overflow-y-auto bg-background bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] px-4 py-5 [background-size:16px_16px] dark:bg-[radial-gradient(rgba(245,245,244,.16)_1px,transparent_1px)] sm:px-6 sm:py-8"
                onScroll={handleListScroll}
            >
                <div className="pb-5 sm:pb-8">
                    <div className="mx-auto max-w-5xl text-center">
                        <h1 className="text-2xl font-semibold tracking-tight text-stone-950 dark:text-stone-100 sm:text-4xl">提示词中心</h1>
                        <p className="mt-2 text-xs text-stone-500 dark:text-stone-400 sm:mt-3 sm:text-sm">共 {totalPrompts} 条提示词，按标题、标签与分类快速查找灵感。</p>
                    </div>
                    {query.isLoading ? (
                        <div className="flex h-60 items-center justify-center">
                            <Spin />
                        </div>
                    ) : null}
                    {!query.isLoading ? (
                        <>
                            <div className="mx-auto mt-5 grid w-full max-w-5xl gap-2 sm:mt-8 sm:grid-cols-[minmax(260px,1fr)_220px_minmax(260px,1fr)]">
                                <Input size="large" prefix={<Search className="size-4 text-stone-400" />} value={titleKeyword} placeholder="搜索标题或提示词" onChange={(event) => setTitleKeyword(event.target.value)} />
                                <Select
                                    size="large"
                                    showSearch
                                    optionFilterProp="label"
                                    value={selectedCategory}
                                    options={promptCategoryOptions.map((category) => ({ label: category, value: category }))}
                                    onChange={setSelectedCategory}
                                    aria-label="筛选分类"
                                />
                                <Select
                                    size="large"
                                    mode="multiple"
                                    allowClear
                                    showSearch
                                    maxTagCount="responsive"
                                    optionFilterProp="label"
                                    value={selectedTags}
                                    options={promptTags.filter((tag) => tag !== ALL_PROMPTS_OPTION).map((tag) => ({ label: tag, value: tag }))}
                                    onChange={setSelectedTags}
                                    placeholder="全部标签"
                                    aria-label="筛选标签"
                                />
                            </div>
                        </>
                    ) : null}
                </div>

                {!query.isLoading ? (
                    <div>
                        <div className="mx-auto grid max-w-7xl gap-3 sm:grid-cols-2 sm:gap-5 xl:grid-cols-3 2xl:grid-cols-4">
                            {promptItems.map((item) => (
                                <PromptCard
                                    key={item.id}
                                    item={item}
                                    onOpen={() => setSelectedPrompt(item)}
                                    onCopy={() => copyText(item.prompt, "提示词已复制")}
                                    extraAction={
                                        <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => savePromptAsset(item)}>
                                            <span className="sm:hidden">收藏</span>
                                            <span className="hidden sm:inline">加入我的素材</span>
                                        </Button>
                                    }
                                />
                            ))}
                        </div>
                        {promptItems.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有找到匹配的提示词" className="py-16" /> : null}
                        <div className="mx-auto mt-6 max-w-7xl text-center text-xs text-stone-500 dark:text-stone-400">
                            {query.isFetchingNextPage ? "加载中..." : query.hasNextPage ? "继续向下滚动加载更多" : promptItems.length > 0 ? "已经到底了" : null}
                        </div>
                    </div>
                ) : null}
            </main>

            <PromptDetailDialog prompt={selectedPrompt} onClose={() => setSelectedPrompt(null)} onCopy={(prompt) => copyText(prompt, "提示词已复制")} onSaveAsset={savePromptAsset} />
        </div>
    );
}
