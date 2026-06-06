import { Octokit } from "@octokit/rest";

export function makeOctokit(token: string) {
  return new Octokit({ auth: token });
}

export async function fetchIssues(token: string, owner: string, repo: string) {
  const octokit = makeOctokit(token);
  const { data } = await octokit.issues.listForRepo({
    owner,
    repo,
    state: "open",
    per_page: 100,
  });
  return data.map((issue) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    state: issue.state,
    labels: issue.labels.map((l) => (typeof l === "string" ? l : l.name ?? "")),
    assignee: issue.assignee?.login,
    url: issue.html_url,
  }));
}

export async function createRepo(
  token: string,
  name: string,
  description: string,
  isPrivate: boolean
) {
  const octokit = makeOctokit(token);
  let data;
  try {
    ({ data } = await octokit.repos.createForAuthenticatedUser({
      name,
      description: description || undefined,
      private: isPrivate,
      auto_init: true, // seed an initial commit + default branch so the repo is cloneable
    }));
  } catch (err: unknown) {
    // GitHub returns 422 with field "name" / "already exists" when a repo of the
    // same name is already on the account. Surface a clear, actionable message.
    const nameTaken =
      typeof err === "object" &&
      err !== null &&
      "status" in err &&
      (err as { status?: number }).status === 422 &&
      /already exists/i.test((err as { message?: string }).message ?? "");
    if (nameTaken) {
      throw new Error(
        `A repository named "${name}" already exists on your GitHub account. Choose a different project name.`
      );
    }
    throw err;
  }
  return {
    fullName: data.full_name,
    defaultBranch: data.default_branch,
    htmlUrl: data.html_url,
  };
}

export async function getRepoInfo(token: string, owner: string, repo: string) {
  const octokit = makeOctokit(token);
  const { data } = await octokit.repos.get({ owner, repo });
  return { defaultBranch: data.default_branch, description: data.description };
}

export async function fetchUserRepos(token: string) {
  const octokit = makeOctokit(token);
  const repos: { fullName: string; defaultBranch: string; private: boolean; description: string | null }[] = [];
  for await (const response of octokit.paginate.iterator(octokit.repos.listForAuthenticatedUser, {
    sort: "pushed",
    per_page: 100,
  })) {
    for (const r of response.data) {
      repos.push({
        fullName: r.full_name,
        defaultBranch: r.default_branch,
        private: r.private,
        description: r.description ?? null,
      });
    }
    if (repos.length >= 200) break;
  }
  return repos;
}
