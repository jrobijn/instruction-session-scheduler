import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import en from './en';
import nl from './nl';

export type Translations = typeof en;

const locales: Record<string, Translations> = { en, nl };

const I18nContext = createContext<Translations>(en);

export function useT(): Translations {
  return useContext(I18nContext);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<string>(() => localStorage.getItem('locale') || 'en');

  useEffect(() => {
    const handler = () => setLocale(localStorage.getItem('locale') || 'en');
    window.addEventListener('locale-changed', handler);
    return () => window.removeEventListener('locale-changed', handler);
  }, []);

  const translations = locales[locale] || en;

  return (
    <I18nContext.Provider value={translations}>
      {children}
    </I18nContext.Provider>
  );
}

export function setLocale(locale: string) {
  localStorage.setItem('locale', locale);
  window.dispatchEvent(new Event('locale-changed'));
}

export function getLocale(): string {
  return localStorage.getItem('locale') || 'en';
}

export function getAvailableLocales(): string[] {
  return Object.keys(locales);
}

export function registerLocale(code: string, translations: Translations) {
  locales[code] = translations;
}
