// Shader Garden — runtime/composition-graph.js
// COMP-1 (v2 blueprint §7.3 item 24, ruling C12): validates + topologically
// orders a composition manifest's `passes` array. Shared by the viewer's
// composition player (bake-time validation before a single frame renders)
// and the admission static tier's SG-S08 rule (organs/admission/static.js
// re-exports checkCompositionGraph() from here) — one algorithm, two
// importers, the same "one rule set, not two" pattern ruling C5 established
// for the per-source SG-Sxx checks. Living in runtime/ (not organs/admission/)
// keeps the admission organ's own byte budget — already near its COMP-0 cap —
// untouched, and keeps the viewer's import of this module from ever pulling
// in the rest of the (lazy, lazily-imported) admission pipeline.
//
// Self-feedback (a pass whose own target appears in its own `channels`) is
// the ONE legal cycle (C12), and only when the pass also declares
// `feedback: true`. Any other cycle — an undeclared self-read, or a cycle
// spanning two or more passes — is rejected.

const VALID_NAME = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * @param {Array<{kernel:string, target:string, channels?:string[], feedback?:boolean}>} passes
 * @returns {{ reject: boolean, findings: string[], order: number[] }}
 *   findings are 'SG-S08: prose' strings; order is a valid topological
 *   pass-index sequence (screen last) when !reject, else [].
 */
export function validateComposition(passes) {
  const findings = [];
  if (!Array.isArray(passes) || passes.length === 0) {
    return { reject: true, findings: ['SG-S08: composition has no passes'], order: [] };
  }

  const targets = new Map(); // target name -> pass index
  let screenCount = 0;
  passes.forEach((p, i) => {
    if (!p || typeof p.kernel !== 'string' || !p.kernel) findings.push(`SG-S08: pass ${i} has no kernel`);
    if (!p || typeof p.target !== 'string' || !VALID_NAME.test(p.target)) {
      findings.push(`SG-S08: pass ${i} has an invalid target name`);
      return;
    }
    if (p.target === 'screen') screenCount++;
    else if (targets.has(p.target)) findings.push(`SG-S08: duplicate target "${p.target}"`);
    targets.set(p.target, i);
  });
  if (screenCount !== 1) findings.push(`SG-S08: composition must have exactly one pass targeting "screen" (found ${screenCount})`);

  const deps = passes.map((p, i) => {
    const names = Array.isArray(p && p.channels) ? p.channels : [];
    const idxs = new Set();
    for (const name of names) {
      if (name === 'screen') { findings.push(`SG-S08: pass ${i} channels "screen" — not a valid texture source`); continue; }
      if (!targets.has(name)) { findings.push(`SG-S08: pass ${i} channels unknown target "${name}"`); continue; }
      idxs.add(targets.get(name));
    }
    return [...idxs];
  });

  passes.forEach((p, i) => {
    const channels = (p && Array.isArray(p.channels)) ? p.channels : [];
    const selfRead = channels.includes(p && p.target);
    if (selfRead && !p.feedback) findings.push(`SG-S08: pass ${i} ("${p.target}") reads its own output but is not marked feedback:true`);
    if (p && p.feedback && !selfRead) findings.push(`SG-S08: pass ${i} ("${p.target}") declares feedback:true but never reads its own target`);
  });

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Array(passes.length).fill(WHITE);
  let cyclic = false;
  const visit = (i) => {
    color[i] = GRAY;
    for (const j of deps[i]) {
      if (j === i) continue; // self-feedback — the one legal cycle (C12)
      if (color[j] === GRAY) { cyclic = true; return; }
      if (color[j] === WHITE) visit(j);
    }
    color[i] = BLACK;
  };
  for (let i = 0; i < passes.length; i++) if (color[i] === WHITE) visit(i);
  if (cyclic) findings.push('SG-S08: cyclic channel graph — arbitrary cycles are illegal, only self-feedback is legal (C12)');

  let reject = findings.length > 0;
  let order = [];
  if (!reject) {
    const indeg = new Array(passes.length).fill(0);
    deps.forEach((ds, i) => ds.forEach((j) => { if (j !== i) indeg[i]++; }));
    const queue = [];
    for (let i = 0; i < passes.length; i++) if (indeg[i] === 0) queue.push(i);
    for (let qi = 0; qi < queue.length; qi++) {
      const i = queue[qi];
      order.push(i);
      deps.forEach((ds, k) => {
        if (k !== i && ds.includes(i)) { indeg[k]--; if (indeg[k] === 0) queue.push(k); }
      });
    }
    if (order.length !== passes.length) {
      // Defensive — the checks above should make this unreachable.
      reject = true;
      findings.push('SG-S08: topological sort could not order all passes');
      order = [];
    }
  }

  return { reject, findings, order };
}
