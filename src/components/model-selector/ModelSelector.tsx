import React, { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { commands, type ModelInfo } from "@/bindings";
import { invoke } from "@tauri-apps/api/core";
import { Globe, Link, Download, RefreshCw, X } from "lucide-react";
import { getTranslatedModelName } from "../../lib/utils/modelTranslation";
import ModelStatusButton from "./ModelStatusButton";
import ModelDropdown from "./ModelDropdown";
import DownloadProgressDisplay from "./DownloadProgressDisplay";

interface ModelStateEvent {
  event_type: string;
  model_id?: string;
  model_name?: string;
  error?: string;
}

interface DownloadProgress {
  model_id: string;
  downloaded: number;
  total: number;
  percentage: number;
}

type ModelStatus =
  | "ready"
  | "loading"
  | "downloading"
  | "extracting"
  | "error"
  | "unloaded"
  | "none";

interface DownloadStats {
  startTime: number;
  lastUpdate: number;
  totalDownloaded: number;
  speed: number;
}

interface ModelSelectorProps {
  onError?: (error: string) => void;
}

const ModelSelector: React.FC<ModelSelectorProps> = ({ onError }) => {
  const { t } = useTranslation();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [currentModelId, setCurrentModelId] = useState<string>("");
  const [modelStatus, setModelStatus] = useState<ModelStatus>("unloaded");
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelDownloadProgress, setModelDownloadProgress] = useState<
    Map<string, DownloadProgress>
  >(new Map());
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [downloadStats, setDownloadStats] = useState<
    Map<string, DownloadStats>
  >(new Map());
  const [extractingModels, setExtractingModels] = useState<Set<string>>(
    new Set(),
  );

  // Custom Model State
  const [showAddModal, setShowAddModal] = useState(false);
  const [customUrl, setCustomUrl] = useState("");
  const [customName, setCustomName] = useState("");
  const [isInstalling, setIsInstalling] = useState(false);

  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadModels();
    loadCurrentModel();

    // Listen for model state changes
    const modelStateUnlisten = listen<ModelStateEvent>(
      "model-state-changed",
      (event) => {
        const { event_type, model_id, model_name, error } = event.payload;

        switch (event_type) {
          case "loading_started":
            setModelStatus("loading");
            setModelError(null);
            break;
          case "loading_completed":
            setModelStatus("ready");
            setModelError(null);
            if (model_id) setCurrentModelId(model_id);
            break;
          case "loading_failed":
            setModelStatus("error");
            setModelError(error || "Failed to load model");
            break;
          case "unloaded":
            setModelStatus("unloaded");
            setModelError(null);
            break;
        }
      },
    );

    // Listen for model download progress
    const downloadProgressUnlisten = listen<DownloadProgress>(
      "model-download-progress",
      (event) => {
        const progress = event.payload;
        setModelDownloadProgress((prev) => {
          const newMap = new Map(prev);
          newMap.set(progress.model_id, progress);
          return newMap;
        });
        setModelStatus("downloading");

        // Update download stats for speed calculation
        const now = Date.now();
        setDownloadStats((prev) => {
          const current = prev.get(progress.model_id);
          const newStats = new Map(prev);

          if (!current) {
            // First progress update - initialize
            newStats.set(progress.model_id, {
              startTime: now,
              lastUpdate: now,
              totalDownloaded: progress.downloaded,
              speed: 0,
            });
          } else {
            // Calculate speed over last few seconds
            const timeDiff = (now - current.lastUpdate) / 1000; // seconds
            const bytesDiff = progress.downloaded - current.totalDownloaded;

            if (timeDiff > 0.5) {
              // Update speed every 500ms
              const currentSpeed = bytesDiff / (1024 * 1024) / timeDiff; // MB/s
              // Smooth the speed with exponential moving average, but ensure positive values
              const validCurrentSpeed = Math.max(0, currentSpeed);
              const smoothedSpeed =
                current.speed > 0
                  ? current.speed * 0.8 + validCurrentSpeed * 0.2
                  : validCurrentSpeed;

              newStats.set(progress.model_id, {
                startTime: current.startTime,
                lastUpdate: now,
                totalDownloaded: progress.downloaded,
                speed: Math.max(0, smoothedSpeed),
              });
            }
          }

          return newStats;
        });
      },
    );

    // Listen for model download completion
    const downloadCompleteUnlisten = listen<string>(
      "model-download-complete",
      (event) => {
        const modelId = event.payload;
        setModelDownloadProgress((prev) => {
          const newMap = new Map(prev);
          newMap.delete(modelId);
          return newMap;
        });
        setDownloadStats((prev) => {
          const newStats = new Map(prev);
          newStats.delete(modelId);
          return newStats;
        });
        loadModels(); // Refresh models list

        // Auto-select the newly downloaded model (skip if recording in progress)
        setTimeout(async () => {
          const isRecording = await commands.isRecording();
          if (isRecording) {
            return; // Skip auto-switch if recording in progress
          }
          loadCurrentModel();
          handleModelSelect(modelId);
        }, 500);
      },
    );

    // Listen for extraction events
    const extractionStartedUnlisten = listen<string>(
      "model-extraction-started",
      (event) => {
        const modelId = event.payload;
        setExtractingModels((prev) => new Set(prev.add(modelId)));
        setModelStatus("extracting");
      },
    );

    const extractionCompletedUnlisten = listen<string>(
      "model-extraction-completed",
      (event) => {
        const modelId = event.payload;
        setExtractingModels((prev) => {
          const next = new Set(prev);
          next.delete(modelId);
          return next;
        });
        loadModels(); // Refresh models list

        // Auto-select the newly extracted model (skip if recording in progress)
        setTimeout(async () => {
          const isRecording = await commands.isRecording();
          if (isRecording) {
            return; // Skip auto-switch if recording in progress
          }
          loadCurrentModel();
          handleModelSelect(modelId);
        }, 500);
      },
    );

    const extractionFailedUnlisten = listen<{
      model_id: string;
      error: string;
    }>("model-extraction-failed", (event) => {
      const modelId = event.payload.model_id;
      setExtractingModels((prev) => {
        const next = new Set(prev);
        next.delete(modelId);
        return next;
      });
      setModelError(`Failed to extract model: ${event.payload.error}`);
      setModelStatus("error");
    });

    // Click outside to close dropdown
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setShowModelDropdown(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      modelStateUnlisten.then((fn) => fn());
      downloadProgressUnlisten.then((fn) => fn());
      downloadCompleteUnlisten.then((fn) => fn());
      extractionStartedUnlisten.then((fn) => fn());
      extractionCompletedUnlisten.then((fn) => fn());
      extractionFailedUnlisten.then((fn) => fn());
    };
  }, []);

  const loadModels = async () => {
    try {
      const result = await commands.getAvailableModels();
      if (result.status === "ok") {
        setModels(result.data);
      }
    } catch (err) {
      console.error("Failed to load models:", err);
    }
  };

  const loadCurrentModel = async () => {
    try {
      const result = await commands.getCurrentModel();
      if (result.status === "ok") {
        const current = result.data;
        setCurrentModelId(current);

        if (current) {
          // Check if model is actually loaded
          const statusResult = await commands.getTranscriptionModelStatus();
          if (statusResult.status === "ok") {
            const transcriptionStatus = statusResult.data;
            if (transcriptionStatus === current) {
              setModelStatus("ready");
            } else {
              setModelStatus("unloaded");
            }
          }
        } else {
          setModelStatus("none");
        }
      }
    } catch (err) {
      console.error("Failed to load current model:", err);
      setModelStatus("error");
      setModelError("Failed to check model status");
    }
  };

  const handleModelSelect = async (modelId: string) => {
    try {
      setCurrentModelId(modelId); // Set optimistically so loading text shows correct model
      setModelError(null);
      setShowModelDropdown(false);
      const result = await commands.setActiveModel(modelId);
      if (result.status === "error") {
        const errorMsg = result.error;
        setModelError(errorMsg);
        setModelStatus("error");
        onError?.(errorMsg);
      }
    } catch (err) {
      const errorMsg = `${err}`;
      setModelError(errorMsg);
      setModelStatus("error");
      onError?.(errorMsg);
    }
  };

  const handleModelDownload = async (modelId: string) => {
    try {
      setModelError(null);
      const result = await commands.downloadModel(modelId);
      if (result.status === "error") {
        const errorMsg = result.error;
        setModelError(errorMsg);
        setModelStatus("error");
        onError?.(errorMsg);
      }
    } catch (err) {
      const errorMsg = `${err}`;
      setModelError(errorMsg);
      setModelStatus("error");
      onError?.(errorMsg);
    }
  };

  const getCurrentModel = () => {
    return models.find((m) => m.id === currentModelId);
  };

  const getModelDisplayText = (): string => {
    if (extractingModels.size > 0) {
      if (extractingModels.size === 1) {
        const [modelId] = Array.from(extractingModels);
        const model = models.find((m) => m.id === modelId);
        const modelName = model
          ? getTranslatedModelName(model, t)
          : t("modelSelector.extractingGeneric").replace("...", "");
        return t("modelSelector.extracting", { modelName });
      } else {
        return t("modelSelector.extractingMultiple", {
          count: extractingModels.size,
        });
      }
    }

    if (modelDownloadProgress.size > 0) {
      if (modelDownloadProgress.size === 1) {
        const [progress] = Array.from(modelDownloadProgress.values());
        const percentage = Math.max(
          0,
          Math.min(100, Math.round(progress.percentage)),
        );
        return t("modelSelector.downloading", { percentage });
      } else {
        return t("modelSelector.downloadingMultiple", {
          count: modelDownloadProgress.size,
        });
      }
    }

    const currentModel = getCurrentModel();

    switch (modelStatus) {
      case "ready":
        return currentModel
          ? getTranslatedModelName(currentModel, t)
          : t("modelSelector.modelReady");
      case "loading":
        return currentModel
          ? t("modelSelector.loading", {
            modelName: getTranslatedModelName(currentModel, t),
          })
          : t("modelSelector.loadingGeneric");
      case "extracting":
        return currentModel
          ? t("modelSelector.extracting", {
            modelName: getTranslatedModelName(currentModel, t),
          })
          : t("modelSelector.extractingGeneric");
      case "error":
        return modelError || t("modelSelector.modelError");
      case "unloaded":
        return currentModel
          ? getTranslatedModelName(currentModel, t)
          : t("modelSelector.modelUnloaded");
      case "none":
        return t("modelSelector.noModelDownloadRequired");
      default:
        return currentModel
          ? getTranslatedModelName(currentModel, t)
          : t("modelSelector.modelUnloaded");
    }
  };

  const handleModelDelete = async (modelId: string) => {
    const result = await commands.deleteModel(modelId);
    if (result.status === "ok") {
      await loadModels();
      setModelError(null);
    }
  }


  const handleAddCustomModel = async () => {
    if (!customUrl) return;
    setIsInstalling(true);
    try {
      const id = await invoke<string>("register_model_from_url", {
        url: customUrl,
        filename: customName || null
      });

      setShowAddModal(false);
      setCustomUrl("");
      setCustomName("");

      // Trigger download
      await commands.downloadModel(id);
      // Refresh list
      loadModels();

    } catch (e) {
      setModelError(`Failed to add model: ${e}`);
      setModelStatus("error");
    } finally {
      setIsInstalling(false);
    }
  };

  return (
    <>
      {/* Model Status and Switcher */}
      <div className="relative" ref={dropdownRef}>
        <ModelStatusButton
          status={modelStatus}
          displayText={getModelDisplayText()}
          isDropdownOpen={showModelDropdown}
          onClick={() => setShowModelDropdown(!showModelDropdown)}
        />

        {/* Model Dropdown */}
        {showModelDropdown && (
          <ModelDropdown
            models={models}
            currentModelId={currentModelId}
            downloadProgress={modelDownloadProgress}
            onModelSelect={handleModelSelect}
            onModelDownload={handleModelDownload}
            onModelDelete={handleModelDelete}
            onAddModel={() => {
              setShowModelDropdown(false);
              setShowAddModal(true);
            }}
            onError={onError}
          />
        )}
      </div>

      {showAddModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-6" onClick={(e) => e.stopPropagation()}>
          <div className="bg-background w-full max-w-md space-y-6 border border-logo-primary/30 shadow-2xl p-6 rounded-lg select-text" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-mid-gray/10 pb-4">
              <h3 className="text-sm font-bold uppercase tracking-widest text-logo-primary flex items-center gap-2">
                <Globe className="w-4 h-4" />
                Add Custom Model
              </h3>
              <button onClick={() => setShowAddModal(false)} className="text-text/60 hover:text-text transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-[10px] font-bold uppercase block text-text/60">Direct Download URL</label>
                <div className="flex items-center gap-2 bg-mid-gray/10 border border-mid-gray/20 focus-within:border-logo-primary/50 p-2 rounded transition-colors">
                  <Link className="w-3 h-3 text-logo-primary" />
                  <input
                    className="w-full bg-transparent text-text text-xs font-mono focus:outline-none placeholder:text-text/30"
                    placeholder="https://huggingface.co/.../model.bin"
                    value={customUrl}
                    onChange={e => setCustomUrl(e.target.value)}
                    autoFocus
                  />
                </div>
                <p className="text-[9px] text-text/40 uppercase tracking-wide">
                  Supports .bin (Whisper) or .tar.gz (Parakeet)
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-bold uppercase block text-text/60">Model Name (Optional)</label>
                <input
                  className="w-full bg-mid-gray/10 text-text border border-mid-gray/20 p-2 text-xs font-mono focus:border-logo-primary/50 focus:outline-none rounded transition-colors placeholder:text-text/30"
                  placeholder="My Custom Model"
                  value={customName}
                  onChange={e => setCustomName(e.target.value)}
                />
              </div>
            </div>

            <div className="flex gap-3 pt-2">
              <button
                onClick={() => setShowAddModal(false)}
                className="flex-1 px-4 py-2 text-xs font-bold uppercase text-text/60 hover:bg-mid-gray/10 rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleAddCustomModel}
                disabled={isInstalling || !customUrl}
                className="flex-1 px-4 py-2 bg-logo-primary/10 text-logo-primary hover:bg-logo-primary/20 border border-logo-primary/30 rounded text-xs font-bold uppercase flex items-center justify-center gap-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isInstalling ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                {isInstalling ? "Installing..." : "Install Model"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Download Progress Bar for Models */}
      <DownloadProgressDisplay
        downloadProgress={modelDownloadProgress}
        downloadStats={downloadStats}
      />
    </>
  );
};

export default ModelSelector;
