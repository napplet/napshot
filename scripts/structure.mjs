import ts from 'typescript';

const branches = new Set([
  ts.SyntaxKind.IfStatement, ts.SyntaxKind.ConditionalExpression, ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.CatchClause, ts.SyntaxKind.ForStatement, ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement, ts.SyntaxKind.WhileStatement, ts.SyntaxKind.DoStatement,
]);
const shortCircuits = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken,
]);

/** Count decisions within one function, excluding independently checked nested functions. */
function complexity(body) {
  let count = 1;
  function visit(node) {
    if (node !== body && ts.isFunctionLike(node)) return;
    if (branches.has(node.kind)) count++;
    if (ts.isBinaryExpression(node) && shortCircuits.has(node.operatorToken.kind)) count++;
    ts.forEachChild(node, visit);
  }
  visit(body);
  return count;
}

/** Enforce the repository's runtime-source size and complexity limits. */
export function structureErrors(path, text) {
  const errors = [];
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  text.split('\n').forEach((line, index) => {
    if (line.length > 150) errors.push(`${path}:${index + 1}: line exceeds 150 characters`);
  });
  function visit(node) {
    if (ts.isFunctionLike(node) && node.body) {
      const start = source.getLineAndCharacterOfPosition(node.getStart()).line;
      const end = source.getLineAndCharacterOfPosition(node.end).line;
      const checks = [[complexity(node.body), 8, 'complexity'], [end - start + 1, 200, 'function lines'],
        [node.parameters.length, 5, 'positional parameters']];
      for (const [value, limit, label] of checks) {
        if (value > limit) errors.push(`${path}:${start + 1}: ${label} ${value} exceeds ${limit}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return errors;
}
