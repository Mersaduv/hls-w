export type AppView = "home" | "workbench";
export type WorkMode = "package" | "update";
export type PackageStep = "source" | "identity" | "audio" | "subtitles" | "ladder" | "destination" | "encode";
export type UpdateStep = "package" | "tracks" | "encode";
export type WorkbenchStep = PackageStep | UpdateStep;

export interface ReadinessItem {
  id: string;
  label: string;
  ok: boolean;
}

export const PACKAGE_STEPS: Array<{ id: PackageStep; index: string; label: string; hint: string }> = [
  { id: "source", index: "01", label: "Source", hint: "Import master file" },
  { id: "identity", index: "02", label: "Title", hint: "Catalog name" },
  { id: "audio", index: "03", label: "Audio", hint: "Original + dubs" },
  { id: "subtitles", index: "04", label: "Subtitles", hint: "Optional" },
  { id: "ladder", index: "05", label: "Quality", hint: "Auto from source" },
  { id: "destination", index: "06", label: "Output", hint: "Save folder" },
  { id: "encode", index: "07", label: "Encode", hint: "Start packaging" },
];

export const UPDATE_STEPS: Array<{ id: UpdateStep; index: string; label: string; hint: string }> = [
  { id: "package", index: "01", label: "Package", hint: "Open an existing HLS folder" },
  { id: "tracks", index: "02", label: "Tracks", hint: "Add audio or subtitles" },
  { id: "encode", index: "03", label: "Sync", hint: "Rewrite playlists and metadata" },
];
