import type { ViewportTransform } from "@/types/canvas";

export type TouchPoint = {
    x: number;
    y: number;
};

export const TOUCH_LONG_PRESS_MS = 500;
export const TOUCH_MOVE_TOLERANCE = 8;

export function touchDistance(first: TouchPoint, second: TouchPoint): number {
    return Math.hypot(second.x - first.x, second.y - first.y);
}

export function touchMidpoint(first: TouchPoint, second: TouchPoint): TouchPoint {
    return {
        x: (first.x + second.x) / 2,
        y: (first.y + second.y) / 2,
    };
}

export function panViewport(viewport: ViewportTransform, start: TouchPoint, current: TouchPoint): ViewportTransform {
    return {
        x: viewport.x + current.x - start.x,
        y: viewport.y + current.y - start.y,
        k: viewport.k,
    };
}

export function pinchViewport(
    viewport: ViewportTransform,
    initialFirst: TouchPoint,
    initialSecond: TouchPoint,
    currentFirst: TouchPoint,
    currentSecond: TouchPoint,
    minScale = 0.05,
    maxScale = 5,
): ViewportTransform {
    const initialDistance = touchDistance(initialFirst, initialSecond);
    if (initialDistance === 0) return viewport;

    const initialMidpoint = touchMidpoint(initialFirst, initialSecond);
    const currentMidpoint = touchMidpoint(currentFirst, currentSecond);
    const scale = Math.min(Math.max(viewport.k * (touchDistance(currentFirst, currentSecond) / initialDistance), minScale), maxScale);
    const worldX = (initialMidpoint.x - viewport.x) / viewport.k;
    const worldY = (initialMidpoint.y - viewport.y) / viewport.k;

    return {
        x: currentMidpoint.x - worldX * scale,
        y: currentMidpoint.y - worldY * scale,
        k: scale,
    };
}

export function hasTouchMoved(start: TouchPoint, current: TouchPoint, tolerance = TOUCH_MOVE_TOLERANCE): boolean {
    return Math.hypot(current.x - start.x, current.y - start.y) > tolerance;
}
