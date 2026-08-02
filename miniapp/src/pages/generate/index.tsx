import { Button, Image, Text, Textarea, View } from "@tarojs/components";
import Taro, { useDidShow, useShareAppMessage, useUnload } from "@tarojs/taro";
import { useRef, useState } from "react";
import * as api from "@/services/api";
import { persistTempFile } from "@/services/file-storage";
import { useConfigStore } from "@/stores/use-config-store";
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
import { createId } from "@/lib/utils";
import "./index.css";

const MAX_POLL_FAILURES = 3;
const COLUMN_WIDTH = 170.5;

function skeletonHeight(size: string): number {
  let ratio = 0.75;
  const colon = /^(\d+):(\d+)$/.exec(size);
  const pixel = /^(\d+)x(\d+)$/.exec(size);
  if (colon) ratio = Number(colon[2]) / Number(colon[1]);
  else if (pixel) ratio = Number(pixel[2]) / Number(pixel[1]);
  return Math.round(COLUMN_WIDTH * ratio);
}

export default function GeneratePage() {
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState<GenerationSize>("auto");
  const [quality, setQuality] = useState<GenerationQuality>("auto");
  const [picker, setPicker] = useState<"size" | "quality" | null>(null);
  const [refImagePath, setRefImagePath] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ generation: Generation; path: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const pollFailuresRef = useRef<Record<string, number>>({});

  const generations = useGenerationStore((state) => state.generations);
  const quota = useConfigStore((state) => state.quota);
  const generationInfo = useConfigStore((state) => state.generation);

  useDidShow(() => {
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
    setPreview({ generation, path: current });
  }

  function handleSetReference(path: string) {
    setRefImagePath(path);
    setPreview(null);
    Taro.showToast({ title: "已设为参考图", icon: "none" });
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
        if (tapIndex === 1) handleSetReference(path);
        if (tapIndex === 2) useGenerationStore.getState().deleteGeneration(generation.id);
      })
      .catch(() => {});
  }

  function handleClearAll() {
    Taro.showModal({
      title: "清除本地记录",
      content: "本机保存的全部生成记录和图片将被删除，不可恢复。",
      confirmText: "全部清除",
      confirmColor: "#e5484d",
    }).then(({ confirm }) => {
      if (confirm) {
        useGenerationStore.getState().clearAll();
        Taro.showToast({ title: "已清除", icon: "success" });
      }
    });
  }

  const columns: [Generation[], Generation[]] = [[], []];
  generations.forEach((generation, index) => columns[index % 2].push(generation));

  const pickerOptions = picker === "size" ? GENERATION_SIZES : GENERATION_QUALITIES;
  const pickerLabels = picker === "size" ? SIZE_LABELS : QUALITY_LABELS;
  const pickerValue = picker === "size" ? size : quality;

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

        <View className="composer-toolbar">
          {refImagePath ? (
            <View key="ref-thumb" className="ref-thumb">
              <Image className="ref-thumb-image" src={refImagePath} mode="aspectFill" />
              <Text className="ref-thumb-remove" onClick={() => setRefImagePath(null)}>
                ×
              </Text>
            </View>
          ) : (
            <View key="ref-capsule" className="ref-capsule" onClick={handlePickReference}>
              <Text className="ref-capsule-plus">+</Text>
              <Text>参考图</Text>
            </View>
          )}
          <View className="toolbar-spacer" />
          <View className="picker-capsule" onClick={() => setPicker("size")}>
            <Text className="capsule-dim">尺寸·</Text>
            <Text>{SIZE_LABELS[size]}</Text>
            <Text className="picker-capsule-arrow">▾</Text>
          </View>
          <View className="picker-capsule" onClick={() => setPicker("quality")}>
            <Text className="capsule-dim">画质·</Text>
            <Text>{QUALITY_LABELS[quality]}</Text>
            <Text className="picker-capsule-arrow">▾</Text>
          </View>
        </View>

        <Button
          className="btn-primary generate-btn"
          hover-class="none"
          disabled={submitting}
          onClick={handleGenerate}
        >
          {submitting ? "提交中…" : "✨ 生成"}
        </Button>
        {quota && (
          <Text className="quota-hint text-secondary">今日剩余 {quota.remaining}/{quota.limit} 张</Text>
        )}
      </View>

      {generations.length === 0 ? (
        <View className="empty-state">
          <View className="empty-visual">✨</View>
          <View className="empty-title">输入提示词，生成第一张图</View>
          <View>加「参考图」可以让 AI 照着你的图画</View>
        </View>
      ) : (
        <View className="history-list">
          {columns.map((column, columnIndex) => (
            <View key={columnIndex} className="history-column">
              {column.map((generation) => (
                <View key={generation.id} className="h-card">
                  {generation.status === "pending" && (
                    <View className="h-skeleton" style={{ height: `${skeletonHeight(generation.size)}px` }}>
                      <Text className="h-skeleton-text">生成中…</Text>
                    </View>
                  )}
                  {generation.status === "failed" && (
                    <View className="h-failed">
                      <Text className="h-failed-text">{generation.error ?? "生成失败"}</Text>
                      <Text
                        className="h-failed-delete"
                        onClick={() => useGenerationStore.getState().deleteGeneration(generation.id)}
                      >
                        删除这条记录
                      </Text>
                    </View>
                  )}
                  {generation.status === "success" &&
                    generation.resultPaths.map((path) => (
                      <View key={path} className="h-image-wrap">
                        <Image
                          className="h-image"
                          src={path}
                          mode="widthFix"
                          lazyLoad
                          onClick={() => handlePreview(generation, path)}
                          onLongPress={() => handleGenerationActions(generation, path)}
                        />
                        <Text
                          className="h-download"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleSaveToAlbum(path);
                          }}
                        >
                          ↓
                        </Text>
                      </View>
                    ))}
                  {generation.status !== "failed" && (
                    <View className="h-meta">
                      <Text className="h-prompt">{generation.prompt}</Text>
                    </View>
                  )}
                </View>
              ))}
            </View>
          ))}
        </View>
      )}

      {generations.length > 0 && (
        <Text className="clear-link" onClick={handleClearAll}>
          清除本地记录
        </Text>
      )}

      {picker && (
        <View className="picker-mask" onClick={() => setPicker(null)}>
          <View className="picker-panel" onClick={(event) => event.stopPropagation()}>
            <Text className="picker-title">{picker === "size" ? "选择尺寸" : "选择质量"}</Text>
            <Text className="picker-hint">
              {picker === "size"
                ? "不确定就选「智能比例」，AI 会按提示词内容决定画幅"
                : "不确定就选「默认」，自动平衡速度和画质"}
            </Text>
            <View className="picker-grid">
              {pickerOptions.map((item) => (
                <Text
                  key={item}
                  className={`picker-option${pickerValue === item ? " picker-option-active" : ""}`}
                  onClick={() => {
                    if (picker === "size") setSize(item as GenerationSize);
                    else setQuality(item as GenerationQuality);
                    setPicker(null);
                  }}
                >
                  {pickerLabels[item as GenerationSize & GenerationQuality]}
                </Text>
              ))}
            </View>
          </View>
        </View>
      )}
      {preview && (
        <View className="preview-mask" onClick={() => setPreview(null)}>
          <Image className="preview-image" src={preview.path} mode="aspectFit" />
          <Text
            className="preview-close"
            onClick={(event) => {
              event.stopPropagation();
              setPreview(null);
            }}
          >
            ×
          </Text>
          <View className="preview-actions" onClick={(event) => event.stopPropagation()}>
            <Text className="preview-btn" onClick={() => handleSaveToAlbum(preview.path)}>
              保存到相册
            </Text>
            <Text className="preview-btn" onClick={() => handleSetReference(preview.path)}>
              设为参考图
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}