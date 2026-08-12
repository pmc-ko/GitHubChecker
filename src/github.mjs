// GitHub GraphQL API クライアント。
// 「1リポジトリのオープンPR + 最新コミットのチェック結果 + レビュー」を1クエリで取る。
// Issue とマイルストンは別クエリ（ISSUE_QUERY）で1リポジトリ1回だけ取る。
// 取得したい項目を増やしたいときは PR_QUERY / ISSUE_QUERY の GraphQL を編集し、
// 整形は src/summarize.mjs 側で行う（このファイルは通信と生データの責務だけ）。
//
// ★ GraphQL のレート制限（5000点/時）は「要求したノード数」で決まる。
//   ネストした connection の first を増やすと掛け算で効くので、安易に増やさないこと。
//   目安: pullRequests(first:N) × (labels + reviewRequests + latestReviews + contexts + …) / 100 点。
//   1回の取得コストは画面のフッタに「今回 n点」として出る。

const ENDPOINT = 'https://api.github.com/graphql';

const PR_QUERY = /* GraphQL */ `
  query PullRequests($owner: String!, $name: String!, $first: Int!, $cursor: String) {
    viewer {
      login
    }
    rateLimit {
      cost
      remaining
      limit
      resetAt
    }
    repository(owner: $owner, name: $name) {
      nameWithOwner
      url
      pullRequests(
        states: OPEN
        first: $first
        after: $cursor
        orderBy: { field: UPDATED_AT, direction: DESC }
      ) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          number
          title
          url
          isDraft
          createdAt
          updatedAt
          additions
          deletions
          changedFiles
          mergeable
          baseRefName
          headRefName
          author {
            login
            avatarUrl(size: 48)
          }
          labels(first: 10) {
            nodes {
              name
              color
            }
          }
          milestone {
            title
            url
            dueOn
            progressPercentage
          }
          # この PR がクローズする Issue（「Fixes #123」等で紐づいたもの）
          closingIssuesReferences(first: 5) {
            totalCount
            nodes {
              number
              title
              url
              state
              repository {
                nameWithOwner
              }
              milestone {
                title
                url
              }
            }
          }
          comments {
            totalCount
          }
          reviewDecision
          reviewRequests(first: 10) {
            nodes {
              requestedReviewer {
                __typename
                ... on User {
                  login
                  avatarUrl(size: 48)
                }
                ... on Bot {
                  login
                  avatarUrl(size: 48)
                }
                ... on Mannequin {
                  login
                  avatarUrl(size: 48)
                }
                ... on Team {
                  name
                }
              }
            }
          }
          latestReviews(first: 15) {
            nodes {
              state
              submittedAt
              url
              author {
                login
                avatarUrl(size: 48)
              }
            }
          }
          commits(last: 1) {
            nodes {
              commit {
                oid
                committedDate
                messageHeadline
                statusCheckRollup {
                  state
                  contexts(first: 50) {
                    totalCount
                    nodes {
                      __typename
                      ... on CheckRun {
                        name
                        status
                        conclusion
                        detailsUrl
                        startedAt
                        completedAt
                        checkSuite {
                          workflowRun {
                            event
                            url
                            workflow {
                              name
                            }
                          }
                        }
                      }
                      ... on StatusContext {
                        context
                        state
                        description
                        targetUrl
                        createdAt
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

// Issue とマイルストン。PR 側は closingIssuesReferences で Issue に紐づくので、
// ここでは「Issue の一覧」と「マイルストンの進捗（クローズ済みを含む件数）」を取る。
const ISSUE_QUERY = /* GraphQL */ `
  query Issues($owner: String!, $name: String!, $first: Int!, $milestones: Int!) {
    rateLimit {
      cost
      remaining
      limit
      resetAt
    }
    repository(owner: $owner, name: $name) {
      nameWithOwner
      url
      issues(states: OPEN, first: $first, orderBy: { field: UPDATED_AT, direction: DESC }) {
        totalCount
        nodes {
          number
          title
          url
          state
          createdAt
          updatedAt
          author {
            login
            avatarUrl(size: 48)
          }
          assignees(first: 5) {
            nodes {
              login
              avatarUrl(size: 48)
            }
          }
          labels(first: 10) {
            nodes {
              name
              color
            }
          }
          milestone {
            title
            url
            dueOn
            progressPercentage
          }
          comments {
            totalCount
          }
        }
      }
      milestones(states: OPEN, first: $milestones, orderBy: { field: DUE_DATE, direction: ASC }) {
        nodes {
          title
          url
          dueOn
          progressPercentage
          openIssues: issues(states: OPEN) {
            totalCount
          }
          closedIssues: issues(states: CLOSED) {
            totalCount
          }
          openPullRequests: pullRequests(states: OPEN) {
            totalCount
          }
        }
      }
    }
  }
