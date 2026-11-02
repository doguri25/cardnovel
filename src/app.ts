// What the feature modules (review, Instagram preview, Drive, share links) may ask of the app controller.
import type { ImageAI, TextAI } from './ai/compose';
import type { Work } from './model';
import type { Settings } from './settings';
import type { VersionReason } from './versions';

export interface App {
  work(): Work;
  /** replaces the open work (after restoring from Drive, for example) */
  openWork(w: Work): Promise<void>;
  save(): void;
  /** writes the open work to this device now */
  flush(): Promise<void>;
  pushUndo(): void;
  refreshRow(i: number): void;
  select(i: number): void;
  scheduleRender(): void;
  textAI(): TextAI | null;
  imageAI(): ImageAI | null;
  openSettings(): void;
  online(): boolean;
  /** index of the card shown in the preview */
  current(): number;
  settings(): Settings;
  saveSettings(): Promise<void>;
  /** redraws the look panel (ratio, themes, font, series, watermark) */
  renderLook(): void;
  /** keeps a version of the open work in the history (never fails) */
  keepVersion(reason: VersionReason): Promise<void>;
}
