import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_DEV_API_TARGET || 'http://127.0.0.1:4000';

  return {
    plugins: [react()],
    server: {
      port: 5173,
      // Proxying in development keeps the app and API same-origin, so session
      // cookies behave exactly as they will in production behind one domain.
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
        '/realtime': { target: apiTarget, changeOrigin: true, ws: true },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: mode !== 'production',
      // libsodium is ~1 MB before gzip and is loaded as its own cacheable chunk.
      // That is the cost of doing real cryptography in the browser, so the default
      // warning is not useful here.
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        output: {
          manualChunks: {
            // libsodium is large and rarely changes; keep it in its own cacheable chunk.
            crypto: ['libsodium-wrappers-sumo'],
            vendor: ['react', 'react-dom', 'react-router-dom'],
          },
        },
      },
    },
  };
});
