import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  clearScreen: false,
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (/[/\\]node_modules[/\\](react|react-dom|scheduler)[/\\]/.test(id)) return 'vendor-react';
          if (/[/\\]node_modules[/\\](@radix-ui|radix-ui)[/\\]/.test(id)) return 'vendor-radix';
          if (/[/\\]node_modules[/\\]lucide-react[/\\]/.test(id)) return 'vendor-icons';
          if (/[/\\]node_modules[/\\]@xterm[/\\]/.test(id)) return 'vendor-xterm';
          if (/[/\\]node_modules[/\\]@tauri-apps[/\\]/.test(id)) return 'vendor-tauri';
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
});
