import { Button, Image, Text, Textarea, View } from "@tarojs/components";
import Taro, { useDidShow, useShareAppMessage, useUnload } from "@tarojs/taro";
import { useRef, useState } from "react";
import * as api from "@/services/api";
import { persistTempFile } from "@/services/file-storage";
import { useConfigStore } from "@/stores/use-config-store";
import { usePendingPromptStore } from "@/stores/use-pending-prompt-store";
import { useGenerationStore, type Generation } from "@/stores/use-generation-store";
import {
  GENERATION_QUALITIES,
  GENERATION_SIZES,
  MAX_PROMPT_LENGTH,
  QUALITY_LABELS,
  SIZE_LABELS,
  type GenerationQuality,
  type GenerationSize,
} from "@/shared/generation-policy";
import { createId, formatDateTime } from "@/lib/utils";
import "./index.css";

const MAX_POLL_FAILURES = 3;

export default function GeneratePage() {
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState<GenerationSize>("auto");
  const [quality, setQuality] = useState<GenerationQuality>("auto");
  const [refImagePath, setRefImagePath] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const pollFailuresRef = useRef<Record<string, number>>({});

  const generations = useGenerationStore((state) => state.generations);
  const quota = useConfigStore((state) => state.quota);
  const generationInfo = useConfigStore((state) => state.generation);

  useDidShow(() => {
    const pending = usePendingPromptStore.getState().consumePendingPrompt();
    if (pending) {
      setPrompt((current) => (current.trim() ? `${current}\n${pending}` : pending));
      Taro.showToast({ title: "提示词已填入", icon: "none" });
    }
    if (!useConfigStore.getState().sessionReady) {
      void useConfigStore.getState().initSession();
    }
  });

  useUnload(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  });

  useShareAppMessage(() => ({ title: "啟画：一句话生成好图", path: "/pages/generate/index" }));

  function errorMessage(error: unknown, fallback: string) {
    return error instanceof Error ? error.message : fallback;
  }

  async function handleGenerate() {
    const trimmed = prompt.trim();
    if (!trimmed) {
      Taro.showToast({ title: "请输入提示词", icon: "none" });
      return;
    }
    if (generationInfo && !generationInfo.enabled) {
      Taro.showToast({ title: generationInfo.disabledReason ?? "生图服务暂不可用", icon: "none" });
      return;
    }
    if (submitting) return;

    setSubmitting(true);
    const generationId = createId();
    const generation: Generation = {
      id: generationId,
      mode: refImagePath ? "edit" : "text",
      prompt: trimmed,
      size,
      quality,
      ...(refImagePath ? { refImagePath } : {}),
      resultPaths: [],
      status: "pending",
      createdAt: Date.now(),
    };
    useGenerationStore.getState().addGeneration(generation);

    try {
      const input = { requestKey: generationId, prompt: trimmed, count: 1, size, quality };
      const result = refImagePath
        ? await api.submitEdit({ ...input, filePath: refImagePath })
        : await api.submitGeneration(input);
      pollFailuresRef.current[generationId] = 0;
      schedulePoll(result.taskId, generationId, result.pollAfterMs || 2000);
    } catch (error) {
      useGenerationStore.getState().updateGeneration(generationId, {
        status: "failed",
        error: errorMessage(error, "提交生成任务失败"),
      });
      void useConfigStore.getState().refreshQuota();
    } finally {
      setSubmitting(false);
    }
  }

  function schedulePoll(taskId: string, generationId: string, delay: number) {
    const timer = setTimeout(() => {
      void runPoll(taskId, generationId);
    }, delay);
    timersRef.current.push(timer);
  }

  async function runPoll(taskId: string, generationId: string) {
    const store = useGenerationStore.getState();
    try {
      const poll = await api.pollTask(taskId);
      if (poll.quota) useConfigStore.getState().setQuota(poll.quota);
      if (poll.status === "queued" || poll.status === "running") {
        schedulePoll(taskId, generationId, poll.pollAfterMs || 2000);
        return;
      }
      const items = (poll.results ?? []).filter((item) => item.status === "success" && item.image?.url);
      if (items.length === 0) {
        store.updateGeneration(generationId, {
          status: "failed",
          error: "生成未成功，请调整提示词后重试",
        });
        return;
      }
      const paths: string[] = [];
      for (const item of items) {
        try {
          paths.push(persistTempFile(await api.downloadResultFile(item.image!.url)));
        } catch {
          // 单张下载失败不阻断其他结果
        }
      }
      if (paths.length === 0) {
        store.updateGeneration(generationId, { status: "failed", error: "结果图下载失败，请重试" });
      } else {
        store.updateGeneration(generationId, { status: "success", resultPaths: paths });
      }
    } catch (error) {
      const failures = (pollFailuresRef.current[generationId] ?? 0) + 1;
      pollFailuresRef.current[generationId] = failures;
      if (failures < MAX_POLL_FAILURES) {
        schedulePoll(taskId, generationId, 3000);
      } else {
        store.updateGeneration(generationId, {
          status: "failed",
          error: errorMessage(error, "查询生成结果失败"),
        });
      }
    }
  }

  function handlePickReference() {
    Taro.chooseMedia({ count: 1, mediaType: ["image"], sourceType: ["album"] })
      .then((result) => {
        const tempPath = result.tempFiles[0]?.tempFilePath;
        if (tempPath) setRefImagePath(persistTempFile(tempPath));
      })
      .catch(() => {});
  }

  function handlePreview(generation: Generation, current: string) {
    Taro.previewImage({ urls: generation.resultPaths, current });
  }

  function handleSaveToAlbum(path: string) {
    Taro.saveImageToPhotosAlbum({ filePath: path })
      .then(() => Taro.showToast({ title: "已保存到相册", icon: "success" }))
      .catch(() => {
        Taro.showModal({
          title: "需要相册权限",
          content: "请在设置中允许保存图片到相册",
          confirmText: "去设置",
        }).then(({ confirm }) => {
          if (confirm) void Taro.openSetting();
        });
      });
  }

  function handleGenerationActions(generation: Generation, path: string) {
    Taro.showActionSheet({ itemList: ["保存到相册", "设为参考图", "删除这条记录"] })
      .then(({ tapIndex }) => {
        if (tapIndex === 0) handleSaveToAlbum(path);
        if (tapIndex === 1) {
          setRefImagePath(path);
          Taro.showToast({ title: "已设为参考图", icon: "none" });
        }
        if (tapIndex === 2) useGenerationStore.getState().deleteGeneration(generation.id);
      })
      .catch(() => {});
  }

  function handleClearAll() {
    Taro.showModal({
      title: "清除本地记录",
      content: "本机保存的全部生成记录和图片将被删除，不可恢复。",
      confirmText: "全部清除",
      confirmColor: "#d92d20",
    }).then(({ confirm }) => {
      if (confirm) {
        useGenerationStore.getState().clearAll();
        Taro.showToast({ title: "已清除", icon: "success" });
      }
    });
  }

  return (
    <View className="page-body generate-page">
      <View className="composer card">
        <Textarea
          className="composer-input"
          value={prompt}
          maxlength={MAX_PROMPT_LENGTH}
          placeholder="描述你想生成的画面…"
          autoHeight
          onInput={(event) => setPrompt(event.detail.value)}
        />

        {refImagePath && (
          <View className="ref-chip">
            <Image className="ref-chip-image" src={refImagePath} mode="aspectFill" />
            <Text className="ref-chip-label">参考图</Text>
            <Text className="ref-chip-remove" onClick={() => setRefImagePath(null)}>
              ×
            </Text>
          </View>
        )}

        <View className="option-row">
          <Text className="option-label">尺寸</Text>
          <View className="option-scroll">
            {GENERATION_SIZES.map((item) => (
              <Text
                key={item}
                className={`option-chip${size === item ? " option-chip-active" : ""}`}
                onClick={() => setSize(item)}
              >
                {SIZE_LABELS[item]}
              </Text>
            ))}
          </View>
        </View>
        <View className="option-row">
          <Text className="option-label">质量</Text>
          <View className="option-scroll">
            {GENERATION_QUALITIES.map((item) => (
              <Text
                key={item}
                className={`option-chip${quality === item ? " option-chip-active" : ""}`}
                onClick={() => setQuality(item)}
              >
                {QUALITY_LABELS[item]}
              </Text>
            ))}
          </View>
        </View>

        <View className="composer-actions">
          <Text className="quota-hint text-secondary">
            {quota ? `今日剩余 ${quota.remaining}/${quota.limit} 张` : ""}
          </Text>
          <View className="composer-buttons">
            <Button className="ref-btn" onClick={handlePickReference}>
              加参考图
            </Button>
            <Button className="btn-primary generate-btn" disabled={submitting} onClick={handleGenerate}>
              {submitting ? "提交中…" : "生成"}
            </Button>
          </View>
        </View>
      </View>

      {generations.length === 0 ? (
        <View className="empty-state">输入提示词，生成第一张图</View>
      ) : (
        <View className="history-list">
          {generations.map((generation) => (
            <View key={generation.id} className="history-card card">
              <View className="history-head">
                <Text className="history-prompt">{generation.prompt}</Text>
                <Text className="history-time text-secondary">{formatDateTime(generation.createdAt)}</Text>
              </View>
              {generation.status === "pending" && (
                <View className="history-pending">
                  <Text className="text-secondary">生成中，请稍候…</Text>
                </View>
              )}
              {generation.status === "failed" && (
                <View className="history-failed">
                  <Text className="history-failed-text">{generation.error ?? "生成失败"}</Text>
                  <Text
                    className="history-delete-link"
                    onClick={() => useGenerationStore.getState().deleteGeneration(generation.id)}
                  >
                    删除
                  </Text>
                </View>
              )}
              {generation.status === "success" && (
                <View className="history-images">
                  {generation.resultPaths.map((path) => (
                    <Image
                      key={path}
                      className="history-image"
                      src={path}
                      mode="widthFix"
                      lazyLoad
                      onClick={() => handlePreview(generation, path)}
                      onLongPress={() => handleGenerationActions(generation, path)}
                    />
                  ))}
                </View>
              )}
            </View>
          ))}
          <Text className="clear-link" onClick={handleClearAll}>
            清除本地记录
          </Text>
        </View>
      )}
    </View>
  );
}
