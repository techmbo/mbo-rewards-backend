/**
 * Minimal JS scanner used by call-site guard tests.
 *
 * Given a function body it answers, for a call site, which conditions control whether that call
 * runs: the headers of every enclosing block plus the head of the statement the call sits in
 * (so a ternary guard counts too).
 *
 * Two masks are produced over the same indices. The structure mask blanks comments, strings and
 * template literals, so `${...}` inside a template literal is never mistaken for a block. The
 * search mask blanks comments only, so a call site can still be located by its literal text.
 * Blanking preserves length, so the two masks and the raw source share one index space.
 */

function scan(source, { keepStrings = false } = {}) {
  const out = source.split("");
  const blank = (i) => {
    out[i] = " ";
  };
  const blankUnlessSearching = (i) => {
    if (!keepStrings) out[i] = " ";
  };

  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") blank(i++);
      continue;
    }
    if (ch === "/" && next === "*") {
      blank(i++);
      blank(i++);
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) blank(i++);
      if (i < n) blank(i++);
      if (i < n) blank(i++);
      continue;
    }
    if (ch === '"' || ch === "'") {
      blankUnlessSearching(i++);
      while (i < n && source[i] !== ch) {
        if (source[i] === "\\") blankUnlessSearching(i++);
        blankUnlessSearching(i++);
      }
      if (i < n) blankUnlessSearching(i++);
      continue;
    }
    if (ch === "`") {
      blankUnlessSearching(i++);
      let depth = 0;
      while (i < n) {
        if (source[i] === "\\") {
          blankUnlessSearching(i++);
          if (i < n) blankUnlessSearching(i++);
          continue;
        }
        if (depth === 0 && source[i] === "`") break;
        if (source[i] === "{") depth += 1;
        else if (source[i] === "}") depth -= 1;
        blankUnlessSearching(i++);
      }
      if (i < n) blankUnlessSearching(i++);
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/**
 * Extract a top-level `async function <name>(...)` declaration, braces included.
 *
 * The parameter list is skipped by balancing parentheses first: a destructured parameter opens a
 * brace of its own, and taking that as the body would silently return the signature instead.
 */
export function functionBody(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  const structure = scan(source);

  const paramsOpen = structure.indexOf("(", start);
  let parens = 0;
  let paramsClose = -1;
  for (let i = paramsOpen; i < structure.length; i += 1) {
    if (structure[i] === "(") parens += 1;
    else if (structure[i] === ")") {
      parens -= 1;
      if (parens === 0) {
        paramsClose = i;
        break;
      }
    }
  }
  if (paramsClose < 0) throw new Error(`function ${name} has an unbalanced parameter list`);

  const open = structure.indexOf("{", paramsClose);
  let depth = 0;
  for (let i = open; i < structure.length; i += 1) {
    if (structure[i] === "{") depth += 1;
    else if (structure[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`function ${name} is unbalanced`);
}

/**
 * For every occurrence of `needle`, return the text of the conditions controlling it: the header
 * of each enclosing block, plus the head of its own statement.
 */
export function guardsFor(body, needle) {
  const structure = scan(body);
  const searchable = scan(body, { keepStrings: true });
  const found = [];
  let from = 0;
  for (;;) {
    const at = searchable.indexOf(needle, from);
    if (at < 0) break;
    from = at + needle.length;

    const stack = [];
    let statementStart = 0;
    for (let i = 0; i < at; i += 1) {
      const ch = structure[i];
      if (ch === "{") {
        stack.push(body.slice(statementStart, i));
        statementStart = i + 1;
      } else if (ch === "}") {
        stack.pop();
        statementStart = i + 1;
      } else if (ch === ";") {
        statementStart = i + 1;
      }
    }
    found.push([...stack, body.slice(statementStart, at)].join("\n"));
  }
  if (found.length === 0) throw new Error(`call site not found: ${needle}`);
  return found;
}
