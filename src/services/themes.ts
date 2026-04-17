export type ThemeMode = 'light' | 'dark'

export interface Theme {
  id: string
  label: string
  mode: ThemeMode
  /** [bg, panel, accent] swatches for the picker preview */
  colors: [string, string, string]
}

export const DARK_THEMES: Theme[] = [
  { id: 'dark',        label: 'Dark',             mode: 'dark', colors: ['#0a0b14', '#1a1c2e', '#6366f1'] },
  { id: 'oled',        label: 'OLED',             mode: 'dark', colors: ['#000000', '#0d0d0d', '#6366f1'] },
  { id: 'midnight',    label: 'Midnight',         mode: 'dark', colors: ['#0d1117', '#161b22', '#58a6ff'] },
  { id: 'forest',      label: 'Forest',           mode: 'dark', colors: ['#0d1710', '#172212', '#22c55e'] },
  { id: 'dracula',     label: 'Dracula',          mode: 'dark', colors: ['#1e1f28', '#282a36', '#bd93f9'] },
  { id: 'rose',        label: 'Rose',             mode: 'dark', colors: ['#1a1014', '#251419', '#f472b6'] },
  { id: 'nord',        label: 'Nord',             mode: 'dark', colors: ['#2e3440', '#3b4252', '#88c0d0'] },
  { id: 'solarized',   label: 'Solarized Dark',   mode: 'dark', colors: ['#002b36', '#073642', '#268bd2'] },
  { id: 'gruvbox',     label: 'Gruvbox',          mode: 'dark', colors: ['#282828', '#3c3836', '#fabd2f'] },
  { id: 'catppuccin',  label: 'Catppuccin Mocha', mode: 'dark', colors: ['#1e1e2e', '#313244', '#cba6f7'] },
  { id: 'synthwave',   label: 'Synthwave',        mode: 'dark', colors: ['#241b2f', '#2d1b43', '#ff2ed2'] },
  { id: 'tokyo-night', label: 'Tokyo Night',      mode: 'dark', colors: ['#1a1b26', '#24283b', '#7aa2f7'] },
  { id: 'one-dark',    label: 'One Dark',         mode: 'dark', colors: ['#282c34', '#21252b', '#61afef'] },
  { id: 'rose-pine',   label: 'Rosé Pine',        mode: 'dark', colors: ['#191724', '#1f1d2e', '#c4a7e7'] },
  { id: 'everforest',  label: 'Everforest',       mode: 'dark', colors: ['#2d353b', '#343f44', '#a7c080'] },
  { id: 'monokai',     label: 'Monokai',          mode: 'dark', colors: ['#272822', '#1e1f1c', '#a6e22e'] },
]

export const LIGHT_THEMES: Theme[] = [
  { id: 'light',            label: 'Light',            mode: 'light', colors: ['#f0f2f8', '#e8ecf5', '#6366f1'] },
  { id: 'solarized-light',  label: 'Solarized Light',  mode: 'light', colors: ['#fdf6e3', '#eee8d5', '#268bd2'] },
  { id: 'catppuccin-latte', label: 'Catppuccin Latte', mode: 'light', colors: ['#eff1f5', '#e6e9ef', '#8839ef'] },
  { id: 'nord-light',       label: 'Nord Light',       mode: 'light', colors: ['#eceff4', '#e5e9f0', '#5e81ac'] },
  { id: 'rose-pine-dawn',   label: 'Rosé Pine Dawn',   mode: 'light', colors: ['#faf4ed', '#fffaf3', '#907aa9'] },
]

export const ALL_THEMES: Theme[] = [...DARK_THEMES, ...LIGHT_THEMES]

const THEME_BY_ID = new Map(ALL_THEMES.map(t => [t.id, t]))

export function getThemeMode(id: string): ThemeMode {
  return THEME_BY_ID.get(id)?.mode ?? 'dark'
}
