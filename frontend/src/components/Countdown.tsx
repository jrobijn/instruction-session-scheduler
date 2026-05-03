import { useState, useEffect } from 'react';

export default function Countdown({ expiresAt }: { expiresAt: Date }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);
  const diff = Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 1000));
  const h = String(Math.floor(diff / 3600)).padStart(2, '0');
  const m = String(Math.floor((diff % 3600) / 60)).padStart(2, '0');
  const s = String(diff % 60).padStart(2, '0');
  return <>{h}:{m}:{s}</>;
}
