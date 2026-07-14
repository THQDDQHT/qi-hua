import React, { useEffect, useRef, useState } from "react";

import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { hasTouchMoved, panViewport, pinchViewport, TOUCH_LONG_PRESS_MS, type TouchPoint } from "@/lib/canvas/canvas-gesture";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ViewportTransform } from "@/types/canvas";

type InfiniteCanvasProps = {
    containerRef: React.RefObject<HTMLDivElement | null>;
    viewport: ViewportTransform;
    backgroundMode?: CanvasBackgroundMode;
    onViewportChange: (viewport: ViewportTransform) => void;
    onCanvasMouseDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
    onCanvasDeselect?: () => void;
    onContextMenu?: (event: React.MouseEvent) => void;
    onLongPress?: (position: { clientX: number; clientY: number; target: EventTarget | null }) => void;
    onSecondTouch?: () => void;
    onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
    children: React.ReactNode;
};

export function InfiniteCanvas({ containerRef, viewport, backgroundMode = "lines", onViewportChange, onCanvasMouseDown, onCanvasDeselect, onContextMenu, onLongPress, onSecondTouch, onDrop, children }: InfiniteCanvasProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const panState = useRef({
        isPanning: false,
        startX: 0,
        startY: 0,
        initialX: 0,
        initialY: 0,
        hasMoved: false,
    });
    const touchState = useRef<{
        points: Map<number, TouchPoint>;
        initialPoints: [TouchPoint, TouchPoint] | null;
        initialViewport: ViewportTransform;
        longPressTimer: ReturnType<typeof setTimeout> | null;
        longPressStart: TouchPoint | null;
        longPressTriggered: boolean;
        isBackground: boolean;
    }>({ points: new Map(), initialPoints: null, initialViewport: viewport, longPressTimer: null, longPressStart: null, longPressTriggered: false, isBackground: false });
    const scaleRef = useRef(viewport.k);
    const frameRef = useRef<number | null>(null);
    const nextViewportRef = useRef<ViewportTransform | null>(null);
    const [isSpacePressed, setIsSpacePressed] = useState(false);

    useEffect(() => {
        scaleRef.current = viewport.k;
    }, [viewport.k]);

    useEffect(
        () => () => {
            if (frameRef.current) cancelAnimationFrame(frameRef.current);
        },
        [],
    );

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.code !== "Space") return;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
            setIsSpacePressed(true);
        };

        const handleKeyUp = (event: KeyboardEvent) => {
            if (event.code === "Space") setIsSpacePressed(false);
        };

        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("keyup", handleKeyUp);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("keyup", handleKeyUp);
        };
    }, []);

    const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown")) return;

        const delta = -event.deltaY;
        const factor = Math.pow(1.1, delta / 100);
        const newScale = Math.min(Math.max(viewport.k * factor, 0.05), 5);
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;

        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;
        const worldX = (mouseX - viewport.x) / viewport.k;
        const worldY = (mouseY - viewport.y) / viewport.k;

        onViewportChange({
            x: mouseX - worldX * newScale,
            y: mouseY - worldY * newScale,
            k: newScale,
        });
    };

    const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.pointerType === "touch") return;
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom]")) return;
        if (target?.closest("[data-connection-create-menu]")) return;
        const isBackgroundClick = !target?.closest("[data-node-id],[data-connection-id]");

        if (event.button === 0 && (event.ctrlKey || event.metaKey) && isBackgroundClick) {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            onCanvasMouseDown?.(event);
            return;
        }

        if (event.button === 1 || (event.button === 0 && !isSpacePressed && isBackgroundClick)) {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            panState.current = {
                isPanning: true,
                startX: event.clientX,
                startY: event.clientY,
                initialX: viewport.x,
                initialY: viewport.y,
                hasMoved: false,
            };
            document.body.style.cursor = "grabbing";
            return;
        }

        if (event.button === 0 && isSpacePressed && isBackgroundClick) {
            event.preventDefault();
        }
    };

    const clearLongPress = () => {
        if (touchState.current.longPressTimer) clearTimeout(touchState.current.longPressTimer);
        touchState.current.longPressTimer = null;
    };

    const handleTouchPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        const point = { x: event.clientX, y: event.clientY };
        touchState.current.points.set(event.pointerId, point);
        if (touchState.current.points.size === 1) {
            touchState.current.initialViewport = viewport;
            touchState.current.longPressStart = point;
            touchState.current.longPressTriggered = false;
            touchState.current.isBackground = !(event.target instanceof Element) || !event.target.closest("[data-node-id]");
            clearLongPress();
            touchState.current.longPressTimer = setTimeout(() => {
                if (touchState.current.points.size !== 1 || !touchState.current.longPressStart) return;
                touchState.current.longPressTriggered = true;
                onLongPress?.({ clientX: point.x, clientY: point.y, target: event.target });
            }, TOUCH_LONG_PRESS_MS);
            if (!event.target || !(event.target instanceof Element) || !event.target.closest("[data-node-id]")) {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
            }
        } else if (touchState.current.points.size === 2) {
            clearLongPress();
            touchState.current.initialPoints = Array.from(touchState.current.points.values()) as [TouchPoint, TouchPoint];
            touchState.current.initialViewport = viewport;
            onSecondTouch?.();
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
        }
    };

    const scheduleViewportChange = (next: ViewportTransform) => {
        nextViewportRef.current = next;
        if (frameRef.current) return;
        frameRef.current = requestAnimationFrame(() => {
            frameRef.current = null;
            if (nextViewportRef.current) onViewportChange(nextViewportRef.current);
        });
    };

    useEffect(() => {
        const handlePointerMove = (event: PointerEvent) => {
            if (event.pointerType === "touch" && touchState.current.points.has(event.pointerId)) {
                const current = { x: event.clientX, y: event.clientY };
                touchState.current.points.set(event.pointerId, current);
                const start = touchState.current.longPressStart;
                if (start && hasTouchMoved(start, current)) clearLongPress();
                const points = Array.from(touchState.current.points.values());
                if (points.length >= 2 && touchState.current.initialPoints) {
                    event.preventDefault();
                    scheduleViewportChange(pinchViewport(touchState.current.initialViewport, touchState.current.initialPoints[0], touchState.current.initialPoints[1], points[0], points[1]));
                } else if (points.length === 1 && start && touchState.current.isBackground) {
                    event.preventDefault();
                    scheduleViewportChange(panViewport(touchState.current.initialViewport, start, current));
                }
                return;
            }

            if (!panState.current.isPanning) return;
            const dx = event.clientX - panState.current.startX;
            const dy = event.clientY - panState.current.startY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) panState.current.hasMoved = true;
            scheduleViewportChange({ x: panState.current.initialX + dx, y: panState.current.initialY + dy, k: scaleRef.current });
        };

        const handlePointerUp = (event: PointerEvent) => {
            if (event.pointerType === "touch" && touchState.current.points.has(event.pointerId)) {
                touchState.current.points.delete(event.pointerId);
                clearLongPress();
                if (touchState.current.points.size < 2) touchState.current.initialPoints = null;
                touchState.current.longPressStart = null;
                return;
            }
            if (!panState.current.isPanning) return;
            if (!panState.current.hasMoved) onCanvasDeselect?.();
            panState.current.isPanning = false;
            document.body.style.cursor = "default";
        };

        window.addEventListener("pointermove", handlePointerMove, { passive: false });
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", handlePointerUp);
        return () => {
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", handlePointerUp);
            clearLongPress();
        };
    }, [onCanvasDeselect, onLongPress, onSecondTouch, onViewportChange]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const preventWheelScroll = (event: WheelEvent) => event.preventDefault();
        container.addEventListener("wheel", preventWheelScroll, { passive: false });
        return () => container.removeEventListener("wheel", preventWheelScroll);
    }, [containerRef]);

    return (
        <div
            ref={containerRef}
            className="relative h-full w-full cursor-grab select-none overflow-hidden"
            style={{ background: theme.canvas.background, touchAction: "none" }}
            onPointerDownCapture={(event) => {
                if (event.pointerType === "touch") handleTouchPointerDown(event);
            }}
            onPointerDown={handlePointerDown}
            onWheel={handleWheel}
            onContextMenu={onContextMenu}
            onDragOver={(event) => event.preventDefault()}
            onDrop={onDrop}
        >
            <CanvasGrid viewport={viewport} mode={backgroundMode} />
            <div
                className="absolute origin-top-left"
                style={{
                    transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})`,
                }}
            >
                {children}
            </div>
        </div>
    );
}

function CanvasGrid({ viewport, mode }: { viewport: ViewportTransform; mode: CanvasBackgroundMode }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (mode === "blank") return null;

    const gridSize = 48 * viewport.k;
    const x = viewport.x % gridSize;
    const y = viewport.y % gridSize;
    const dotSize = viewport.k < 0.12 ? 0.8 : 1.15;
    const backgroundImage =
        mode === "dots" ? `radial-gradient(circle, ${theme.canvas.dot} ${dotSize}px, transparent ${dotSize + 0.2}px)` : `linear-gradient(${theme.canvas.line} 1px, transparent 1px), linear-gradient(90deg, ${theme.canvas.line} 1px, transparent 1px)`;

    return (
        <div
            className="pointer-events-none absolute inset-0 opacity-40"
            style={{
                backgroundImage,
                backgroundSize: `${gridSize}px ${gridSize}px`,
                backgroundPosition: `${x}px ${y}px`,
            }}
        />
    );
}
