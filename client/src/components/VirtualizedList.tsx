import { useState, useRef, useCallback, type ReactNode } from "react";

interface VirtualizedListProps<T> {
  items: T[];
  itemHeight: number;
  maxHeight: number;
  renderItem: (item: T, index: number) => ReactNode;
  getKey: (item: T, index: number) => string | number;
  /** Rows above/below the viewport to keep in the DOM to avoid flashes when scrolling. */
  overscan?: number;
  /** Below this length, the whole list renders normally (no virtualization overhead). */
  threshold?: number;
  className?: string;
}

/**
 * Minimal fixed-row-height virtualized list. Only kicks in when items.length > threshold
 * (default 30). Below that, renders every row so short lists behave normally.
 *
 * Assumes every row is exactly `itemHeight` px tall — if you use it with variable-height
 * rows the offsets will drift. Every current caller uses uniform 36px rows.
 */
export function VirtualizedList<T>({
  items,
  itemHeight,
  maxHeight,
  renderItem,
  getKey,
  overscan = 5,
  threshold = 30,
  className,
}: VirtualizedListProps<T>) {
  const [scrollTop, setScrollTop] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  // Short-list fast path — no offsets, no math, just render everything.
  if (items.length <= threshold) {
    return (
      <div
        ref={containerRef}
        style={{ maxHeight, overflowY: "auto" }}
        className={className}
      >
        {items.map((item, idx) => (
          <div key={getKey(item, idx)}>{renderItem(item, idx)}</div>
        ))}
      </div>
    );
  }

  const total = items.length * itemHeight;
  const visibleCount = Math.ceil(maxHeight / itemHeight);
  // Clamp startIndex to a valid range — when items shrinks (e.g., search filter narrows the list)
  // while the user was scrolled down, a stale scrollTop can push startIndex past the end and
  // slice returns nothing. The browser eventually fires a scroll event to correct it, but this
  // avoids the transient blank render.
  const maxStart = Math.max(0, items.length - visibleCount - overscan);
  const startIndex = Math.min(maxStart, Math.max(0, Math.floor(scrollTop / itemHeight) - overscan));
  const endIndex = Math.min(items.length, startIndex + visibleCount + overscan * 2);
  const offsetY = startIndex * itemHeight;
  const visible = items.slice(startIndex, endIndex);

  return (
    <div
      ref={containerRef}
      onScroll={onScroll}
      style={{ maxHeight, overflowY: "auto", position: "relative" }}
      className={className}
    >
      <div style={{ height: total, position: "relative" }}>
        <div style={{ position: "absolute", top: offsetY, left: 0, right: 0 }}>
          {visible.map((item, i) => {
            const idx = startIndex + i;
            return (
              <div key={getKey(item, idx)} style={{ height: itemHeight }}>
                {renderItem(item, idx)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
