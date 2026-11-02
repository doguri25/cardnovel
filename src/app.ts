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
  /** the settings, on one of its tabs (AI keys by default) */
  openSettings(pane?: 'keys' | 'defaults' | 'prices' | 'connect'): void;
  online(): boolean;
  /** index of the card shown in the preview */
  current(): number;
  settings(): Settings;
  saveSettings(): Promise<void>;
  /** redraws the look panel (ratio, themes, font, series, watermark) */
  renderLook(): void;
  /** keeps a version of the open work in the history (never fails) */
  keepVersion(reason: VersionReason): Promise<void>;
  /** shows a card for editing: its step, the card selected and scrolled to, optionally its text focused */
  goCard(i: number, focus?: boolean): void;
  /** undoes the last text change */
  undo(): void;
  /** a notice with a 「되돌리기」 button for the change just made */
  undoToast(msg: string): void;
  /** the caption and hashtag helper */
  openCaption(): void;
}
