import { Image, Input, Text, View } from "@tarojs/components";
import Taro, { useDidShow, useShareAppMessage } from "@tarojs/taro";
import { useState } from "react";
import { loadPromptLibrary, promptCoverUrl, type PromptItem } from "@/services/prompts";
import { usePendingPromptStore } from "@/stores/use-pending-prompt-store";
import "./index.css";

export default function PromptsPage() {
  const [items, setItems] = useState<PromptItem[] | null>(null);
  const [error, setError] = useState("");
  const [keyword, setKeyword] = useState("");
  const [activeCategory, setActiveCategory] = useState("全部");

  useDidShow(() => {
    if (items === null) void load();
  });

  useShareAppMessage(() => ({ title: "啟画提示词库", path: "/pages/prompts/index" }));

  async function load(force = false) {
    setError("");
    try {
      setItems(await loadPromptLibrary(force));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "提示词库加载失败");
    }
  }

  const categories = ["全部", ...new Set((items ?? []).map((item) => item.category))];
  const normalizedKeyword = keyword.trim().toLowerCase();
  const filtered = (items ?? []).filter((item) => {
    if (activeCategory !== "全部" && item.category !== activeCategory) return false;
    if (!normalizedKeyword) return true;
    return (
      item.title.toLowerCase().includes(normalizedKeyword) ||
      item.prompt.toLowerCase().includes(normalizedKeyword) ||
      item.tags.some((tag) => tag.toLowerCase().includes(normalizedKeyword))
    );
  });

  function handleUse(item: PromptItem) {
    Taro.showActionSheet({ itemList: ["使用提示词", "复制提示词"] })
      .then(({ tapIndex }) => {
        if (tapIndex === 0) {
          usePendingPromptStore.getState().setPendingPrompt(item.prompt);
          Taro.showToast({ title: "提示词已填入", icon: "none" });
          setTimeout(() => Taro.switchTab({ url: "/pages/generate/index" }), 600);
        }
        if (tapIndex === 1) void Taro.setClipboardData({ data: item.prompt });
      })
      .catch(() => {});
  }

  return (
    <View className="page-body">
      <Input
        className="search-input"
        value={keyword}
        placeholder="搜索标题、提示词、标签"
        onInput={(event) => setKeyword(event.detail.value)}
      />

      {error && (
        <View className="empty-state">
          <View>{error}</View>
          <View className="retry-link" onClick={() => void load(true)}>
            点这里重试
          </View>
        </View>
      )}

      {!error && items === null && <View className="empty-state">加载中…</View>}

      {!error && items !== null && (
        <>
          <View className="category-row">
            {categories.map((category) => (
              <Text
                key={category}
                className={`category-chip${activeCategory === category ? " category-chip-active" : ""}`}
                onClick={() => setActiveCategory(category)}
              >
                {category}
              </Text>
            ))}
          </View>

          {filtered.length === 0 ? (
            <View className="empty-state">没有匹配的提示词</View>
          ) : (
            <View className="prompt-grid">
              {filtered.map((item) => (
                <View key={item.id} className="prompt-card card" onClick={() => handleUse(item)}>
                  <Image
                    className="prompt-cover"
                    src={promptCoverUrl(item.coverUrl)}
                    mode="aspectFill"
                    lazyLoad
                  />
                  <View className="prompt-meta">
                    <Text className="prompt-title">{item.title}</Text>
                    <Text className="prompt-tags text-secondary">{item.tags.join(" · ")}</Text>
                  </View>
                </View>
              ))}
            </View>
          )}
        </>
      )}
    </View>
  );
}
