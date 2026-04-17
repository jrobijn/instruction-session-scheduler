import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';

interface ActionItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

export default function ActionDropdown({ actions }: { actions: ActionItem[] }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; openUp: boolean }>({ top: 0, left: 0, openUp: false });

  const updatePos = useCallback(() => {
    if (!btnRef.current || !menuRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const menuHeight = menuRef.current.offsetHeight;
    const openUp = rect.bottom + menuHeight + 4 > window.innerHeight;
    setPos({
      top: openUp ? rect.top - menuHeight - 4 : rect.bottom + 4,
      left: rect.right - menuRef.current.offsetWidth,
      openUp,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    updatePos();
    window.addEventListener('scroll', () => setOpen(false), true);
    window.addEventListener('resize', () => setOpen(false));
    return () => {
      window.removeEventListener('scroll', () => setOpen(false), true);
      window.removeEventListener('resize', () => setOpen(false));
    };
  }, [open, updatePos]);

  const filtered = actions.filter(Boolean);
  if (filtered.length === 0) return null;

  return (
    <>
      <button
        ref={btnRef}
        className="btn btn-outline btn-sm action-dropdown-toggle"
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
      >
        ⋯
      </button>
      {open && createPortal(
        <div ref={menuRef} className="action-dropdown-menu" style={{ top: pos.top, left: pos.left }}>
          {filtered.map((a, i) => (
            <button
              key={i}
              className={`action-dropdown-item${a.danger ? ' action-dropdown-item-danger' : ''}`}
              onClick={(e) => { e.stopPropagation(); setOpen(false); a.onClick(); }}
            >
              {a.label}
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  );
}
