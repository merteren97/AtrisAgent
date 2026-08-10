import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type Language = 'en' | 'tr';

interface LanguageState {
  language: Language;
  setLanguage: (lang: Language) => void;
}

export const useLanguageStore = create<LanguageState>()(
  persist(
    (set) => ({
      language: 'en',
      setLanguage: (lang) => set({ language: lang }),
    }),
    {
      name: 'atris-language-storage',
    }
  )
);

const translations: Record<Language, Record<string, string>> = {
  en: {
    'Workspaces': 'Workspaces',
    'Active Missions': 'Active Missions',
    'Needs Review': 'Needs Review',
    'Pending': 'Pending',
    'Settings': 'Settings',
    'Projects': 'Projects',
    'Agents': 'Agents',
    'Developer Mode': 'Developer Mode',
    'Active Mission': 'Active Mission',
    'Pause': 'Pause',
    'Play': 'Play',
    'Stop': 'Stop',
    'Retry': 'Retry',
    'Start a mission...': 'Start a mission...',
    'Model & Reasoning Selection': 'Model & Reasoning Selection',
    'Send': 'Send',
    'Trust Mode': 'Trust Mode',
    'Reasoning': 'Reasoning',
    'Account Profiles': 'Account Profiles',
    'General': 'General',
    'About': 'About',
    'Language': 'Language',
    'Select Language': 'Select Language',
    'Add Profile': 'Add Profile',
    'Login': 'Login',
    'Theme': 'Theme',
    'Save': 'Save',
    'Cancel': 'Cancel',
    'Close': 'Close',
    'Connected': 'Connected',
    'Not Configured': 'Not Configured'
  },
  tr: {
    'Workspaces': 'Çalışma Alanları',
    'Active Missions': 'Aktif Görevler',
    'Needs Review': 'İnceleme Bekliyor',
    'Pending': 'Bekliyor',
    'Settings': 'Ayarlar',
    'Projects': 'Projeler',
    'Agents': 'Ajanlar',
    'Developer Mode': 'Geliştirici Modu',
    'Active Mission': 'Aktif Görev',
    'Pause': 'Duraklat',
    'Play': 'Oynat',
    'Stop': 'Durdur',
    'Retry': 'Yeniden Dene',
    'Start a mission...': 'Bir görev başlat...',
    'Model & Reasoning Selection': 'Model ve Akıl Yürütme Seçimi',
    'Send': 'Gönder',
    'Trust Mode': 'Güven Modu',
    'Reasoning': 'Akıl Yürütme',
    'Account Profiles': 'Hesap Profilleri',
    'General': 'Genel',
    'About': 'Hakkında',
    'Language': 'Dil',
    'Select Language': 'Dil Seç',
    'Add Profile': 'Profil Ekle',
    'Login': 'Giriş Yap',
    'Theme': 'Tema',
    'Save': 'Kaydet',
    'Cancel': 'İptal',
    'Close': 'Kapat',
    'Connected': 'Bağlı',
    'Not Configured': 'Yapılandırılmadı'
  }
};

export function t(key: string): string {
  const state = useLanguageStore.getState();
  const lang = state.language;
  return translations[lang]?.[key] || key;
}
