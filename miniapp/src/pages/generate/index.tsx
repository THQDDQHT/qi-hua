import { Button, Image, Text, Textarea, View } from "@tarojs/components";
import Taro, { useDidShow, useShareAppMessage, useUnload } from "@tarojs/taro";
import { useRef, useState } from "react";
import * as api from "@/services/api";
import { deleteStoredFile, persistTempFile } from "@/services/file-storage";
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
const USAGE_RULES_KEY = "miniapp:aigc-rules-v2";
const AIGC_NOTICE = "内容由 AI 生成，禁止利用此功能从事任何违法活动";
const USAGE_RULES = "生成内容由人工智能生成，导出图片会写入 AI 生成文件元数据，请勿用于违法违规用途。提示词和参考图会上传至啟画服务端，并发送给生图服务供应商用于本次生成；任务结束后提示词会从任务数据清除，参考图和结果文件默认在 24 小时内清理。小程序历史记录和已下载图片保存在本机。";

type ReferenceImage = { path: string; owned: boolean };

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
  const [privacyVisible, setPrivacyVisible] = useState(false);
  const [referenceImage, setReferenceImage] = useState<ReferenceImage | null>(null);
  const [preview, setPreview] = useState<{ generation: Generation; path: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const referenceImageRef = useRef<ReferenceImage | null>(null);
  const submittingIdsRef = useRef(new Set<string>());
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const activePollsRef = useRef(new Set<string>());
  const pollFailuresRef = useRef<Record<string, number>>({});

  const generations = useGenerationStore((state) => state.generations);
  const quota = useConfigStore((state) => state.quota);

  useDidShow(() => {
    void useConfigStore.getState().initSession().then(() => {
      const config = useConfigStore.getState();
      if (!config.sessionReady) return;
      void config.refreshQuota();
      resumePendingGenerations();
    });
  });

  useUnload(() => {
    cancelScheduledPolls();
    const reference = referenceImageRef.current;
    if (reference?.owned && submittingIdsRef.current.size === 0) deleteStoredFile(reference.path);
  });

  useShareAppMessage(() => ({ title: "啟画：一句话生成好图", path: "/pages/generate/index" }));

  function errorMessage(error: unknown, fallback: string) {
    return error instanceof Error ? error.message : fallback;
  }

  function isCancelled(error: unknown) {
    const message = typeof error === "object" && error && "errMsg" in error
      ? String(error.errMsg)
      : errorMessage(error, "");
    return /cancel/i.test(message);
  }

  function privacyErrorCode(error: unknown) {
    if (typeof error !== "object" || !error || !("errno" in error)) return undefined;
    return Number(error.errno);
  }

  function replaceReference(next: ReferenceImage | null) {
    const previous = referenceImageRef.current;
    if (previous?.owned && previous.path !== next?.path) deleteStoredFile(previous.path);
    referenceImageRef.current = next;
    setReferenceImage(next);
  }

  async function ensureUsageRulesAccepted() {
    if (Taro.getStorageSync(USAGE_RULES_KEY) === true) return true;
    const { confirm } = await Taro.showModal({
      title: "生成内容使用规则",
      content: USAGE_RULES,
      confirmText: "同意使用",
      cancelText: "暂不使用",
    });
    if (confirm) Taro.setStorageSync(USAGE_RULES_KEY, true);
    return confirm;
  }

  async function handleGenerate() {
    const trimmed = prompt.trim();
    if (!trimmed) {
      Taro.showToast({ title: "请输入提示词", icon: "none" });
      return;
    }
    if (submitting) return;

    setSubmitting(true);
    let generationId: string | undefined;

    try {
      if (!(await ensureUsageRulesAccepted())) return;
      await useConfigStore.getState().initSession();
      const config = useConfigStore.getState();
      if (!config.sessionReady) {
        Taro.showToast({ title: "服务连接失败，请稍后重试", icon: "none" });
        return;
      }
      if (config.generation && !config.generation.enabled) {
        Taro.showToast({ title: config.generation.disabledReason ?? "生图服务暂不可用", icon: "none" });
        return;
      }

      generationId = createId();
      const referencePath = referenceImageRef.current?.path;
      useGenerationStore.getState().addGeneration({
        id: generationId,
        mode: referencePath ? "edit" : "text",
        prompt: trimmed,
        size,
        quality,
        resultPaths: [],
        status: "pending",
        createdAt: Date.now(),
      });
      submittingIdsRef.current.add(generationId);
      const input = { requestKey: generationId, prompt: trimmed, count: 1, size, quality };
      const result = referencePath
        ? await api.submitEdit({ ...input, filePath: referencePath })
        : await api.submitGeneration(input);
      useGenerationStore.getState().updateGeneration(generationId, { taskId: result.taskId });
      pollFailuresRef.current[generationId] = 0;
      schedulePoll(result.taskId, generationId, result.pollAfterMs || 2000);
    } catch (error) {
      if (generationId) {
        useGenerationStore.getState().updateGeneration(generationId, {
          status: "failed",
          taskId: undefined,
          error: errorMessage(error, "提交生成任务失败"),
        });
      } else if (!isCancelled(error)) {
        Taro.showToast({ title: errorMessage(error, "提交生成任务失败"), icon: "none" });
      }
      void useConfigStore.getState().refreshQuota();
    } finally {
      if (generationId) submittingIdsRef.current.delete(generationId);
      setSubmitting(false);
    }
  }

  function isPendingGeneration(generationId: string, taskId: string) {
    const generation = useGenerationStore.getState().generations.find((item) => item.id === generationId);
    return generation?.status === "pending" && generation.taskId === taskId;
  }

  function cancelScheduledPolls(generationId?: string) {
    if (generationId) {
      clearTimeout(timersRef.current[generationId]);
      delete timersRef.current[generationId];
      return;
    }
    Object.values(timersRef.current).forEach(clearTimeout);
    timersRef.current = {};
  }

  function resumePendingGenerations() {
    useGenerationStore.getState().generations.forEach((generation) => {
      if (generation.status !== "pending") return;
      if (generation.taskId) {
        schedulePoll(generation.taskId, generation.id, 200);
      } else if (!submittingIdsRef.current.has(generation.id)) {
        useGenerationStore.getState().updateGeneration(generation.id, {
          status: "failed",
          error: "任务提交被中断，请重新生成",
        });
      }
    });
  }

  function schedulePoll(taskId: string, generationId: string, delay: number) {
    if (!isPendingGeneration(generationId, taskId)) return;
    cancelScheduledPolls(generationId);
    const timer = setTimeout(() => {
      if (timersRef.current[generationId] === timer) delete timersRef.current[generationId];
      void runPoll(taskId, generationId);
    }, delay);
    timersRef.current[generationId] = timer;
  }

  async function runPoll(taskId: string, generationId: string) {
    if (!isPendingGeneration(generationId, taskId) || activePollsRef.current.has(generationId)) return;
    activePollsRef.current.add(generationId);
    try {
      const poll = await api.pollTask(taskId);
      if (!isPendingGeneration(generationId, taskId)) return;
      if (poll.quota) useConfigStore.getState().setQuota(poll.quota);
      if (poll.status === "queued" || poll.status === "running") {
        schedulePoll(taskId, generationId, poll.pollAfterMs || 2000);
        return;
      }
      const items = (poll.results ?? []).filter((item) => item.status === "success" && item.image?.url);
      if (items.length === 0) {
        useGenerationStore.getState().updateGeneration(generationId, {
          status: "failed",
          taskId: undefined,
          error: "生成未成功，请调整提示词后重试",
        });
        delete pollFailuresRef.current[generationId];
        return;
      }
      const paths: string[] = [];
      for (const item of items) {
        try {
          const tempPath = await api.downloadResultFile(item.image!.url);
          if (!isPendingGeneration(generationId, taskId)) break;
          paths.push(persistTempFile(tempPath));
        } catch {
          // 单张下载失败不阻断其他结果
        }
      }
      if (!isPendingGeneration(generationId, taskId)) {
        paths.forEach(deleteStoredFile);
        return;
      }
      if (paths.length === 0) {
        useGenerationStore.getState().updateGeneration(generationId, {
          status: "failed",
          taskId: undefined,
          error: "结果图下载失败，请重试",
        });
      } else {
        useGenerationStore.getState().updateGeneration(generationId, {
          status: "success",
          taskId: undefined,
          resultPaths: paths,
        });
      }
      delete pollFailuresRef.current[generationId];
    } catch (error) {
      if (!isPendingGeneration(generationId, taskId)) return;
      const failures = (pollFailuresRef.current[generationId] ?? 0) + 1;
      pollFailuresRef.current[generationId] = failures;
      if (failures < MAX_POLL_FAILURES) {
        schedulePoll(taskId, generationId, 3000);
      } else {
        useGenerationStore.getState().updateGeneration(generationId, {
          status: "failed",
          taskId: undefined,
          error: errorMessage(error, "查询生成结果失败"),
        });
        delete pollFailuresRef.current[generationId];
      }
    } finally {
      activePollsRef.current.delete(generationId);
    }
  }

  async function chooseReferenceImage() {
    let tempPath: string | undefined;
    try {
      const result = await Taro.chooseMedia({ count: 1, mediaType: ["image"], sourceType: ["album"] });
      tempPath = result.tempFiles[0]?.tempFilePath;
    } catch (error) {
      if (isCancelled(error)) return;
      const code = privacyErrorCode(error);
      if (code === 103 || code === 104) {
        setPrivacyVisible(true);
        return;
      }
      Taro.showToast({
        title: code === 112 ? "参考图隐私配置异常" : "无法打开相册，请稍后重试",
        icon: "none",
      });
      return;
    }

    if (!tempPath) {
      Taro.showToast({ title: "未读取到所选图片，请换一张重试", icon: "none" });
      return;
    }

    try {
      replaceReference({ path: persistTempFile(tempPath), owned: true });
    } catch {
      Taro.showToast({ title: "图片暂存失败，请清理本地记录后重试", icon: "none" });
    }
  }

  function handlePickReference() {
    Taro.getPrivacySetting({
      success: ({ needAuthorization }) => {
        if (needAuthorization) setPrivacyVisible(true);
        else void chooseReferenceImage();
      },
      fail: () => void chooseReferenceImage(),
    });
  }

  function handleAgreePrivacyAuthorization() {
    setPrivacyVisible(false);
    void chooseReferenceImage();
  }

  function handlePreview(generation: Generation, current: string) {
    setPreview({ generation, path: current });
  }

  function handleSetReference(path: string) {
    replaceReference({ path, owned: false });
    setPreview(null);
    Taro.showToast({ title: "已设为参考图", icon: "none" });
  }

  async function handleSaveToAlbum(path: string) {
    try {
      await Taro.saveImageToPhotosAlbum({ filePath: path });
      Taro.showToast({ title: "已保存到相册", icon: "success" });
    } catch (error) {
      if (isCancelled(error)) return;
      const setting = await Taro.getSetting().catch(() => null);
      if (setting?.authSetting["scope.writePhotosAlbum"] === false) {
        const { confirm } = await Taro.showModal({
          title: "需要相册权限",
          content: "请在设置中允许啟画保存图片到相册",
          confirmText: "去设置",
        });
        if (confirm) void Taro.openSetting();
      } else {
        Taro.showToast({ title: "保存失败，请稍后重试", icon: "none" });
      }
    }
  }

  function handleDeleteGeneration(generationId: string) {
    const target = useGenerationStore.getState().generations.find((item) => item.id === generationId);
    const reference = referenceImageRef.current;
    if (target && reference && target.resultPaths.includes(reference.path)) {
      try {
        replaceReference({ path: persistTempFile(reference.path), owned: true });
      } catch {
        replaceReference(null);
      }
    }
    cancelScheduledPolls(generationId);
    delete pollFailuresRef.current[generationId];
    useGenerationStore.getState().deleteGeneration(generationId);
  }

  function handleUsageRules() {
    void Taro.showModal({
      title: "生成内容使用规则",
      content: USAGE_RULES,
      showCancel: false,
      confirmText: "知道了",
    });
  }

  function handlePrivacyContract() {
    Taro.openPrivacyContract({
      fail: () => {
        void Taro.showModal({
          title: "隐私说明",
          content: "提示词和参考图会上传至啟画服务端，并发送给生图服务供应商用于本次生成；任务结束后提示词会从任务数据清除，参考图和结果文件默认在 24 小时内清理。小程序历史记录和已下载图片保存在本机。请在后台发布隐私保护指引后查看完整内容。",
          showCancel: false,
        });
      },
    });
  }

  function handleGenerationActions(generation: Generation, path: string) {
    Taro.showActionSheet({ itemList: ["保存到相册", "设为参考图", "删除这条记录"] })
      .then(({ tapIndex }) => {
        if (tapIndex === 0) handleSaveToAlbum(path);
        if (tapIndex === 1) handleSetReference(path);
        if (tapIndex === 2) handleDeleteGeneration(generation.id);
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
        cancelScheduledPolls();
        pollFailuresRef.current = {};
        replaceReference(null);
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
          {referenceImage ? (
            <View key="ref-thumb" className="ref-thumb">
              <Image className="ref-thumb-image" src={referenceImage.path} mode="aspectFill" />
              <Text className="ref-thumb-remove" onClick={() => replaceReference(null)}>
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
                        onClick={() => handleDeleteGeneration(generation.id)}
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
                  {generation.status === "success" && (
                    <Text className="h-aigc-notice">{AIGC_NOTICE}</Text>
                  )}
                  {generation.status !== "failed" && (
                    <View className="h-meta">
                      <Text className="h-prompt">{generation.prompt}</Text>
                      <Text className="h-aigc-mark">AI生成</Text>
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

      <View className="compliance-note">
        <Text>{AIGC_NOTICE}</Text>
        <View className="compliance-links">
          <Text onClick={handleUsageRules}>生成内容使用规则</Text>
          <Text onClick={handlePrivacyContract}>隐私保护指引</Text>
        </View>
      </View>

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
      {privacyVisible && (
        <View className="picker-mask" onClick={() => setPrivacyVisible(false)}>
          <View className="picker-panel" onClick={(event) => event.stopPropagation()}>
            <Text className="picker-title">选择参考图前请确认</Text>
            <Text className="privacy-copy">
              你选择的图片会上传至啟画服务端，并发送给生图服务供应商用于本次生成。
            </Text>
            <Text className="privacy-contract-link" onClick={handlePrivacyContract}>
              查看《啟画隐私保护指引》
            </Text>
            <View className="privacy-actions">
              <Button className="privacy-button privacy-cancel" onClick={() => setPrivacyVisible(false)}>
                暂不使用
              </Button>
              <Button
                id="agree-privacy-btn"
                className="privacy-button btn-primary"
                hoverClass="none"
                openType="agreePrivacyAuthorization"
                onAgreePrivacyAuthorization={handleAgreePrivacyAuthorization}
              >
                同意并选择
              </Button>
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
          <Text className="preview-aigc-notice">{AIGC_NOTICE}</Text>
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
