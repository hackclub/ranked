import vinext from "vinext";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { nitro } from "nitro/vite";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig(() => {
  return {
    resolve: {
      alias: {
        "monaco-editor/esm/vs/editor/editor.api.js": fileURLToPath(
          new URL("./node_modules/monaco-editor/esm/vs/editor/editor.api.js", import.meta.url),
        ),
      },
    },
    server: {
      host: "0.0.0.0",
      ...(isCodexSeatbeltSandbox ? { watch: { useFsEvents: false, usePolling: true } } : {}),
    },
    plugins: [
      vinext(),
      nitro(),
    ],
  };
});
