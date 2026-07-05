// GARDEN-0 — parse.js
// Parses the `// @component` / `// @tune` / `// @end` annotation convention
// out of a plain GLSL source string. See ARCHITECTURE.md § "The Garden" and
// assets/garden/scene.glsl's own header comment for the exact grammar.
//
// Component numeric ids (for the probe readback) are NOT stored here — the
// shader assigns them by file order (COMP_SKY=1, COMP_TERRAIN=2, ...) and
// this parser's `components` array is in that same file order, so callers
// map id <-> array index as `components[id - 1]`.

const COMPONENT_RE = /^\/\/\s*@component\s+(\S+)\s+"([^"]*)"\s+"([^"]*)"\s*$/;
const TUNE_RE = /^\/\/\s*@tune\s+(\S+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+"([^"]*)"\s*$/;
// Exported: the GARDEN-IDE inline editor (edit.js) reuses this exact grammar
// to refuse a component-body edit that would itself contain a `// @end` line
// (that line would otherwise look like the component ends early once the
// edited body is spliced back into the full scene).
export const END_RE = /^\/\/\s*@end\s*$/;

/**
 * @param {string} src — the full scene.glsl text
 * @returns {{
 *   components: Array<{ id: string, name: string, blurb: string, startLine: number,
 *     endLine: number, source: string, tunes: Array<{name, min, max, default, label}> }>,
 *   tunes: Array<{name, min, max, default, label}> // flattened, all components
 * }}
 */
export function parseScene(src) {
  const lines = src.split('\n');
  const components = [];
  let open = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    if (!open) {
      const m = COMPONENT_RE.exec(line);
      if (m) open = { id: m[1], name: m[2], blurb: m[3], startLine: lineNo, bodyLines: [], tunes: [] };
      continue;
    }

    if (END_RE.test(line)) {
      components.push({
        id: open.id, name: open.name, blurb: open.blurb,
        startLine: open.startLine, endLine: lineNo,
        source: open.bodyLines.join('\n'), tunes: open.tunes,
      });
      open = null;
      continue;
    }

    open.bodyLines.push(line);
    const t = TUNE_RE.exec(line);
    if (t) open.tunes.push({ name: t[1], min: Number(t[2]), max: Number(t[3]), default: Number(t[4]), label: t[5] });
  }

  return { components, tunes: components.flatMap((c) => c.tunes) };
}
