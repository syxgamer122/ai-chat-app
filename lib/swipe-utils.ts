export function resolveSwipeDirection(
  deltaX: number,
  deltaY: number,
  threshold = 64,
  maxVerticalDistance = 80,
): "left" | "right" | null {
  if (Math.abs(deltaY) > maxVerticalDistance) {
    return null;
  }

  if (Math.abs(deltaX) < threshold) {
    return null;
  }

  return deltaX < 0 ? "left" : "right";
}
