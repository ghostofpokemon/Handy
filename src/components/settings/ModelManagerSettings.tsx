import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { RefreshCw, Download, Globe, Link, Trash2 } from "lucide-react";

interface ModelInfo {
    id: string;
    name: string;
    description: string;
    filename: string;
    is_downloaded: boolean;
    is_downloading: boolean;
    is_directory: boolean;
    engine_type: "Whisper" | "Parakeet";
}

export const ModelManagerSettings: React.FC<{ grouped?: boolean }> = ({ grouped }) => {
    const [models, setModels] = useState<ModelInfo[]>([]);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [showAdd, setShowAdd] = useState(false);
    const [customUrl, setCustomUrl] = useState("");
    const [customName, setCustomName] = useState("");
    const [isInstalling, setIsInstalling] = useState(false);

    const fetchModels = async () => {
        try {
            const available = await invoke<ModelInfo[]>("get_available_models");
            setModels(available);
        } catch (e) {
            console.error(e);
        }
    };

    useEffect(() => {
        fetchModels();
    }, []);

    const handleRefresh = async () => {
        setIsRefreshing(true);
        try {
            const refreshed = await invoke<ModelInfo[]>("refresh_models");
            setModels(refreshed);
            toast.success("Models refreshed");
        } catch (e) {
            toast.error("Failed to refresh models");
        } finally {
            setIsRefreshing(false);
        }
    };

    const handleAddCustomModel = async () => {
        if (!customUrl) {
            toast.error("URL is required");
            return;
        }
        setIsInstalling(true);
        try {
            const id = await invoke<string>("register_model_from_url", {
                url: customUrl,
                filename: customName || null
            });

            setShowAdd(false);
            setCustomUrl("");
            setCustomName("");
            toast.success("Model registered, starting download...");

            await invoke("download_model", { modelId: id });
            handleRefresh();

        } catch (e) {
            toast.error("Failed to add model: " + e);
        } finally {
            setIsInstalling(false);
        }
    };

    const handleDelete = async (id: string) => {
        if (!confirm("Are you sure you want to delete this model?")) return;
        try {
            await invoke("delete_model", { modelId: id });
            toast.success("Model deleted");
            handleRefresh();
        } catch (e) {
            toast.error("Failed to delete: " + e);
        }
    }

    return (
        <div className={`space-y-4 ${grouped ? "p-4 bg-white/5 border border-white/10" : ""}`}>
            <div className="flex items-center justify-between">
                <label className="text-sm font-medium">Manage Models</label>
                <div className="flex gap-2">
                    <button
                        onClick={() => setShowAdd(!showAdd)}
                        className="text-xs uppercase font-bold tracking-wider hover:text-primary flex items-center gap-1"
                    >
                        <Link className="w-3 h-3" /> Add URL
                    </button>
                    <button
                        onClick={handleRefresh}
                        className={`text-xs uppercase font-bold tracking-wider hover:text-primary flex items-center gap-1 ${isRefreshing ? 'opacity-50' : ''}`}
                    >
                        <RefreshCw className={`w-3 h-3 ${isRefreshing ? 'animate-spin' : ''}`} />
                        Refresh
                    </button>
                </div>
            </div>

            {showAdd && (
                <div className="p-4 bg-black/20 border border-white/10 space-y-3">
                    <h4 className="text-xs font-bold uppercase text-primary">Add Custom Model</h4>
                    <div className="space-y-2">
                        <input
                            className="w-full bg-black/50 border border-white/10 p-2 text-xs font-mono focus:border-primary focus:outline-none"
                            placeholder="https://huggingface.co/.../model.bin"
                            value={customUrl}
                            onChange={e => setCustomUrl(e.target.value)}
                        />
                        <input
                            className="w-full bg-black/50 border border-white/10 p-2 text-xs font-mono focus:border-primary focus:outline-none"
                            placeholder="Name (Optional)"
                            value={customName}
                            onChange={e => setCustomName(e.target.value)}
                        />
                        <div className="flex justify-end gap-2">
                            <button onClick={() => setShowAdd(false)} className="text-xs px-3 py-1 hover:bg-white/10">Cancel</button>
                            <button
                                onClick={handleAddCustomModel}
                                disabled={isInstalling || !customUrl}
                                className="text-xs px-3 py-1 bg-primary text-black font-bold uppercase"
                            >
                                {isInstalling ? "Installing..." : "Install"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <div className="space-y-2 max-h-40 overflow-y-auto scrollbar-thin scrollbar-thumb-white/10">
                {models.map(m => (
                    <div key={m.id} className="flex items-center justify-between p-2 bg-black/20 border border-white/5 hover:border-white/10">
                        <div className="flex flex-col">
                            <span className="text-xs font-bold">{m.name}</span>
                            <span className="text-[10px] text-muted-foreground">{m.id} {m.is_directory ? "(Dir)" : ""}</span>
                        </div>
                        <div className="flex items-center gap-2">
                            {m.is_downloaded ? (
                                <span className="text-[10px] text-green-500 font-bold uppercase">Ready</span>
                            ) : (
                                <span className="text-[10px] text-yellow-500 font-bold uppercase">Not Ready</span>
                            )}
                            {m.is_downloaded && (
                                <button onClick={() => handleDelete(m.id)} className="text-red-500 hover:text-red-400 p-1">
                                    <Trash2 className="w-3 h-3" />
                                </button>
                            )}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};
