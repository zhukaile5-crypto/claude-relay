'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Resolve the closest existing ancestor too: a lexical prefix alone permits
// junctions/symlinks to escape. Missing descendants remain valid upload targets.
// This is a server file-routing boundary, not an OS sandbox for model commands.
function workspacePath(root, input, { io = fs, paths = path } = {}) {
  if (typeof input !== 'string' || input.includes('\0')) return null;
  const inside = (base, target) => {
    const rel = paths.relative(base, target);
    return rel === '' || (!rel.startsWith('..' + paths.sep) && rel !== '..' && !paths.isAbsolute(rel));
  };
  try {
    const base = paths.resolve(root), target = paths.resolve(base, input);
    if (!inside(base, target)) return null;
    // Windows alternate streams and device aliases are not web file resources.
    if (paths.sep === '\\' && /[:]/.test(target.slice(paths.parse(target).root.length))) return null;
    const actualRoot = io.realpathSync(base);
    let ancestor = target;
    for (;;) {
      try {
        const actual = io.realpathSync(ancestor);
        return inside(actualRoot, actual) ? target : null;
      } catch (error) {
        if (!error || error.code !== 'ENOENT') return null;
        // A dangling link must not be mistaken for an ordinary missing path.
        try { if (io.lstatSync(ancestor).isSymbolicLink()) return null; }
        catch (e) { if (!e || e.code !== 'ENOENT') return null; }
        const parent = paths.dirname(ancestor);
        if (parent === ancestor || !inside(base, parent)) return null;
        ancestor = parent;
      }
    }
  } catch { return null; }
}

module.exports = workspacePath;
