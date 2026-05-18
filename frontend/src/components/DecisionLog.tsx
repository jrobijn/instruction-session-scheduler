import { useState, useRef, useEffect } from 'react';
import { useT } from '../i18n';

interface DecisionLogData {
  trigger: 'batch_schedule' | 'replacement';
  student_priority: number;
  candidate_rank: number;
  candidates_considered: number;
  group_name: string | null;
  group_color: string | null;
  group_quota: string | null;
  preferred_timeslots: string[] | null;
  preferred_days: number[] | null;
  buddy_placed_near: string | null;
  overflow: boolean;
  replaced_student: string | null;
  replacement_reason: string | null;
  same_group_match: boolean;
}

export default function DecisionLog({ decisionLog }: { decisionLog: string | null }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [above, setAbove] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const handleToggle = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setAbove(rect.bottom + 300 > window.innerHeight);
    }
    setOpen(!open);
  };

  if (!decisionLog) return null;

  let data: DecisionLogData;
  try {
    data = JSON.parse(decisionLog);
  } catch {
    return null;
  }

  const isReplacement = data.trigger === 'replacement';

  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <button
        ref={btnRef}
        onClick={handleToggle}
        title={t.decisionLogTitle}
        className="decision-log-btn"
        style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: '0 0.2rem',
          color: 'var(--text-muted)', fontSize: '0.85rem', lineHeight: 1,
          display: 'inline-flex', alignItems: 'center',
          opacity: open ? 1 : 0, transition: 'opacity 0.15s',
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <path d="M12 16v-4"/>
          <path d="M12 8h.01"/>
        </svg>
      </button>
      {open && (
        <div style={{
          position: 'absolute', left: '50%',
          ...(above ? { bottom: '100%', transform: 'translateX(-50%)', marginBottom: '0.4rem' } : { top: '100%', transform: 'translateX(-50%)', marginTop: '0.4rem' }),
          zIndex: 100,
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: '0.75rem', padding: '0.85rem 1rem',
          boxShadow: '0 8px 24px var(--shadow)', minWidth: '260px', maxWidth: '320px',
          fontSize: '0.8rem', lineHeight: 1.6,
        }}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.6rem' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z"/>
            </svg>
            <span style={{ fontWeight: 700, fontSize: '0.85rem' }}>{t.decisionLogTitle}</span>
          </div>

          {/* Trigger badge */}
          <div style={{ marginBottom: '0.6rem' }}>
            <span style={{
              display: 'inline-block', padding: '0.2rem 0.55rem', borderRadius: '999px',
              fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.02em',
              background: isReplacement ? 'color-mix(in srgb, var(--warning) 15%, var(--surface))' : 'color-mix(in srgb, var(--primary) 15%, var(--surface))',
              color: isReplacement ? 'var(--warning)' : 'var(--primary)',
              border: `1px solid ${isReplacement ? 'color-mix(in srgb, var(--warning) 30%, var(--surface))' : 'color-mix(in srgb, var(--primary) 30%, var(--surface))'}`,
            }}>
              {isReplacement ? t.decisionTriggerReplacement : t.decisionTriggerBatch}
            </span>
          </div>

          {/* Replacement context */}
          {isReplacement && data.replaced_student && (
            <div style={{
              background: 'var(--bg)', borderRadius: '0.5rem', padding: '0.4rem 0.65rem',
              marginBottom: '0.6rem', border: '1px solid var(--border)',
              fontSize: '0.75rem', color: 'var(--text-muted)',
            }}>
              {t.decisionReplacedStudent(data.replaced_student)}
            </div>
          )}

          {/* Selection details */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            {/* Priority + Rank — unified element */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: '0.6rem',
              background: 'var(--bg)', borderRadius: '0.5rem', padding: '0.45rem 0.6rem',
              border: '1px solid var(--border)',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: '28px', height: '28px', borderRadius: '50%',
                background: 'var(--primary)', color: 'white',
                fontWeight: 700, fontSize: '0.85rem', flexShrink: 0,
              }}>
                {data.student_priority}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.3 }}>
                <span style={{ fontSize: '0.78rem', fontWeight: 600 }}>
                  {t.decisionPriority} {data.student_priority}
                </span>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                  {t.decisionCandidateRank(data.candidate_rank, data.candidates_considered)}
                </span>
              </div>
            </div>

            {/* Group info */}
            {data.group_name && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
                  background: 'var(--bg)', border: '1px solid var(--border)',
                  borderRadius: '0.35rem', padding: '0.15rem 0.45rem',
                }}>
                  <span style={{
                    width: '8px', height: '8px', borderRadius: '50%',
                    background: data.group_color || '#3b82f6', display: 'inline-block', flexShrink: 0,
                  }} />
                  <span style={{ fontSize: '0.75rem', fontWeight: 500 }}>{data.group_name}</span>
                </span>
                {data.group_quota && (
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{data.group_quota}</span>
                )}
              </div>
            )}

            {/* Preferences section */}
            {((data.preferred_timeslots && data.preferred_timeslots.length > 0) || (data.preferred_days && data.preferred_days.length > 0 && data.preferred_days.length < 7)) && (<>
              <div style={{ borderTop: '1px solid var(--border)', margin: '0.2rem 0' }} />
              {data.preferred_days && data.preferred_days.length > 0 && data.preferred_days.length < 7 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                    {t.decisionPreferredDays}
                  </span>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                    {data.preferred_days.map((day) => (
                      <span key={day} style={{
                        display: 'inline-block', padding: '0.1rem 0.4rem', borderRadius: '0.3rem',
                        fontSize: '0.73rem', fontWeight: 500,
                        background: 'var(--bg)', border: '1px solid var(--border)',
                      }}>
                        {t.days[day]}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {data.preferred_timeslots && data.preferred_timeslots.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                    {t.decisionPreferredTimeslots}
                  </span>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                    {data.preferred_timeslots.map((ts) => (
                      <span key={ts} style={{
                        display: 'inline-block', padding: '0.1rem 0.4rem', borderRadius: '0.3rem',
                        fontSize: '0.73rem', fontWeight: 500,
                        background: 'var(--bg)', border: '1px solid var(--border)',
                      }}>
                        {ts}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>)}

            {/* Explanatory messages */}
            {(data.buddy_placed_near || data.overflow || isReplacement) && (
              <div style={{ borderTop: '1px solid var(--border)', margin: '0.2rem 0' }} />
            )}
            {data.buddy_placed_near && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="var(--primary)" xmlns="http://www.w3.org/2000/svg">
                  <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
                </svg>
                <span style={{ fontSize: '0.78rem' }}>{t.decisionBuddyPlacedNear(data.buddy_placed_near)}</span>
              </div>
            )}
            {data.overflow && (
              <div style={{
                fontSize: '0.72rem', color: 'var(--text-muted)', fontStyle: 'italic',
                background: 'var(--bg)', padding: '0.25rem 0.5rem', borderRadius: '0.35rem',
              }}>
                {t.decisionOverflow}
              </div>
            )}
            {isReplacement && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <span style={{ color: data.same_group_match ? 'var(--success, #16a34a)' : 'var(--text-muted)' }}>
                  {data.same_group_match ? '✓' : '⤳'}
                </span>
                <span style={{ fontSize: '0.78rem' }}>
                  {data.same_group_match ? t.decisionSameGroupMatch : t.decisionCrossGroupMatch}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </span>
  );
}

function Pill({ label, value }: { label: string; value: string }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
      background: 'var(--bg)', border: '1px solid var(--border)',
      borderRadius: '0.35rem', padding: '0.15rem 0.45rem',
      fontSize: '0.75rem',
    }}>
      <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>{label}</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
    </span>
  );
}
