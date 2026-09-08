import fs from 'node:fs';
import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

const siteUrl = process.env.PUBLIC_SITE_URL || 'https://spotibai.lol';
const catalogData = JSON.parse(fs.readFileSync(new URL('./src/data/spotify.json', import.meta.url), 'utf-8'));
const trackUrls = (catalogData.songs || []).map((song) => `${siteUrl}/track/${song.id}`);

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
      customPages: [siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`, ...trackUrls],
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
