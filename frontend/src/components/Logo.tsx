import { useTheme } from '../ThemeContext';

/** Club crest; switches to the white variant in dark mode. */
export default function Logo({ className }: { className?: string }) {
  const { mode } = useTheme();
  const dark = mode === 'dark' || (mode === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  return <img className={className} src={dark ? '/logo-white.png' : '/logo.png'} alt="Logo" />;
}
