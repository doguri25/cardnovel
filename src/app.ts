// What the feature modules (review, Instagram preview, Drive, share links) may ask of the app controller.
import type { ImageAI, TextAI } from './ai/compose';
import type { Work } from './model';

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
}
