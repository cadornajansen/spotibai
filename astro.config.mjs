import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

const siteUrl = process.env.PUBLIC_SITE_URL || 'https://spotibai.lol';

export default defineConfig({
  site: siteUrl,
  output: 'server',
  security: {
    checkOrigin: false,
  },
  adapter: vercel({
    webAnalytics: {
      enabled: true,
    },
  }),
  publicDir: './songs',
  integrations: [
    sitemap({
      filter: (page) => !page.includes('/api/'),
      customPages: [siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`],
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