`;

export async function graphql(token, query, variables) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
      'User-Agent': 'github-pr-checker',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (response.status === 401) {
    throw new Error('GitHub の認証に失敗しました (401)。`gh auth login` でログインし直してください。');
  }

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`GitHub API の応答を解釈できませんでした (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }

  if (payload.errors?.length) {
    // NOT_FOUND などは呼び出し側で扱えるように type を残す
    const error = new Error(payload.errors.map((e) => e.message).join(' / '));
    error.graphqlErrors = payload.errors;
    throw error;
  }
  if (!response.ok) {
    throw new Error(`GitHub API がエラーを返しました (HTTP ${response.status})`);
  }

  return payload.data;
}

/**
 * 1リポジトリのオープンPRを（必要ならページングして）全部取る。
 * @returns {{ repository: object, pullRequests: object[], viewer: string, rateLimit: object }}
 */
export async function fetchRepoPullRequests(token, repo, { maxPrs = 100 } = {}) {
  const pullRequests = [];
  let cursor = null;
  let repository = null;
  let viewer = null;
  let rateLimit = null;
  let totalCount = 0;

  while (pullRequests.length < maxPrs) {
    // 1ページ25件。first を増やすとレート制限のコストが比例して増える（先頭のコメント参照）
    const first = Math.min(25, maxPrs - pullRequests.length);
    const data = await graphql(token, PR_QUERY, {
      owner: repo.owner,
      name: repo.name,
      first,
      cursor,
    });

    viewer = data.viewer?.login ?? viewer;
    rateLimit = data.rateLimit ?? rateLimit;
    if (!data.repository) {
      throw new Error(`リポジトリ ${repo.nameWithOwner} が見つかりません（権限不足の可能性があります）`);
    }
    repository = { nameWithOwner: data.repository.nameWithOwner, url: data.repository.url };
    totalCount = data.repository.pullRequests.totalCount;

    pullRequests.push(...data.repository.pullRequests.nodes);

    const pageInfo = data.repository.pullRequests.pageInfo;
    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }

  return { repository, pullRequests, totalCount, viewer, rateLimit };
}

/**
 * 1リポジトリのオープン Issue とオープンなマイルストンを取る（ページングしない）。
 * @returns {{ issues: object[], issueTotalCount: number, milestones: object[], rateLimit: object }}
 */
export async function fetchRepoIssues(token, repo, { maxIssues = 100, maxMilestones = 20 } = {}) {
  const data = await graphql(token, ISSUE_QUERY, {
    owner: repo.owner,
    name: repo.name,
    first: Math.min(100, maxIssues),
    milestones: maxMilestones,
  });

  if (!data.repository) {
    throw new Error(`リポジトリ ${repo.nameWithOwner} が見つかりません（権限不足の可能性があります）`);
  }

  return {
    issues: data.repository.issues?.nodes ?? [],
    issueTotalCount: data.repository.issues?.totalCount ?? 0,
    milestones: data.repository.milestones?.nodes ?? [],
    rateLimit: data.rateLimit ?? null,
  };
}
