import { defineConfig } from 'vitepress';

// Ollama SDK documentation site — VitePress configuration.
// Teal/emerald accent matches the Ollama brand; dark mode toggle is on by default.
export default defineConfig({
  title: 'Ollama SDK',
  description: 'Production-grade TypeScript SDK for Ollama',
  lang: 'en-US',
  lastUpdated: true,
  cleanUrls: true,

  // GitHub Pages serves the site at https://shubhamtaywade82.github.io/ollama-sdk/
  // The base path must match the repo name. Without this, CSS/JS/assets
  // would resolve to the domain root and 404.
  base: '/ollama-sdk/',

  head: [
    ['meta', { name: 'theme-color', content: '#10b981' }],
    ['meta', { property: 'og:title', content: 'Ollama SDK' }],
    [
      'meta',
      {
        property: 'og:description',
        content: 'Production-grade TypeScript SDK for Ollama.',
      },
    ],
    [
      'meta',
      {
        property: 'og:image',
        content:
          'https://raw.githubusercontent.com/shubhamtaywade82/ollama-sdk/main/docs-site/og.png',
      },
    ],
  ],

  themeConfig: {
    siteTitle: 'Ollama SDK',

    // Teal/emerald accent to match the Ollama brand.
    // VitePress exposes accent as a single CSS variable consumed by the default theme.
    // The custom theme override in `.vitepress/theme/index.ts` injects the full palette.
    logo: '/logo.svg',

    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'API', link: '/api/client' },
      { text: 'Architecture', link: '/adr/' },
      {
        text: 'GitHub',
        link: 'https://github.com/shubhamtaywade82/ollama-sdk',
        target: '_blank',
        rel: 'noopener noreferrer',
      },
      {
        text: 'npm',
        link: 'https://www.npmjs.com/package/@nemesis-oss/ollama-sdk',
        target: '_blank',
        rel: 'noopener noreferrer',
      },
    ],

    sidebar: [
      {
        text: 'Guide',
        collapsed: false,
        items: [
          { text: 'Getting Started', link: '/guide/getting-started' },
          { text: 'Chat', link: '/guide/chat' },
          { text: 'Generate', link: '/guide/generate' },
          { text: 'Embeddings', link: '/guide/embed' },
          { text: 'Streaming', link: '/guide/streaming' },
          { text: 'Failover & Routing', link: '/guide/failover' },
          { text: 'System One Decisions', link: '/guide/system-one' },
          { text: 'OpenAI Compatibility', link: '/guide/openai-compat' },
          { text: 'Anthropic Compatibility', link: '/guide/anthropic-compat' },
          { text: 'MCP Integration', link: '/guide/mcp' },
          { text: 'Agents & Tool Calling', link: '/guide/agents' },
          { text: 'Structured Output', link: '/guide/structured-output' },
          { text: 'Contract-First Architecture', link: '/guide/contract-first' },
        ],
      },
      {
        text: 'API Reference',
        collapsed: false,
        items: [
          { text: 'OllamaClient', link: '/api/client' },
          { text: 'NativeApi (Generated)', link: '/api/native-api' },
          { text: 'Decision Helpers', link: '/api/decision' },
          { text: 'Errors', link: '/api/errors' },
        ],
      },
      {
        text: 'Architecture',
        collapsed: false,
        items: [{ text: 'ADR Index', link: '/adr/' }],
      },
    ],

    socialLinks: [
      {
        icon: 'github',
        link: 'https://github.com/shubhamtaywade82/ollama-sdk',
      },
      {
        icon: 'npm',
        link: 'https://www.npmjs.com/package/@nemesis-oss/ollama-sdk',
      },
    ],

    search: {
      provider: 'local',
      options: {
        // VitePress's local search uses MiniSearch under the hood.
        translations: {
          button: {
            buttonText: 'Search docs',
            buttonAriaLabel: 'Search docs',
          },
          modal: {
            displayDetails: 'Display detailed list',
            resetButtonTitle: 'Reset search',
            backButtonTitle: 'Close search',
            noResultsText: 'No results found.',
            footer: {
              selectText: 'to select',
              navigateText: 'to navigate',
              closeText: 'to close',
            },
          },
        },
      },
    },

    outline: {
      level: [2, 3],
      label: 'On this page',
    },

    docFooter: {
      prev: 'Previous',
      next: 'Next',
    },

    editLink: {
      pattern:
        'https://github.com/shubhamtaywade82/ollama-sdk/edit/main/docs-site/:path',
      text: 'Edit this page on GitHub',
    },

    lastUpdated: {
      text: 'Last updated',
    },

    darkModeSwitchLabel: 'Theme',
    sidebarMenuLabel: 'Menu',
    returnToTopLabel: 'Back to top',
  },
});
