import stripAnsi from "strip-ansi";
import { Issue, Repository } from "@octokit/webhooks-types";
import { Endpoints } from "@octokit/types";

import { addCommitAndPush } from "../git/commit";
import { addCommentToIssue } from "../github/issue";
import { runBuildCheck } from "../build/node/check";
import { ExecAsyncException } from "../utils";
import { createPR, markPRReadyForReview } from "../github/pr";
import { getIssue } from "../github/issue";
import e from "express";

type PullRequest =
  Endpoints["GET /repos/{owner}/{repo}/pulls/{pull_number}"]["response"]["data"];
type RetrievedIssue =
  Endpoints["GET /repos/{owner}/{repo}/issues/{issue_number}"]["response"]["data"];

interface CheckAndCommitOptions {
  repository: Repository;
  token: string;
  rootPath: string;
  branch: string;
  commitMessage: string;
  issue?: Issue;
  existingPr?: PullRequest;
  newPrTitle?: string;
  newPrBody?: string;
  newPrReviewers?: string[];
}

export async function checkAndCommit({
  repository,
  token,
  rootPath,
  branch,
  commitMessage,
  issue: actingOnIssue,
  existingPr,
  newPrTitle,
  newPrBody,
  newPrReviewers,
}: CheckAndCommitOptions) {
  let buildErrorMessage: string | undefined;

  try {
    await runBuildCheck(rootPath);
  } catch (error) {
    const { message } = error as ExecAsyncException;
    buildErrorMessage = stripAnsi(message);
  }

  await addCommitAndPush(rootPath, branch, commitMessage);

  const buildErrorBody = buildErrorMessage
    ? `\n\n@otto fix build error\n\n## Error Message:\n\n${buildErrorMessage}`
    : "";

  let prNumber: number;
  let prTitle: string;
  let prUrl: string;
  if (!newPrTitle || !newPrBody) {
    if (!existingPr) {
      throw new Error(
        "Must provide either newPrTitle and newPrBody or existingPr",
      );
    }
    prNumber = existingPr.number;
    prTitle = existingPr.title;
    prUrl = existingPr.html_url;
    if (buildErrorMessage === undefined) {
      await markPRReadyForReview(token, existingPr.node_id);
    }
  } else {
    const { data: pullRequest } = await createPR(
      repository,
      token,
      branch,
      newPrTitle,
      `${newPrBody}${buildErrorBody}`,
      newPrReviewers ?? [],
      buildErrorMessage !== undefined,
    );
    prNumber = pullRequest.number;
    prTitle = pullRequest.title;
    prUrl = pullRequest.html_url;

    console.log(`Created PR #${prNumber}: ${prUrl}`);
  }

  let issue: Issue | RetrievedIssue | undefined = actingOnIssue;

  if (!issue) {
    const regex = /otto-issue-(\d+)-.*/;
    const match = branch.match(regex);
    const issueNumber = parseInt(match?.[1] ?? "", 10);
    const result = await getIssue(repository, token, issueNumber);
    console.log(`Loaded Issue #${issueNumber} associated with PR #${prNumber}`);
    issue = result.data;
  }

  if (buildErrorMessage) {
    const nextStepsMessage = `## Next Steps

I am working to resolve a build error. I will update this PR with my progress.${buildErrorBody}`;

    const prMessage = `This PR has been updated to fix a build error.\n\n${nextStepsMessage}`;
    if (existingPr) {
      await addCommentToIssue(repository, prNumber, token, prMessage);
    }
    if (issue) {
      const prStatus = existingPr
        ? `I've updated this pull request: [${prTitle}](${prUrl}).`
        : `I've completed my initial work on this issue and have created a pull request: [${prTitle}](${prUrl}).`;
      const issueMessage = `## Update

${prStatus}

The changes currently result in a build error, so I'll be making some additional changes before it is ready to merge.`;

      await addCommentToIssue(repository, issue.number, token, issueMessage);
    }
  } else {
    // We have completed our work on this issue. Add a comment to the issue and PR.

    const nextStepsMessage = `## Next Steps

1. Please review the PR carefully. Auto-generated code can and will contain subtle bugs and mistakes.\n\n
2. If you identify code that needs to be changed, please reject the PR with a specific reason. 
Be as detailed as possible in your comments. Otto will take these comments, make changes to the code and push up changes. 
Please note that this process will take a few minutes.\n\n3. Once the code looks good, approve the PR and merge the code.`;

    const issueInfo = issue
      ? ` to address the issue [${issue.title}](${issue.html_url})`
      : "";
    await addCommentToIssue(
      repository,
      prNumber,
      token,
      `Hello human! 👋 \n\nThis PR was created by Otto${issueInfo}\n\n${nextStepsMessage}`,
    );

    if (issue) {
      const issueMessage = `## Update

I've completed my work on this issue and have ${
        existingPr ? "updating this" : "created a"
      } pull request: [${prTitle}](${prUrl}).

Please review my changes there.`;

      await addCommentToIssue(repository, issue.number, token, issueMessage);
    }
  }
}
