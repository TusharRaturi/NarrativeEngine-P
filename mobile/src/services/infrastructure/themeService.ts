export type ThemeSetting = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export function resolveTheme(setting: ThemeSetting): ResolvedTheme {
    if (setting !== 'system') return setting;
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
        return 'dark';
    }
    return 'light';
}

let activeThemeSetting: ThemeSetting = 'light';
let systemThemeUnsubscribe: (() => void) | null = null;

export function applyTheme(theme: ThemeSetting): void {
    activeThemeSetting = theme;
    document.documentElement.setAttribute('data-theme', resolveTheme(theme));
}

export function watchSystemTheme(callback?: (theme: ResolvedTheme) => void): () => void {
    systemThemeUnsubscribe?.();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
        if (activeThemeSetting === 'system') {
            applyTheme('system');
            if (callback) callback(resolveTheme('system'));
        }
    };
    mq.addEventListener('change', handler);
    systemThemeUnsubscribe = () => {
        mq.removeEventListener('change', handler);
    };
    return systemThemeUnsubscribe;
}

export function applyUIScale(scale: number): void {
    const html = document.documentElement;
    html.style.setProperty('--ui-scale', String(scale));
    
    const root = document.getElementById('root');
    if (root) {
        root.style.width = '';
        root.style.height = '';
        root.style.transform = '';
        root.style.transformOrigin = '';
        root.style.zoom = '';
    }
    html.style.zoom = scale !== 1 ? String(scale) : '';
}
