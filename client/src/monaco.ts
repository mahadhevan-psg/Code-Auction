import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import tsWorker from 'monaco-editor/language/typescript/ts.worker?worker';

/**
 * Bundle Monaco with the app instead of loading it from a CDN, so the contest works on an
 * offline / restricted venue network (and the editor cannot be swapped for a remote script).
 */
(self as any).MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  }
};

loader.config({ monaco });

export const THEME_DARK = 'auction-dark';
export const THEME_LIGHT = 'auction-light';

monaco.editor.defineTheme(THEME_DARK, {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#0f1218',
    'editorGutter.background': '#0f1218',
    'editor.lineHighlightBackground': '#171c27',
    'editorLineNumber.foreground': '#4b5468',
    'editorLineNumber.activeForeground': '#aab2c3',
    'editor.selectionBackground': '#3a4580aa'
  }
});

monaco.editor.defineTheme(THEME_LIGHT, {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#ffffff',
    'editorGutter.background': '#ffffff',
    'editor.lineHighlightBackground': '#f4f5fa',
    'editorLineNumber.foreground': '#a3aabb'
  }
});

export { monaco };
