import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
export default defineConfig({
  root: "editor",
  plugins: [
    react(),
    {
      name: "bundled-dependencies",
      generateBundle(_options, bundle) {
        const dependencies = new Set<string>();
        for (const chunk of Object.values(bundle))
          if (chunk.type === "chunk")
            for (const [path, module] of Object.entries(chunk.modules))
              if (module.renderedLength > 0 && path.includes("node_modules/")) dependencies.add(path);
        this.emitFile({ type: "asset", fileName: "dependencies.json", source: JSON.stringify([...dependencies]) });
      },
    },
    viteSingleFile(),
  ],
  build: {
    outDir: "../dist/editor",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
});
