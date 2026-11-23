import { defineConfig, type Plugin } from "vite";

// The lessons use classic <script src> tags (so they also open straight from disk),
// which sit outside Vite's module graph. Reload the page on any saved course file instead.
function reloadOnSave(): Plugin {
  return {
    name: "reload-on-save",
    configureServer(server) {
      const course = /[\\/](lessons|reference|assets)[\\/].*\.(html|js|css)$|[\\/]index\.html$|\.md$/;
      server.watcher.on("change", (file) => {
        if (course.test(file)) server.ws.send({ type: "full-reload", path: "*" });
      });
    },
  };
}

export default defineConfig({
  plugins: [reloadOnSave()],
  server: { port: 5173, open: "/index.html" },
});
