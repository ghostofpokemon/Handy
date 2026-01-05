import React, { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  FileAudio, ArrowRight, Settings2, Download, Check, Globe, FileText, RefreshCw, Copy, StopCircle, Disc
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

const LANGUAGES = [
  { code: "auto", label: "Auto Detect" },
  { code: "en", label: "English" },
  { code: "de", label: "German" },
  { code: "fr", label: "French" },
  { code: "es", label: "Spanish" },
  { code: "ja", label: "Japanese" },
  { code: "ru", label: "Russian" },
  { code: "zh", label: "Chinese" },
];

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
  const [language, setLanguage] = useState("auto");
  const [translate, setTranslate] = useState(false);
  const [outputFormat, setOutputFormat] = useState<"txt" | "srt">("txt");
  const [copySuccess, setCopySuccess] = useState(false);

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

  const handleCancel = async () => {
    try {
      await invoke("cancel_transcription");
      toast.info("Stopping transcription...");
      // State reset will happen when loop breaks or we manually force it?
      // Ideally backend returns/emits completion even on cancel, but let's ensure UI updates
    } catch (e) {
      console.error("Failed to cancel", e);
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
        setSegments((prev) => [...prev, ...event.payload.segments]);
      });

      const unlistenComplete = await listen<any>("file-transcription-completed", (event) => {
        setIsTranscribing(false);
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
    <div className="h-screen flex flex-col bg-background text-foreground font-sans select-none overflow-hidden deco-bg">
      {/* Header / Toolbar */}
      <div className="px-6 py-4 flex items-center justify-between shrink-0 z-10 border-b border-border/10 bg-background/80 backdrop-blur-md">
        <div className="flex items-center gap-4">
          <div className={`p-2 transition-colors border-2 border-primary/50 ${file ? "bg-primary text-black shadow-[4px_4px_0_0_rgba(0,0,0,1)]" : "bg-muted text-muted-foreground"}`}>
            <Disc className={`w-6 h-6 ${isTranscribing ? "animate-spin" : ""}`} />
          </div>
          <div className="flex flex-col">
            <span className="font-bold tracking-widest uppercase text-sm">
              {file ? file.split(/[/\\]/).pop() : "NO CARTRIDGE"}
            </span>
            <span className="text-[10px] uppercase tracking-[0.2em] text-[#da5893] font-bold">
              {isTranscribing ? "PROCESSING STREAM" : file ? "READY" : "INSERT MEDIA"}
            </span>
          </div>
        </div>

        <button
          onClick={handleSelectFile}
          className="tactile-button px-4 py-2 text-xs font-bold uppercase tracking-widest flex items-center gap-2 hover:text-[#da5893]"
        >
          <FileAudio className="w-4 h-4" /> Load
        </button>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col relative overflow-hidden">
        {/* Scrollable Container */}
        <div className="flex-1 overflow-y-auto p-0 scrollbar-thin scrollbar-thumb-[#da5893] scrollbar-track-transparent select-text">
          {segments.length > 0 ? (
            <div className="min-h-full bg-black/10">
              {outputFormat === "srt" ? (
                <div className="font-mono text-sm p-4 space-y-4">
                  {segments.map((segment, i) => (
                    <div key={i} className="flex group relative">
                      {/* Decorative bracket */}
                      <div className="absolute left-0 top-0 bottom-0 w-1 border-l-2 border-t-2 border-b-2 border-[#da5893] opacity-30"></div>

                      <div className="shrink-0 px-4 py-2 select-none text-muted-foreground w-[200px] font-bold tracking-wide text-xs flex flex-col justify-center">
                        <span className="text-[#da5893]">{formatTimestamp(segment.start).split(',')[0]}</span>
                        <span className="w-full h-px bg-border/20 my-1"></span>
                        <span className="text-[#da5893] opacity-60">{formatTimestamp(segment.end).split(',')[0]}</span>
                      </div>
                      <div className="px-6 py-2 text-foreground/90 leading-relaxed font-medium">
                        {segment.text}
                      </div>
                    </div>
                  ))}
                  {isTranscribing && (
                    <div className="p-4 flex items-center justify-center text-[#da5893] tracking-widest text-xs uppercase animate-pulse">
                      Reading Sector...
                    </div>
                  )}
                </div>
              ) : (
                <div className="p-12 max-w-4xl mx-auto">
                  <div className="leading-8 text-foreground/90 font-medium text-lg tracking-wide pl-6 border-l-4 border-[#da5893]">
                    {segments.map((s) => s.text).join(" ")}
                    {isTranscribing && <span className="inline-block w-3 h-5 ml-2 bg-[#da5893] animate-pulse align-middle" />}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center p-8 text-center space-y-8 select-none">
              {isTranscribing ? (
                <div className="winamp-panel p-8 bg-black/40 flex flex-col items-center gap-6 max-w-sm w-full">
                  <div className="w-full h-4 bg-black border border-white/20 p-1">
                    {/* Fake mechanical progress bar */}
                    <div className="h-full bg-[#da5893] w-[60%] animate-pulse"></div>
                  </div>
                  <h3 className="text-xl font-bold tracking-[0.3em] uppercase text-[#da5893]">Transcribing</h3>
                  <button
                    onClick={handleCancel}
                    className="tactile-button w-full py-3 bg-red-900/50 border-red-500 text-red-500 font-bold uppercase tracking-widest hover:bg-red-500 hover:text-white"
                  >
                    <StopCircle className="w-4 h-4 inline mr-2" /> Stop Operation
                  </button>
                </div>
              ) : (
                <div className="max-w-md w-full space-y-8">
                  <div className="winamp-panel p-6 bg-[#2a2a2a]">
                    {/* Header Line */}
                    <div className="flex items-center gap-2 mb-6 opacity-70">
                      <span className="h-px w-8 bg-current"></span>
                      <span className="text-[10px] uppercase font-bold tracking-widest">Configuration</span>
                      <span className="h-px flex-1 bg-current"></span>
                    </div>

                    {/* Language Selector */}
                    <div className="mb-6">
                      <label className="text-[10px] font-bold uppercase tracking-widest text-[#da5893] mb-2 block">
                        Source Language
                      </label>
                      <select
                        value={language}
                        onChange={(e) => setLanguage(e.target.value)}
                        className="w-full bg-[#1a1a1a] text-white border-2 border-[#555] p-2 text-xs font-mono focus:border-[#da5893] focus:outline-none appearance-none rounded-none shadow-[inset_2px_2px_4px_rgba(0,0,0,0.5)]"
                        style={{ backgroundImage: 'none' }}
                      >
                        {LANGUAGES.map(lang => (
                          <option key={lang.code} value={lang.code}>{lang.label} [{lang.code.toUpperCase()}]</option>
                        ))}
                      </select>
                    </div>

                    {/* Translation Toggle */}
                    <div className="flex items-center justify-between mb-6">
                      <label className="text-xs font-bold uppercase flex items-center gap-2">
                        <Globe className="w-4 h-4 text-[#da5893]" />
                        Translate to English
                      </label>
                      <button
                        onClick={() => setTranslate(!translate)}
                        className={`w-12 h-6 border-2 flex items-center p-1 transition-colors ${translate ? 'border-[#da5893] bg-[#da5893]/20' : 'border-gray-600 bg-transparent'}`}
                      >
                        <div className={`w-3 h-3 bg-current transform transition-transform ${translate ? 'translate-x-5 bg-[#da5893]' : 'translate-x-0 bg-gray-500'}`}></div>
                      </button>
                    </div>

                    <div className="h-px w-full bg-white/10 my-4"></div>

                    {/* Format Selector */}
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-bold uppercase flex items-center gap-2">
                        <FileText className="w-3 h-3" /> Output Format
                      </label>
                      <div className="flex gap-2">
                        {["txt", "srt"].map((fmt) => (
                          <button
                            key={fmt}
                            onClick={() => setOutputFormat(fmt as "txt" | "srt")}
                            className={`px-3 py-1 text-[10px] font-bold uppercase tracking-widest border-2 ${outputFormat === fmt
                              ? "border-[#da5893] text-[#da5893] bg-black/50 shadow-[inset_1px_1px_4px_rgba(0,0,0,0.8)]"
                              : "border-transparent text-muted-foreground hover:bg-white/5"}`}
                          >
                            {fmt.toUpperCase()}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {file && (
                    <button
                      onClick={handleTranscribe}
                      className="tactile-button-primary w-full py-4 text-sm font-bold uppercase tracking-[0.2em] flex items-center justify-center gap-3"
                    >
                      Initialize Transcription
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer actions */}
        {segments.length > 0 && (
          <div className="p-4 border-t-2 border-white/10 bg-[#2a2a2a] flex justify-between items-center z-20">
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 bg-[#da5893]"></div>
              <div className="text-[10px] font-mono uppercase tracking-widest opacity-70">
                {segments.reduce((acc, s) => acc + s.text.length, 0)} CHARS
              </div>
            </div>

            <div className="flex gap-4">
              <button
                onClick={() => { setSegments([]); setFile(null); }}
                className="tactile-button px-3 py-2 text-muted-foreground hover:text-white"
                title="Reset"
              >
                <RefreshCw className="w-4 h-4" />
              </button>

              <button
                onClick={handleSave}
                className="tactile-button px-6 py-2 text-[10px] font-bold uppercase tracking-widest flex items-center gap-2 hover:text-[#da5893]"
              >
                <Download className="w-3 h-3" />
                Save Data
              </button>

              <button
                onClick={handleCopy}
                className={`tactile-button px-6 py-2 text-[10px] font-bold uppercase tracking-widest flex items-center gap-2 min-w-[140px] justify-center ${copySuccess ? "text-green-500 border-green-500" : "text-[#da5893] border-[#da5893]"}`}
              >
                {copySuccess ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                {copySuccess ? "COPIED" : "COPY DATA"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
