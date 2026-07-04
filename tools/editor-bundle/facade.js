// Shader Garden — tools/editor-bundle/facade.js
// The ONLY file esbuild treats as an entry point. Exports a curated facade,
// not raw CM re-exports (see README.md) — the editor organ imports the built
// chunk and never touches a CM type directly, so it stays swappable with the
// textarea fallback (site/js/editor/doc-adapter-textarea.js implements the
// same four functions).
//
// Excluded on purpose: @codemirror/autocomplete, @codemirror/search — both
// are the meta-package's weakest value-per-KiB (design doc §3, §6) and
// pushed to v3+.
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, MatchDecorator, Decoration, ViewPlugin } from '@codemirror/view';
import { defaultKeymap, historyKeymap, history, insertTab } from '@codemirror/commands';
import { LRLanguage, LanguageSupport, syntaxHighlighting, defaultHighlightStyle, indentOnInput } from '@codemirror/language';
import { lintGutter, setDiagnostics as cmSetDiagnostics } from '@codemirror/lint';
import { parser as glslParser } from './vendor/lezer-glsl/index.js';
import { wgsl as wgslLanguageSupport } from './vendor/codemirror-lang-wgsl/index.js';

// Shadertoy contract identifiers (ARCHITECTURE.md "The uniform contract") —
// grammar-agnostic tagging so it survives either grammar being swapped or
// going stale (design doc §3): a MatchDecorator works off the token text,
// not the parse tree.
const GLSL_BUILTINS = ['iResolution', 'iTime', 'iTimeDelta', 'iFrame', 'iMouse', 'mainImage'];
const WGSL_BUILTINS = ['U', 'mainImage'];

function builtinDecorator(words) {
  const matcher = new MatchDecorator({
    regexp: new RegExp('\\b(?:' + words.join('|') + ')\\b', 'g'),
    decoration: Decoration.mark({ class: 'cm-sg-builtin' }),
  });
  return ViewPlugin.define(
    (view) => ({
      decorations: matcher.createDeco(view),
      update(u) {
        if (u.docChanged || u.viewportChanged) this.decorations = matcher.updateDeco(u, this.decorations);
      },
    }),
    { decorations: (v) => v.decorations }
  );
}

const glslLanguage = LRLanguage.define({
  parser: glslParser,
  languageData: { commentTokens: { line: '//', block: { open: '/*', close: '*/' } } },
});

export function glsl() {
  return new LanguageSupport(glslLanguage, [builtinDecorator(GLSL_BUILTINS)]);
}

export function wgsl() {
  const base = wgslLanguageSupport();
  return new LanguageSupport(base.language, [base.support, builtinDecorator(WGSL_BUILTINS)]);
}

// Plain "Tab": insertTab, never indentWithTab — indentWithTab also binds
// Shift-Tab to indentLess, which reintroduces the keyboard trap the
// textarea adapter deliberately avoids (WCAG 2.1.2 — see
// doc-adapter-textarea.js). Leaving Shift-Tab unbound lets the browser's
// default focus-previous behavior through, same contract, CM or not.
function baseExtensions(onChange) {
  return [
    lineNumbers(),
    history(),
    keymap.of([{ key: 'Tab', run: insertTab }, ...defaultKeymap, ...historyKeymap]),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle),
    EditorView.lineWrapping,
    // No linter(source) here — that's the *pull* API: it re-runs `source` on
    // its own debounce after every doc change and overwrites whatever
    // setDiagnostics() pushed with the result (design doc §4 — compiles are
    // async/event-driven; a pull linter would double-compile or lag, and an
    // always-empty `source` would just clobber real diagnostics a moment
    // later). setDiagnostics() self-registers the lintState field + squiggle
    // rendering the first time it's called; lintGutter() only needs that
    // field to exist, which it does by the time a compile finishes.
    lintGutter(),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onChange(u.state.doc.toString());
    }),
  ];
}

/**
 * Builds the view but does not attach it — the caller appends `view.dom`
 * wherever it likes (same contract as doc-adapter-textarea.js's raw
 * <textarea>, so the organ code stays ignorant of which one mounted).
 * @param {{doc:string, language?:import('@codemirror/language').LanguageSupport|null, onChange:(doc:string)=>void}} opts
 * @returns {{view:EditorView, setDoc(str:string):void, getDoc():string, setLanguage(language:import('@codemirror/language').LanguageSupport|null):void, focusLine(line:number):void, destroy():void}}
 */
export function createEditor({ doc, language, onChange }) {
  const languageCompartment = new Compartment();
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [...baseExtensions(onChange), languageCompartment.of(language || [])],
    }),
  });

  return {
    view,
    setDoc(str) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: str } });
    },
    getDoc() {
      return view.state.doc.toString();
    },
    setLanguage(language) {
      view.dispatch({ effects: languageCompartment.reconfigure(language || []) });
    },
    focusLine(line) {
      const ln = Math.min(Math.max(line, 1), view.state.doc.lines);
      const pos = view.state.doc.line(ln).from;
      view.dispatch({ selection: { anchor: pos } });
      view.focus();
    },
    destroy() {
      view.destroy();
    },
  };
}

// diags: EditorDiagnostic[] — { from, to, severity: 'error'|'warning'|'info', message } —
// already doc-offset positions; the organ (editor/doc-adapter-codemirror.js)
// does the user-source-line -> doc-offset conversion, keeping this facade
// ignorant of the ED-1 messages[] shape.
export function setDiagnostics(view, diags) {
  view.dispatch(cmSetDiagnostics(view.state, diags));
}
