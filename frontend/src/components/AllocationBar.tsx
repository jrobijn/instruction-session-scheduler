import { useRef, useState, type ReactNode } from 'react';
import { GripVertical } from 'lucide-react';
import { useT } from '../i18n';
import { cx } from '../ui/cx';
import styles from './AllocationBar.module.css';

export interface AllocationSegment {
  name: string;
  percentage: number;
  color: string;
}

interface AllocationBarProps {
  segments: AllocationSegment[];
  /** Legend items can be dragged to reorder. */
  draggable?: boolean;
  onReorder?: (fromIdx: number, toIdx: number) => void;
  /** Trailing controls on the legend row. */
  actions?: ReactNode;
}

/** Stacked percentage bar with legend, showing how a timetable's slots are split over groups. */
export function AllocationBar({ segments, draggable, onReorder, actions }: AllocationBarProps) {
  const t = useT();
  const dragIdx = useRef<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  if (segments.length === 0) return null;

  const total = Math.max(segments.reduce((s, seg) => s + seg.percentage, 0), 100);
  const canDrag = !!draggable && !!onReorder && segments.length > 1;

  return (
    <div className={styles.root}>
      <div className={styles.bar}>
        {segments.map((seg, i) => seg.percentage > 0 && (
          <div key={i} className={styles.segment} style={{ width: `${(seg.percentage / total) * 100}%`, background: seg.color }}>
            {seg.percentage}%
          </div>
        ))}
      </div>
      <div className={styles.legend}>
        {segments.map((seg, i) => (
          <div
            key={i}
            className={cx(styles.item, canDrag && styles.draggable, canDrag && dragOverIdx === i && styles.dragOver)}
            draggable={canDrag}
            title={canDrag ? t.dragToReorderTooltip : undefined}
            onDragStart={e => { if (!canDrag) return; dragIdx.current = i; e.dataTransfer.effectAllowed = 'move'; }}
            onDragOver={e => { if (!canDrag) return; e.preventDefault(); setDragOverIdx(i); }}
            onDragEnd={() => { dragIdx.current = null; setDragOverIdx(null); }}
            onDrop={() => {
              if (!canDrag || dragIdx.current === null || dragIdx.current === i) return;
              onReorder!(dragIdx.current, i);
              dragIdx.current = null;
              setDragOverIdx(null);
            }}
          >
            {canDrag && <GripVertical className={styles.grip} />}
            <span className={styles.swatch} style={{ background: seg.color }} />
            <span>{seg.name}</span>
            <span className={styles.percentage}>{seg.percentage}%</span>
          </div>
        ))}
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
    </div>
  );
}
