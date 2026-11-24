// Reine Op-Anwendung auf die Entry-Liste einer Sitzung.
// Von docs/app.js und von node --test (worker/test/apply-ops.test.js) genutzt.
//
// Rueckgabe: 'applied' | 'skipped' | 'resync'
//  - applied: Eintrag neu oder Text angehaengt / steps aktualisiert
//  - skipped: Op bereits enthalten (Duplikat aus Event-Backlog)
//  - resync:  Luecke erkannt (at > len, verpasster Eintrag, Neuer-Eintrag mit at>0)
export function applyMsgOp(entries, op) {
  const idx = entries.findIndex((e) => e.i >= op.i);
  const ex = idx >= 0 && entries[idx].i === op.i ? entries[idx] : null;
  if (ex) {
    // steps/status-artige Ops ersetzen Felder komplett (n/titles kommen voll).
    if (op.role === 'steps' || op.n !== undefined) {
      if (op.n !== undefined) ex.n = op.n;
      if (op.titles) ex.titles = op.titles;
      return 'applied';
    }
    const len = (ex.text || '').length;
    const at = op.at ?? 0;
    const add = op.append || '';
    if (at + add.length <= len) return 'skipped'; // schon enthalten
    if (at === len) {
      ex.text = (ex.text || '') + add;
      return 'applied';
    }
    return 'resync'; // at > len: Teil des Textes fehlt
  }
  const maxI = entries.length ? entries[entries.length - 1].i : -1;
  if (op.i > maxI) {
    // Neuer Eintrag: muss bei 0 beginnen – at>0 heisst Anfang verpasst.
    if ((op.at ?? 0) !== 0) return 'resync';
    const e = { i: op.i, role: op.role };
    if (op.append !== undefined) e.text = op.append;
    if (op.n !== undefined) e.n = op.n;
    if (op.titles) e.titles = op.titles;
    entries.splice(idx >= 0 ? idx : entries.length, 0, e);
    return 'applied';
  }
  // Op fuer ein Loch < maxI: der Eintrag wurde vom Server gesendet
  // (unterdrueckte thoughts kommen nie als Op an) -> verpasst.
  return 'resync';
}
