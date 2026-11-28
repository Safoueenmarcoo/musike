import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { DotsSixVerticalIcon } from "@phosphor-icons/react";
import type { CSSProperties, HTMLAttributes, ReactNode, Ref } from "react";
import { useT } from "../i18n";
import { cn } from "../lib/format";

/**
 * A list whose rows can be dragged into a new order by their handle: with the mouse, a finger, or the keyboard
 * (focus the handle, Space to pick up, arrows to move, Space to drop, Escape to cancel).
 */
export function SortableList({
  ids,
  nameOf,
  onMove,
  children,
}: {
  /** One unique id per row, in order. */
  ids: string[];
  /** What to call a row when telling screen readers where it went. */
  nameOf: (id: string) => string;
  onMove: (from: number, to: number) => void;
  children: ReactNode;
}) {
  const t = useT();
  const sensors = useSensors(
    // A few pixels of movement before it counts as a drag, so a tap on the handle stays a tap.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const where = (id: string | number | undefined) => ids.indexOf(String(id)) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) => t.reorder.picked(nameOf(String(active.id)), where(active.id), ids.length),
    onDragOver: ({ active, over }) => (over ? t.reorder.over(nameOf(String(active.id)), where(over.id), ids.length) : undefined),
    onDragEnd: ({ active, over }) => (over ? t.reorder.dropped(nameOf(String(active.id)), where(over.id), ids.length) : undefined),
    onDragCancel: ({ active }) => t.reorder.cancelled(nameOf(String(active.id))),
  };
  const end = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from >= 0 && to >= 0) onMove(from, to);
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={end}
      accessibility={{ announcements, screenReaderInstructions: { draggable: t.reorder.instructions } }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

export interface SortableRow {
  ref: Ref<HTMLLIElement>;
  style: CSSProperties;
  handle: ReactNode;
  dragging: boolean;
}

/** What a row needs to be dragged: its element ref, its moving style, and the handle to show. */
export function useSortableRow(id: string, label: string): SortableRow {
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id });
  return {
    ref: setNodeRef,
    style: {
      // Up and down only.
      transform: transform ? `translate3d(0, ${Math.round(transform.y)}px, 0)` : undefined,
      transition,
      position: "relative",
      zIndex: isDragging ? 30 : undefined,
    },
    dragging: isDragging,
    handle: <DragHandle activator={setActivatorNodeRef} props={{ ...attributes, ...listeners }} label={label} />,
  };
}

function DragHandle({ activator, props, label }: { activator: (el: HTMLElement | null) => void; props: HTMLAttributes<HTMLElement>; label: string }) {
  return (
    <button
      type="button"
      ref={activator}
      {...props}
      aria-label={label}
      title={label}
      className={cn(
        "relative z-10 -mx-1 grid size-8 shrink-0 cursor-grab touch-none place-items-center rounded-full text-fg-3 hover:bg-surface-3 hover:text-fg active:cursor-grabbing",
      )}
    >
      <DotsSixVerticalIcon size={18} weight="bold" />
    </button>
  );
}
