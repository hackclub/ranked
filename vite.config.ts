import vinext from "vinext";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { nitro } from "nitro/vite";

export default defineConfig(() => {
  return {
    resolve: {
      alias: {
        "monaco-editor/esm/vs/editor/editor.api.js": fileURLToPath(
          new URL("./node_modules/monaco-editor/esm/vs/editor/editor.api.js", import.meta.url),
        ),
      },
    },
    plugins: [
      vinext(),
      nitro(),
    ],
  };
});
