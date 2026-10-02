// Custom theme override for the Ollama SDK documentation site.
//
// The default VitePress theme is re-exported as-is, plus a small CSS block
// that swaps the accent color to a teal/emerald palette to match the Ollama
// brand. The dark mode toggle is built into the default theme and requires
// no JavaScript here.

import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import './styles.css';

export default {
  extends: DefaultTheme,
} satisfies Theme;
