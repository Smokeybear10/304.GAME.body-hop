import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/client",
  base: "./",
  publicDir: false,
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
    target: "es2023",
    rollupOptions: {
      input: {
        splash: resolve("src/client/splash.html"),
        game: resolve("src/client/game.html"),
      },
    },
  },
  server: {
    port: 2537,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
  plugins: [
    {
      name: "local-game-entry",
      configureServer(server) {
        server.middlewares.use((request, _response, next) => {
          if (request.url === "/" || request.url?.startsWith("/?"))
            request.url = `/game.html${request.url.slice(1)}`;
          next();
        });
      },
    },
  ],
});
