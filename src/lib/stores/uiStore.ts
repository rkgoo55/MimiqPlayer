import { writable } from 'svelte/store';

/** Controls the "APIキーが必要" modal visibility */
export const apiKeyModalStore = writable(false);

/** Controls the track list sidebar visibility */
export const showTrackListStore = writable(true);

/** Triggers the tutorial modal to show (set true to open, Tutorial resets to false on close) */
export const tutorialStore = writable(false);
