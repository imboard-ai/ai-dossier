/** Structured label classification shared by eligibility assessment and gate admission. */
export function isNonBugIssue(labels: readonly string[]): boolean {
  const names = labels.map((label) => label.toLowerCase());
  return (
    !names.some((label) => ['bug', 'defect', 'regression'].includes(label)) &&
    names.some((label) =>
      ['enhancement', 'feature', 'question', 'discussion', 'documentation'].includes(label)
    )
  );
}
