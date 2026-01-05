import React, { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  FileAudio, ArrowRight, Settings2, Download, Check, Loader2, Globe, FileText, Languages, RefreshCw, Copy
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { toast } from "sonner";

interface Segment {
  start: number;
  end: number;
  text: string;
}

function formatTimestamp(seconds: number): string {
  const pad = (num: number, size: number) => num.toString().padStart(size, '0');
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

export default function TranscribeFile() {
  const { t } = useTranslation();
  const [file, setFile] = useState<string | null>(null);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [currentText, setCurrentText] = useState(""); // For legacy/fallback if needed, or just derived
  const [language, setLanguage] = useState("auto");
  const [translate, setTranslate] = useState(false);
  const [outputFormat, setOutputFormat] = useState<"txt" | "srt">("txt");
  const [copySuccess, setCopySuccess] = useState(false); // Feedback state

  // Auto-open picker on mount if no file
  const hasOpenedRef = useRef(false);

  useEffect(() => {
    if (!file && !hasOpenedRef.current) {
      hasOpenedRef.current = true;
      handleSelectFile();
    }
  }, []);

  const handleSelectFile = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{
          name: "Audio",
          extensions: ["wav", "mp3", "ogg", "opus", "m4a", "flac"]
        }]
      });
      if (selected) {
        setFile(selected as string);
        setSegments([]);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleTranscribe = async () => {
    if (!file) return;
    setIsTranscribing(true);
    setSegments([]);
    try {
      // The backend now returns (string, segments), but we listen to events mainly.
      // We can ignore the return if events cover it, but let's see.
      await invoke("transcribe_file", {
        path: file,
        options: {
          language: language === "auto" ? null : language,
          translate: translate,
        }
      });
    } catch (error) {
      console.error(error);
      toast.error("Transcription failed: " + error);
      setIsTranscribing(false);
    }
  };

  const generateContent = (format: "txt" | "srt") => {
    if (format === "srt") {
      return segments.map((s, i) => {
        return `${i + 1}\n${formatTimestamp(s.start)} --> ${formatTimestamp(s.end)}\n${s.text}\n`;
      }).join("\n");
    } else {
      return segments.map(s => s.text).join(" ");
    }
  };

  const handleCopy = async () => {
    if (segments.length === 0) return;
    try {
      const content = generateContent(outputFormat);
      await navigator.clipboard.writeText(content);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
      toast.success(`Copied ${outputFormat.toUpperCase()} to clipboard`);
    } catch (err) {
      toast.error("Failed to copy");
    }
  };

  const handleSave = async () => {
    if (segments.length === 0) return;
    try {
      const path = await save({
        filters: [{
          name: outputFormat === 'srt' ? 'Subtitles' : 'Text',
          extensions: [outputFormat]
        }]
      });
      if (path) {
        const content = generateContent(outputFormat);
        await writeTextFile(path, content);
        toast.success("Saved to " + path);
      }
    } catch (e) {
      console.error(e);
      toast.error("Failed to save: " + e);
    }
  };

  useEffect(() => {
    const setupListener = async () => {
      const unlistenProgress = await listen<any>("transcription-progress", (event) => {
        // Append new segments
        // Assuming event.payload.segments is Segment[]
        setSegments((prev) => [...prev, ...event.payload.segments]);
      });

      const unlistenComplete = await listen<any>("file-transcription-completed", (event) => {
        setIsTranscribing(false);
        // Set final authoritative segments
        if (event.payload.segments) {
          setSegments(event.payload.segments);
        }
        toast.success("Transcription completed!");
      });
      return () => {
        unlistenProgress();
        unlistenComplete();
      };
    };
    const unlistenPromise = setupListener();
    return () => {
      unlistenPromise.then(unlisten => unlisten());
    };
  }, []);

  return (
    <div className="h-screen flex flex-col bg-background text-foreground font-sans select-none overflow-hidden">
      {/* Header / Toolbar */}
      <div className="px-6 py-4 border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 flex items-center justify-between shrink-0 z-10">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg transition-colors ${file ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
            <FileAudio className="w-5 h-5" />
          </div>
          <div className="flex flex-col">
            <span className="font-semibold tracking-tight text-sm">
              {file ? file.split(/[/\\]/).pop() : "No file selected"}
            </span>
            <span className="text-xs text-muted-foreground">
              {isTranscribing ? "Transcribing (streaming)..." : file ? "Ready to transcribe" : "Select a file"}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleSelectFile}
            className="p-2 hover:bg-secondary rounded-md text-muted-foreground hover:text-foreground transition-colors"
            title="Open File"
          >
            <FileText className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col relative overflow-hidden bg-background">
        {/* Scrollable Container */}
        <div className="flex-1 overflow-y-auto p-0 scrollbar-thin scrollbar-thumb-secondary scrollbar-track-transparent select-text">
          {segments.length > 0 ? (
            <div className="min-h-full">
              {outputFormat === "srt" ? (
                <div className="font-mono text-sm">
                  {segments.map((segment, i) => (
                    <div key={i} className="flex hover:bg-white/5 transition-colors border-b border-border/20 group">
                      <div className="shrink-0 px-4 py-3 select-none border-r border-border/20 bg-muted/10 text-muted-foreground w-[280px] flex items-center justify-center gap-2 font-medium tracking-wide">
                        <span className="text-[10px] uppercase opacity-70 tracking-widest text-[#da5893]">
                          {formatTimestamp(segment.start).split(',')[0]}
                        </span>
                        <div className="w-4 h-px bg-border/50"></div>
                        <span className="text-[10px] uppercase opacity-70 tracking-widest text-[#da5893]">
                          {formatTimestamp(segment.end).split(',')[0]}
                        </span>
                      </div>
                      <div className="px-6 py-3 text-foreground/90 leading-relaxed tracking-wide flex items-center selection:bg-[#da5893]/30">
                        {segment.text}
                      </div>
                    </div>
                  ))}
                  {isTranscribing && (
                    <div className="p-4 flex items-center justify-center text-muted-foreground animate-pulse tracking-widest text-xs uppercase">
                      <Loader2 className="w-3 h-3 mr-2 animate-spin" />
                      Awaiting Audio...
                    </div>
                  )}
                </div>
              ) : (
                <div className="p-12 max-w-4xl mx-auto animate-in fade-in duration-500">
                  <div className="leading-8 text-foreground/90 font-light text-lg tracking-wide selection:bg-[#da5893]/30">
                    {segments.map((s) => s.text).join(" ")}
                    {isTranscribing && <span className="inline-block w-2 h-5 ml-1 bg-[#da5893] animate-pulse align-middle" />}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center p-8 text-center space-y-8 animate-in zoom-in-95 duration-300 select-none">
              {isTranscribing ? (
                <>
                  <div className="relative">
                    <Loader2 className="w-16 h-16 text-[#da5893] animate-spin relative z-10" />
                  </div>
                  <div className="space-y-2">
                    <h3 className="text-xl font-light tracking-widest uppercase text-[#da5893]">Transcribing</h3>
                    <p className="text-muted-foreground text-xs uppercase tracking-widest">
                      Processing Stream
                    </p>
                  </div>
                </>
              ) : (
                <div className="max-w-md w-full space-y-8">
                  {/* Options Panel: Neo-Art-Deco Style */}
                  <div className="grid gap-4 bg-secondary/10 p-6 rounded-none border border-border/50 backdrop-blur-md">
                    <div className="flex items-center justify-between border-b border-border/20 pb-4">
                      <label className="text-xs font-bold uppercase tracking-widest flex items-center gap-2 text-muted-foreground">
                        <Globe className="w-3 h-3" /> Translation
                      </label>
                      <button
                        onClick={() => setTranslate(!translate)}
                        className={`px-4 py-1.5 rounded-none text-[10px] font-bold uppercase tracking-widest transition-all border ${translate
                          ? "bg-[#da5893]/10 border-[#da5893] text-[#da5893]"
                          : "bg-transparent border-border text-muted-foreground hover:bg-white/5"
                          }`}
                      >
                        {translate ? "Active" : "Disabled"}
                      </button>
                    </div>

                    <div className="flex items-center justify-between pt-2">
                      <label className="text-xs font-bold uppercase tracking-widest flex items-center gap-2 text-muted-foreground">
                        <FileText className="w-3 h-3" /> Format
                      </label>
                      <div className="flex gap-2">
                        <button
                          onClick={() => setOutputFormat("txt")}
                          className={`px-4 py-1.5 min-w-[60px] text-[10px] font-bold uppercase tracking-widest transition-all border ${outputFormat === "txt"
                            ? "bg-[#da5893] border-[#da5893] text-zinc-900"
                            : "bg-transparent border-border text-muted-foreground hover:bg-white/5"
                            }`}
                        >
                          TXT
                        </button>
                        <button
                          onClick={() => setOutputFormat("srt")}
                          className={`px-4 py-1.5 min-w-[60px] text-[10px] font-bold uppercase tracking-widest transition-all border ${outputFormat === "srt"
                            ? "bg-[#da5893] border-[#da5893] text-zinc-900"
                            : "bg-transparent border-border text-muted-foreground hover:bg-white/5"
                            }`}
                        >
                          SRT
                        </button>
                      </div>
                    </div>
                  </div>

                  {file && (
                    <button
                      onClick={handleTranscribe}
                      className="w-full py-4 bg-[#da5893] text-white rounded-none font-bold text-xs uppercase tracking-[0.2em] hover:bg-[#da5893]/90 active:scale-[0.99] transition-all flex items-center justify-center gap-3 border border-[#da5893]"
                    >
                      Start Transcription
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer actions for Result */}
        {segments.length > 0 && (
          <div className="p-4 border-t border-border/40 bg-background/95 backdrop-blur flex justify-between items-center animate-in slide-in-from-bottom-full duration-300 z-20">
            <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              {segments.reduce((acc, s) => acc + s.text.length, 0)} characters
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => { setSegments([]); setFile(null); }}
                className="p-2 rounded-none text-muted-foreground hover:bg-secondary/20 transition-colors border border-transparent hover:border-border"
                title="New Transcription"
              >
                <RefreshCw className="w-4 h-4" />
              </button>

              <div className="h-8 w-px bg-border/30 mx-2"></div>

              <button
                onClick={handleSave}
                className="px-6 py-2 bg-transparent text-foreground border border-border hover:bg-white/5 hover:border-[#da5893]/50 transition-all text-[10px] font-bold uppercase tracking-widest flex items-center gap-2 group"
              >
                <Download className="w-3 h-3 group-hover:text-[#da5893] transition-colors" />
                Save {outputFormat}
              </button>
              <button
                onClick={handleCopy}
                className={`px-6 py-2 border transition-all text-[10px] font-bold uppercase tracking-widest flex items-center gap-2 min-w-[140px] justify-center ${copySuccess
                  ? "bg-green-500/10 border-green-500 text-green-500"
                  : "bg-[#da5893] border-[#da5893] text-zinc-900 hover:bg-[#da5893]/90"
                  }`}
              >
                {copySuccess ? (
                  <>
                    <Check className="w-3 h-3" /> Copied!
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" /> Copy Text
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
