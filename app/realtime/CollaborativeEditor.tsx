"use client";

import dynamic from "next/dynamic";
import { getYjsProviderForRoom } from "@liveblocks/yjs";
import type { Room } from "@liveblocks/client";
import type { editor as MonacoEditorApi } from "monaco-editor";
import { useEffect, useRef, useState } from "react";

const Editor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => <div className="editor-loading">Joining the shared editor…</div>,
});

export function CollaborativeEditor({
  room,
  file,
  initialValue,
  onChange,
  onLocalEdit,
}: {
  room: Room | null;
  file: string;
  initialValue: string;
  onChange: (value: string) => void;
  onLocalEdit?: (activity: {
    file: string;
    lines: number;
    line: number;
    cursorPosition: number;
  }) => void;
}) {
  const editorRef = useRef<MonacoEditorApi.IStandaloneCodeEditor | null>(null);
  const fileRef = useRef(file);
  const onLocalEditRef = useRef(onLocalEdit);
  const localActivityDisposablesRef = useRef<Array<{ dispose: () => void }>>(
    [],
  );
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    onLocalEditRef.current = onLocalEdit;
  }, [onLocalEdit]);

  useEffect(() => {
    fileRef.current = file;
  }, [file]);

  useEffect(
    () => () => {
      for (const disposable of localActivityDisposablesRef.current) {
        disposable.dispose();
      }
      localActivityDisposablesRef.current = [];
    },
    [],
  );

  useEffect(() => {
    if (!room || !editorRef.current || !mounted) return;
    const provider = getYjsProviderForRoom(room, { offlineSupport_experimental: true });
    const doc = provider.getYDoc();
    const text = doc.getText(`file:${file}`);
    const editor = editorRef.current;
    const model = editor.getModel();
    if (!model) return;

    let disposed = false;
    let cleanup = () => {};
    void import("y-monaco").then(({ MonacoBinding }) => {
      if (disposed) return;
      let seeded = false;
      const seed = (synced: boolean) => {
        if (!synced || seeded) return;
        seeded = true;
        if (text.length === 0) text.insert(0, initialValue);
        onChange(text.toString());
      };
      provider.on("sync", seed);
      seed(provider.synced);
      const binding = new MonacoBinding(text, model, new Set([editor]), provider.awareness as never);
      const update = () => onChange(text.toString());
      text.observe(update);
      cleanup = () => {
        text.unobserve(update);
        provider.off("sync", seed);
        binding.destroy();
      };
    });
    return () => {
      disposed = true;
      cleanup();
    };
  }, [file, initialValue, mounted, onChange, room]);

  return (
    <Editor
      height="100%"
      defaultValue=""
      language={file.endsWith("css") ? "css" : file.endsWith("js") ? "javascript" : "html"}
      onMount={(editor) => {
        editorRef.current = editor;
        const reportLocalEdit = () => {
          const model = editor.getModel();
          const position = editor.getPosition();
          if (!model || !position) return;
          onLocalEditRef.current?.({
            file: fileRef.current,
            lines: model.getLineCount(),
            line: position.lineNumber,
            cursorPosition: model.getOffsetAt(position) + 1,
          });
        };
        localActivityDisposablesRef.current = [
          editor.onKeyDown((event) => {
            const key = event.browserEvent.key;
            const isTextKey =
              key.length === 1 &&
              !event.browserEvent.metaKey &&
              !event.browserEvent.ctrlKey &&
              !event.browserEvent.altKey;
            const isEditingKey = ["Backspace", "Delete", "Enter", "Tab"].includes(
              key,
            );
            const isCut =
              (event.browserEvent.metaKey || event.browserEvent.ctrlKey) &&
              key.toLowerCase() === "x";
            if (isTextKey || isEditingKey || isCut) reportLocalEdit();
          }),
          editor.onDidPaste(reportLocalEdit),
          editor.onDidCompositionEnd(reportLocalEdit),
        ];
        setMounted(true);
      }}
      theme="vs-dark"
      options={{ minimap: { enabled: false }, fontSize: 14, fontFamily: "var(--font-geist-mono)", padding: { top: 16 }, lineNumbersMinChars: 3, scrollBeyondLastLine: false, wordWrap: "on", tabSize: 2 }}
    />
  );
}
