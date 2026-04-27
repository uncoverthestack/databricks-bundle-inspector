import type { InspectorIssue } from "./issues.js";

export type DocumentationGenerationDecision =
  | {
      action: "allow";
      blockingIssues: [];
      warningIssues: [];
    }
  | {
      action: "warn";
      blockingIssues: [];
      warningIssues: InspectorIssue[];
    }
  | {
      action: "block";
      blockingIssues: InspectorIssue[];
      warningIssues: InspectorIssue[];
    };

export function decideDocumentationGeneration(
  issues: InspectorIssue[],
): DocumentationGenerationDecision {
  const blockingIssues = issues.filter((issue) => issue.severity === "error");
  const warningIssues = issues.filter((issue) => issue.severity === "warning");

  if (blockingIssues.length > 0) {
    return {
      action: "block",
      blockingIssues,
      warningIssues,
    };
  }

  if (warningIssues.length > 0) {
    return {
      action: "warn",
      blockingIssues: [],
      warningIssues,
    };
  }

  return {
    action: "allow",
    blockingIssues: [],
    warningIssues: [],
  };
}
